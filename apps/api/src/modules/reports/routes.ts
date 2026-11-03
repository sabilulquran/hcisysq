// RPT-001 Package 1 routes: HR reports (employee list, leave, overtime, business travel and
// training recaps), paged on screen and exported as CSV or XLSX.
// Spec: docs/domain/hr-reports.md.
//
// reports.* is read from the report roles' own assignments, organization- or unit-scoped (D-02),
// not from the organization-only authorization context every other guard uses. Legacy Super Admin
// compatibility never carries it (D-13). The scope predicate sits in the WHERE clause of both the
// count and the page query, before any LIMIT (ENG-LIST-001), and an export is never wider than
// what the account may read.

import { randomUUID } from "node:crypto";

import ExcelJS from "exceljs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import type { ReportPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import { jakartaDate } from "../documents/service.js";
import {
  EMPLOYEE_STATUS_LABELS,
  EXPORT_BATCH_SIZE,
  EXPORT_ROW_LIMIT,
  exportFileName,
  HR_REPORTS,
  intersectScopes,
  isCalendarDate,
  isEmptyScope,
  MAX_PERIOD_DAYS,
  NO_SCOPE,
  PERIOD_MESSAGES,
  periodError,
  REPORT_DEFINITIONS,
  REPORTED_TRIP_STATUSES,
  reportCsv,
  sameScope,
  scopeAllowsUnit,
  scopeFromAssignments,
  TRIP_STATUS_LABELS,
  type HrReport,
  type ReportCell,
  type ReportScope,
} from "./domain.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type Row = Record<string, ReportCell>;

const isoDate = z.string().refine(isCalendarDate);
const reportParams = z.object({ report: z.enum(HR_REPORTS) });
const filterShape = {
  unitId: z.string().uuid().optional(),
  status: z.enum(["active", "inactive", "resigned", "all"]).default("active"),
  employmentType: z.string().trim().min(1).max(100).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
};
const viewQuery = pageQuerySchema.extend({ ...filterShape, q: z.string().trim().max(100).optional() });
// D-12: an export takes structured filters only. strict() refuses q, so free text (a name) can
// never reach the audit payload or be left out of it.
const exportQuery = z.object({ ...filterShape, format: z.enum(["csv", "xlsx"]) }).strict();

interface Filters {
  unitId?: string | undefined;
  status: "active" | "inactive" | "resigned" | "all";
  employmentType?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
}

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

/** D-02: the assignments that carry this permission today, for an active employee account. */
export async function resolveReportScope(
  db: Queryable, principal: AuthPrincipal, permission: ReportPermission,
): Promise<ReportScope> {
  if (principal.principalType !== "EMPLOYEE") return NO_SCOPE;
  const result = await db.query<{ scopeType: string; unitId: string | null }>(
    `SELECT assignment.scope_type AS "scopeType", assignment.organizational_unit_id AS "unitId"
       FROM account_role_assignments assignment
       JOIN role_permissions role_permission ON role_permission.role_id = assignment.role_id
       JOIN accounts principal_account ON principal_account.id = assignment.account_id
       JOIN employees principal_employee ON principal_employee.id = principal_account.employee_id
      WHERE assignment.account_id = $1
        AND role_permission.permission_key = $2
        AND principal_account.principal_type = 'EMPLOYEE'
        AND principal_account.status = 'active' AND principal_employee.status = 'active'
        AND ((assignment.scope_type = 'organization' AND assignment.organizational_unit_id IS NULL)
          OR (assignment.scope_type = 'unit' AND assignment.organizational_unit_id IS NOT NULL))
        AND (assignment.starts_on IS NULL OR assignment.starts_on <= current_date)
        AND (assignment.ends_on IS NULL OR assignment.ends_on >= current_date)`,
    [principal.id, permission],
  );
  return scopeFromAssignments(result.rows);
}

// ------------------------------------------------------------------------------------ queries

interface BuiltQuery {
  /** Rows without ORDER BY, so the count can wrap it. */
  sql: string;
  orderBy: string;
  values: unknown[];
}

/**
 * One query per report (§6). Every value is a bind parameter; the only interpolated text is
 * fixed SQL chosen by the closed report enum. `base` is the population and scope (D-02, D-03).
 */
export function buildReportQuery(report: HrReport, filters: Filters, scope: ReportScope): BuiltQuery {
  const values: unknown[] = [];
  const p = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const unit = p(filters.unitId ?? null);
  // LIKE wildcards in the search are matched literally (backslash is PostgreSQL's default escape).
  const search = p(filters.q ? `%${filters.q.replace(/[\\%_]/g, "\\$&")}%` : null);
  const base = `employee.management_scope = 'MANAGED' AND employee.removed_at IS NULL
    AND (${p(scope.organization)}::boolean OR employee.organizational_unit_id = ANY(${p(scope.unitIds)}::uuid[]))
    AND (${unit}::uuid IS NULL OR employee.organizational_unit_id = ${unit})
    AND (${search}::text IS NULL OR employee.full_name ILIKE ${search} OR employee.employee_number ILIKE ${search})`;
  const identity = `employee.employee_number AS "employeeNumber", employee.full_name AS "fullName", unit.name AS "unitName"`;
  const unitJoin = "LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id";
  const byEmployee = "ORDER BY employee.full_name ASC, employee.employee_number ASC, employee.id ASC";

  if (report === "employees") {
    const status = p(filters.status === "all" ? null : filters.status);
    const type = p(filters.employmentType ?? null);
    return {
      sql: `SELECT employee.id AS "rowId", ${identity}, position.name AS "positionName",
                   employee.employment_type AS "employmentType", employee.employment_status AS "employmentStatus",
                   employee.status, to_char(employee.started_on, 'YYYY-MM-DD') AS "startedOn",
                   to_char(employee.ended_on, 'YYYY-MM-DD') AS "endedOn"
              FROM employees employee
              ${unitJoin}
              LEFT JOIN positions position ON position.id = employee.position_id
             WHERE ${base}
               AND (${status}::text IS NULL OR employee.status = ${status})
               AND (${type}::text IS NULL OR employee.employment_type = ${type})`,
      orderBy: byEmployee,
      values,
    };
  }

  const from = `${p(filters.from)}::date`;
  const to = `${p(filters.to)}::date`;

  if (report === "leave") {
    // D-05: health and religious leave types are not itemised. D-06: counted whole in the period
    // of the start date. D-10: every active employee appears, also with zero.
    const inPeriod = (alias: string) =>
      `${alias}.status IN ('approved', 'in_review') AND ${alias}.start_on BETWEEN ${from} AND ${to}`;
    return {
      sql: `SELECT employee.id AS "rowId", ${identity},
                   COALESCE(sum(request.working_days) FILTER (WHERE request.status = 'approved' AND request.policy_key = 'annual'), 0)::int AS "annualDays",
                   COALESCE(sum(request.working_days) FILTER (WHERE request.status = 'approved' AND request.policy_key = 'unpaid'), 0)::int AS "unpaidDays",
                   COALESCE(sum(request.working_days) FILTER (WHERE request.status = 'approved' AND request.policy_key NOT IN ('annual', 'unpaid')), 0)::int AS "otherDays",
                   COALESCE(sum(request.working_days) FILTER (WHERE request.status = 'approved'), 0)::int AS "totalDays",
                   count(request.id) FILTER (WHERE request.status = 'approved')::int AS "approvedCount",
                   count(request.id) FILTER (WHERE request.status = 'in_review')::int AS "pendingCount"
              FROM employees employee
              ${unitJoin}
              LEFT JOIN leave_requests request ON request.employee_id = employee.id AND ${inPeriod("request")}
             WHERE ${base}
               AND (employee.status = 'active' OR EXISTS (
                 SELECT 1 FROM leave_requests counted WHERE counted.employee_id = employee.id AND ${inPeriod("counted")}))
             GROUP BY employee.id, unit.name`,
      orderBy: byEmployee,
      values,
    };
  }

  if (report === "overtime") {
    // D-07: by work date; only employees with an overtime request in the period.
    return {
      sql: `SELECT employee.id AS "rowId", ${identity},
                   count(overtime.id) FILTER (WHERE overtime.status = 'approved')::int AS "approvedCount",
                   round(COALESCE(sum(overtime.approved_minutes) FILTER (WHERE overtime.status = 'approved'), 0) / 60.0, 2)::float8 AS "approvedHours",
                   count(overtime.id) FILTER (WHERE overtime.status = 'submitted')::int AS "pendingCount"
              FROM employees employee
              JOIN attendance_overtime_requests overtime
                ON overtime.employee_id = employee.id AND overtime.status IN ('approved', 'submitted')
               AND overtime.work_date BETWEEN ${from} AND ${to}
              ${unitJoin}
             WHERE ${base}
             GROUP BY employee.id, unit.name`,
      orderBy: byEmployee,
      values,
    };
  }

  if (report === "trips") {
    // D-08: one row per approved trip starting in the period; purpose and report text stay out.
    const statuses = p([...REPORTED_TRIP_STATUSES]);
    return {
      sql: `SELECT trip.id AS "rowId", ${identity}, trip.destination,
                   to_char(trip.start_on, 'YYYY-MM-DD') AS "startOn", to_char(trip.end_on, 'YYYY-MM-DD') AS "endOn",
                   (trip.end_on - trip.start_on + 1)::int AS days, trip.status
              FROM business_trip_requests trip
              JOIN employees employee ON employee.id = trip.employee_id
              ${unitJoin}
             WHERE ${base}
               AND trip.status = ANY(${statuses}::text[])
               AND trip.start_on BETWEEN ${from} AND ${to}`,
      orderBy: "ORDER BY employee.full_name ASC, employee.employee_number ASC, trip.start_on ASC, trip.id ASC",
      values,
    };
  }

  // training — D-09: verified records ending in the period; every active employee appears.
  const verified = (alias: string) => `${alias}.status = 'VERIFIED' AND ${alias}.end_on BETWEEN ${from} AND ${to}`;
  return {
    sql: `SELECT employee.id AS "rowId", ${identity},
                 COALESCE(sum(record.hours) FILTER (WHERE record.role = 'PARTICIPANT' AND record.source = 'INTERNAL'), 0)::float8 AS "internalHours",
                 COALESCE(sum(record.hours) FILTER (WHERE record.role = 'PARTICIPANT' AND record.source = 'EXTERNAL'), 0)::float8 AS "externalHours",
                 COALESCE(sum(record.hours) FILTER (WHERE record.role = 'PARTICIPANT'), 0)::float8 AS "totalHours",
                 COALESCE(sum(record.hours) FILTER (WHERE record.role = 'SPEAKER'), 0)::float8 AS "speakerHours",
                 count(record.id) FILTER (WHERE record.role = 'PARTICIPANT')::int AS "recordCount"
            FROM employees employee
            ${unitJoin}
            LEFT JOIN training_records record ON record.employee_id = employee.id AND ${verified("record")}
           WHERE ${base}
             AND (employee.status = 'active' OR EXISTS (
               SELECT 1 FROM training_records counted WHERE counted.employee_id = employee.id AND ${verified("counted")}))
           GROUP BY employee.id, unit.name`,
    orderBy: byEmployee,
    values,
  };
}

/** Wraps the row query for its total; the scope is inside, so the total counts the scope only. */
async function countRows(db: Queryable, query: BuiltQuery): Promise<number> {
  const result = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM (${query.sql}) report`, query.values);
  return result.rows[0]?.total ?? 0;
}

async function pageRows(db: Queryable, query: BuiltQuery, limit: number, offset: number): Promise<Row[]> {
  const at = query.values.length;
  const result = await db.query<Row>(
    `${query.sql} ${query.orderBy} LIMIT $${at + 1} OFFSET $${at + 2}`,
    [...query.values, limit, offset],
  );
  return result.rows.map(presentRow);
}

/** Display labels, and nothing the screen or the file does not show. */
function presentRow(row: Row): Row {
  const rest = { ...row };
  if (typeof rest.status === "string") {
    const status = rest.status;
    delete rest.status;
    rest.statusLabel = EMPLOYEE_STATUS_LABELS[status] ?? TRIP_STATUS_LABELS[status] ?? status;
  }
  return rest;
}

/** The structured filters a report actually uses: what the audit records (D-12). */
function appliedFilters(report: HrReport, filters: Filters) {
  if (report === "employees") {
    return { unitId: filters.unitId ?? null, status: filters.status, employmentType: filters.employmentType ?? null };
  }
  return { unitId: filters.unitId ?? null, from: filters.from ?? null, to: filters.to ?? null };
}

/** D-14: the employment types present in a scope; an export accepts only one of these (D-12). */
async function employmentTypes(db: Queryable, scope: ReportScope): Promise<string[]> {
  const result = await db.query<{ value: string }>(
    `SELECT DISTINCT employee.employment_type AS value
       FROM employees employee
      WHERE employee.management_scope = 'MANAGED' AND employee.removed_at IS NULL
        AND employee.employment_type IS NOT NULL AND btrim(employee.employment_type) <> ''
        AND ($1::boolean OR employee.organizational_unit_id = ANY($2::uuid[]))
      ORDER BY 1`,
    [scope.organization, scope.unitIds],
  );
  return result.rows.map((row) => row.value);
}

async function unitOptions(db: Queryable, scope: ReportScope) {
  const result = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM organizational_units
      WHERE $1::boolean OR id = ANY($2::uuid[])
      ORDER BY name ASC, id ASC`,
    [scope.organization, scope.unitIds],
  );
  return result.rows;
}

function scopeLabel(scope: ReportScope, units: Array<{ id: string; name: string }>, unitId?: string) {
  if (unitId) return `Unit: ${units.find((unit) => unit.id === unitId)?.name ?? "-"}`;
  if (scope.organization) return "Seluruh organisasi";
  return `Unit: ${units.map((unit) => unit.name).join(", ")}`;
}

function longDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}T00:00:00Z`));
}

function stamp(value: Date) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta",
  }).format(value);
}

async function reportXlsx(report: HrReport, rows: Row[], header: string[]): Promise<Buffer> {
  const definition = REPORT_DEFINITIONS[report];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(definition.title.slice(0, 31), {
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  sheet.addRow([definition.title]).font = { bold: true, size: 14 };
  for (const line of header) sheet.addRow([line]);
  sheet.addRow([]);
  const headerRow = sheet.addRow(definition.columns.map((column) => column.label));
  headerRow.font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: headerRow.number }];
  // Cells are written as values, never as formulas, so exported text is not evaluated.
  for (const row of rows) sheet.addRow(definition.columns.map((column) => row[column.key] ?? null));
  definition.columns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.kind === "text" ? 24 : 14;
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// ------------------------------------------------------------------------------------ routes

export async function registerReportRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession">,
) {
  const encryptionKey = config.AUTH_ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error("AUTH_ENCRYPTION_KEY is required for report routes");
  const auth = injectedAuth ?? new AuthService(
    pool, encryptionKey, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production",
  );

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    return session.principal;
  }

  const forbidden = (reply: FastifyReply, message = "Akun ini tidak memiliki peran laporan.") =>
    send(reply, 403, { code: "FORBIDDEN", message });
  const outOfScope = (reply: FastifyReply) =>
    send(reply, 403, { code: "REPORT_SCOPE_FORBIDDEN", message: "Unit ini di luar cakupan laporan akun Anda." });
  const invalid = (reply: FastifyReply, message = "Filter laporan tidak valid.") =>
    send(reply, 400, { code: "INVALID_REPORT_QUERY", message });

  /** 404 for an unknown report, 400 for a bad period; null when the request can go ahead. */
  function checkRequest(request: FastifyRequest, reply: FastifyReply, filters: Filters): HrReport | null {
    const params = reportParams.safeParse(request.params);
    if (!params.success) {
      void send(reply, 404, { code: "REPORT_NOT_FOUND", message: "Laporan tidak dikenal." });
      return null;
    }
    if (REPORT_DEFINITIONS[params.data.report].period) {
      const error = periodError(filters.from, filters.to);
      if (error) { void invalid(reply, PERIOD_MESSAGES[error]); return null; }
    }
    return params.data.report;
  }

  app.get("/admin/reports/hr/access", async (request, reply) => {
    const principal = await authenticate(request, reply);
    if (!principal) return;
    const read = await resolveReportScope(pool, principal, "reports.read.organization");
    if (isEmptyScope(read)) return forbidden(reply);
    const exportScope = intersectScopes(read, await resolveReportScope(pool, principal, "reports.export.organization"));
    const units = await unitOptions(pool, read);
    return send(reply, 200, {
      scope: { type: read.organization ? "organization" : "unit", units: read.organization ? [] : units },
      canExport: !isEmptyScope(exportScope),
      exportScope: isEmptyScope(exportScope) ? null : {
        type: exportScope.organization ? "organization" : "unit",
        unitIds: exportScope.unitIds,
      },
      reports: HR_REPORTS.map((key) => ({ key, ...REPORT_DEFINITIONS[key] })),
      filters: { units, employmentTypes: await employmentTypes(pool, read) },
      limits: { maxPeriodDays: MAX_PERIOD_DAYS, exportRowLimit: EXPORT_ROW_LIMIT },
    });
  });

  app.get("/admin/reports/hr/:report", async (request, reply) => {
    const principal = await authenticate(request, reply);
    if (!principal) return;
    const scope = await resolveReportScope(pool, principal, "reports.read.organization");
    if (isEmptyScope(scope)) return forbidden(reply);
    const query = viewQuery.safeParse(request.query);
    if (!query.success) return invalid(reply);
    const report = checkRequest(request, reply, query.data);
    if (!report) return;
    if (query.data.unitId && !scopeAllowsUnit(scope, query.data.unitId)) return outOfScope(reply);
    const built = buildReportQuery(report, query.data, scope);
    const [total, items] = await Promise.all([
      countRows(pool, built),
      pageRows(pool, built, query.data.pageSize, pageOffset(query.data)),
    ]);
    return send(reply, 200, {
      report,
      title: REPORT_DEFINITIONS[report].title,
      columns: REPORT_DEFINITIONS[report].columns,
      items,
      pagination: pagination(query.data, total),
    });
  });

  app.get("/admin/reports/hr/:report/export", async (request, reply) => {
    const principal = await authenticate(request, reply);
    if (!principal) return;
    const read = await resolveReportScope(pool, principal, "reports.read.organization");
    if (isEmptyScope(read)) return forbidden(reply);
    const scope = intersectScopes(read, await resolveReportScope(pool, principal, "reports.export.organization"));
    if (isEmptyScope(scope)) return forbidden(reply, "Akun ini hanya dapat melihat laporan, tidak mengunduh.");
    const query = exportQuery.safeParse(request.query);
    if (!query.success) return invalid(reply);
    const report = checkRequest(request, reply, query.data);
    if (!report) return;
    if (query.data.unitId && !scopeAllowsUnit(scope, query.data.unitId)) return outOfScope(reply);
    // §4: a file is never silently narrower than the screen. When the account may export fewer
    // units than it may read, it names one of them.
    if (!query.data.unitId && !sameScope(read, scope)) {
      return send(reply, 403, {
        code: "REPORT_EXPORT_UNIT_REQUIRED",
        message: "Unduhan akun Anda hanya untuk sebagian unit. Pilih salah satu unit tersebut lebih dulu.",
      });
    }
    // D-12: only a value the screen offers reaches the audit and the file header.
    if (report === "employees" && query.data.employmentType
      && !(await employmentTypes(pool, scope)).includes(query.data.employmentType)) {
      return invalid(reply, "Jenis kepegawaian tidak dikenal.");
    }

    // D-11: count and every page come from one snapshot, read 1,000 rows at a time; above the
    // limit nothing is sent, so a file is never silently short.
    const built = buildReportQuery(report, query.data, scope);
    const rows: Row[] = [];
    const client = await pool.connect();
    let total = 0;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      total = await countRows(client, built);
      if (total <= EXPORT_ROW_LIMIT) {
        for (let offset = 0; offset < total; offset += EXPORT_BATCH_SIZE) {
          rows.push(...await pageRows(client, built, EXPORT_BATCH_SIZE, offset));
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (total > EXPORT_ROW_LIMIT) {
      return send(reply, 422, {
        code: "EXPORT_TOO_LARGE",
        message: `Laporan berisi ${total} baris, melebihi batas ${EXPORT_ROW_LIMIT}. Persempit unit atau periode.`,
      });
    }

    // D-12: audited before anything is sent; if this fails, no file leaves the server.
    await pool.query(
      `INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload)
       VALUES ($1, $2, 'reports.hr.exported', 'hr_report', NULL, $3::jsonb)`,
      [randomUUID(), principal.id, JSON.stringify({
        report,
        format: query.data.format,
        filters: appliedFilters(report, query.data),
        scope: scope.organization ? "organization" : "unit",
        unitCount: scope.organization ? null : scope.unitIds.length,
        rows: rows.length,
      })],
    );

    const today = jakartaDate(new Date());
    const fileName = exportFileName(report, today, query.data.format);
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Disposition", `attachment; filename="${fileName}"`);
    if (query.data.format === "csv") {
      reply.header("Content-Type", "text/csv; charset=utf-8");
      return reply.send(reportCsv(REPORT_DEFINITIONS[report].columns, rows));
    }
    const units = await unitOptions(pool, scope);
    const header = [
      scopeLabel(scope, units, query.data.unitId),
      REPORT_DEFINITIONS[report].period
        ? `Periode ${longDate(query.data.from!)} – ${longDate(query.data.to!)}`
        : `Status: ${query.data.status === "all" ? "Semua" : EMPLOYEE_STATUS_LABELS[query.data.status]}`
          + (query.data.employmentType ? ` · Jenis kepegawaian: ${query.data.employmentType}` : ""),
      `${rows.length} baris · Diunduh ${stamp(new Date())} WIB oleh ${principal.email}`,
    ];
    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    return reply.send(await reportXlsx(report, rows, header));
  });
}
