// ORG-012 Package 1 routes.
// Spec: docs/domain/committees.md.
//
// committees.* is HC-only: legacy Super Admin compatibility never grants it, so the admin
// routes resolve it from the organization context. "Kepanitiaan Saya" needs only an EMPLOYEE
// session linked to an active employee; access there is membership, not permission (D-15).
// Nothing here writes to organization_*, employment_* or approval tables (§2).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import type { CommitteePermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import { DocumentError, issueDocument, jakartaDate, loadEmployeeFacts, writeDocumentAudit } from "../documents/service.js";
import { normalizeWhatsAppNumber } from "../meetings/whatsapp.js";
import { notifyEmployee } from "../notifications/service.js";
import {
  activateInput,
  activationProblems,
  assertFreshVersion,
  assertOpen,
  assertStatus,
  cancelInput,
  COMMITTEE_CATEGORIES,
  COMMITTEE_DOCUMENT_CODE,
  COMMITTEE_NUMBER_CODE,
  COMMITTEE_ROLES,
  COMMITTEE_STATUSES,
  CommitteeError,
  committeeEdit,
  committeeInput,
  CORE_ROLES,
  joinDate,
  leaveDate,
  likePattern,
  lockedFieldChanges,
  MAX_ACTIVE_MEMBERS,
  memberAdd,
  memberEdit,
  memberEnd,
  ROLE_LABELS,
  text,
  versionInput,
  yearRange,
  type CommitteeRole,
  type CommitteeStatus,
} from "./domain.js";

type Db = Pick<PoolClient, "query">;

// An empty search box sends `q=`; that means "no search", not a too-short query.
const optionalQuery = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  text().pipe(z.string().min(2).max(100)).optional(),
);
const year = z.coerce.number().int().min(2000).max(2100);
const adminListQuery = pageQuerySchema.extend({
  status: z.enum(COMMITTEE_STATUSES).optional(),
  category: z.enum(COMMITTEE_CATEGORIES).optional(),
  year: year.optional(),
  q: optionalQuery,
});
const participationQuery = pageQuerySchema.extend({ year: year.optional(), q: optionalQuery });
const employeeParticipationQuery = pageQuerySchema.extend({ year: year.optional() });
const myListQuery = pageQuerySchema.extend({ scope: z.enum(["current", "history"]).default("current") });
const optionsQuery = z.object({ q: text().pipe(z.string().min(2).max(100)) });
const idParams = z.object({ id: z.string().uuid() });
const memberParams = z.object({ id: z.string().uuid(), memberId: z.string().uuid() });
const employeeParams = z.object({ employeeId: z.string().uuid() });

/** D-15: a member sees a committee once it has been activated, cancelled or not. */
const VISIBLE_TO_MEMBERS = "(committee.status IN ('ACTIVE', 'COMPLETED') OR (committee.status = 'CANCELLED' AND committee.activated_at IS NOT NULL))";

const COMMITTEE_COLUMNS = `
  committee.id, committee.name, committee.category, committee.description, committee.organizer,
  to_char(committee.start_on, 'YYYY-MM-DD') AS "startOn", to_char(committee.end_on, 'YYYY-MM-DD') AS "endOn",
  committee.status, committee.activated_at AS "activatedAt", committee.completed_at AS "completedAt",
  committee.cancelled_at AS "cancelledAt", committee.cancel_reason AS "cancelReason"`;
const DECREE_COLUMNS = `
  committee.decree_mode AS "decreeMode",
  coalesce(document.document_number, committee.external_decree_number) AS "decreeNumber",
  coalesce(to_char(document.issued_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD'),
           to_char(committee.external_decree_date, 'YYYY-MM-DD')) AS "decreeDate",
  document.status AS "decreeStatus", document.signer AS "decreeSigner",
  document.content_snapshot AS "decreeSnapshot"`;
const DECREE_JOIN = "LEFT JOIN hr_issued_documents document ON document.id = committee.issued_document_id";

interface CommitteeLock {
  status: CommitteeStatus;
  version: number;
  name: string;
  category: string;
  description: string | null;
  organizer: string | null;
  startOn: string;
  endOn: string;
  issuedDocumentId: string | null;
  decreeNumber: string | null;
}

interface MemberRow {
  id: string;
  employeeId: string;
  fullName: string;
  role: CommitteeRole;
  section: string | null;
  joinedOn: string;
}

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

const today = () => jakartaDate(new Date());
const currentYear = () => Number(today().slice(0, 4));

async function writeCommitteeAudit(
  db: Db,
  event: {
    eventType: string;
    committeeId: string;
    employeeId?: string | null;
    actorAccountId: string;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await db.query(
    // clock_timestamp, not now(): a chair transfer writes two events in one transaction, and the
    // history must keep their order.
    `INSERT INTO committee_audit_events (id, event_type, committee_id, employee_id, actor_account_id, reason, metadata, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb, clock_timestamp())`,
    [
      randomUUID(), event.eventType, event.committeeId, event.employeeId ?? null, event.actorAccountId,
      event.reason ?? null, JSON.stringify(event.metadata ?? {}),
    ],
  );
}

async function lockCommittee(db: Db, id: string): Promise<CommitteeLock> {
  const found = await db.query<CommitteeLock>(
    `SELECT committee.status, committee.version, committee.name, committee.category, committee.description,
            committee.organizer,
            to_char(committee.start_on, 'YYYY-MM-DD') AS "startOn", to_char(committee.end_on, 'YYYY-MM-DD') AS "endOn",
            committee.issued_document_id AS "issuedDocumentId",
            coalesce(document.document_number, committee.external_decree_number) AS "decreeNumber"
       FROM committees committee
       ${DECREE_JOIN}
      WHERE committee.id = $1
      FOR UPDATE OF committee`,
    [id],
  );
  if (!found.rows[0]) throw new CommitteeError(404, "COMMITTEE_NOT_FOUND", "Kepanitiaan tidak ditemukan.");
  return found.rows[0];
}

async function bumpVersion(db: Db, id: string, actorAccountId: string): Promise<number> {
  const result = await db.query<{ version: number }>(
    `UPDATE committees SET version = version + 1, updated_by_account_id = $2, updated_at = now()
      WHERE id = $1 RETURNING version`,
    [id, actorAccountId],
  );
  return result.rows[0]!.version;
}

async function loadOpenMember(db: Db, committeeId: string, memberId: string): Promise<MemberRow> {
  const found = await db.query<MemberRow>(
    `SELECT member.id, member.employee_id AS "employeeId", employee.full_name AS "fullName", member.role,
            member.section, to_char(member.joined_on, 'YYYY-MM-DD') AS "joinedOn"
       FROM committee_members member
       JOIN employees employee ON employee.id = member.employee_id
      WHERE member.id = $1 AND member.committee_id = $2 AND member.left_on IS NULL
      FOR UPDATE OF member`,
    [memberId, committeeId],
  );
  if (!found.rows[0]) throw new CommitteeError(404, "COMMITTEE_MEMBER_NOT_FOUND", "Anggota panitia tidak ditemukan.");
  return found.rows[0];
}

/** §5.3: a new chair demotes the current one to MEMBER in the same transaction (D-05). */
async function demoteCurrentChair(db: Db, committeeId: string, exceptMemberId: string | null, actorAccountId: string) {
  const demoted = await db.query<{ id: string; employeeId: string; fullName: string }>(
    `UPDATE committee_members member SET role = 'MEMBER', updated_at = now()
       FROM employees employee
      WHERE member.committee_id = $1 AND member.role = 'CHAIR' AND member.left_on IS NULL
        AND ($2::uuid IS NULL OR member.id <> $2) AND employee.id = member.employee_id
      RETURNING member.id, member.employee_id AS "employeeId", employee.full_name AS "fullName"`,
    [committeeId, exceptMemberId],
  );
  for (const row of demoted.rows) {
    await writeCommitteeAudit(db, {
      eventType: "committee.member.updated",
      committeeId,
      employeeId: row.employeeId,
      actorAccountId,
      metadata: { memberId: row.id, name: row.fullName, before: { role: "CHAIR" }, after: { role: "MEMBER" }, reason: "chair-transfer" },
    });
  }
  return demoted.rows;
}

async function assertActiveEmployee(db: Db, employeeId: string) {
  const found = await db.query<{ fullName: string }>(
    `SELECT full_name AS "fullName" FROM employees
      WHERE id = $1 AND status = 'active' AND removed_at IS NULL
      FOR SHARE`,
    [employeeId],
  );
  if (!found.rows[0]) {
    throw new CommitteeError(409, "COMMITTEE_EMPLOYEE_NOT_ACTIVE", "Pegawai yang dipilih harus pegawai aktif.");
  }
  return found.rows[0];
}

function isUniqueViolation(error: unknown): error is { code: string; constraint?: string } {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

export async function registerCommitteeRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession" | "getAuthorizationContext">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for committee routes");
  const auth = injectedAuth ?? new AuthService(
    pool, config.AUTH_ENCRYPTION_KEY, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production",
  );

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    return session.principal;
  }

  async function requirePermission(request: FastifyRequest, reply: FastifyReply, permission: CommitteePermission) {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    const context = await auth.getAuthorizationContext(principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, { code: "COMMITTEE_FORBIDDEN", message: "Anda tidak memiliki akses ke data kepanitiaan." });
      return null;
    }
    return principal;
  }

  /** D-15: the employee behind the session, or 403 EMPLOYEE_NOT_ACTIVE. */
  async function requireEmployee(request: FastifyRequest, reply: FastifyReply) {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    if (principal.principalType !== "EMPLOYEE") {
      await send(reply, 403, { code: "FORBIDDEN", message: "Kepanitiaan Saya hanya tersedia untuk pegawai." });
      return null;
    }
    const found = await pool.query<{ id: string }>(
      `SELECT employee.id
         FROM accounts account
         JOIN employees employee ON employee.id = account.employee_id
        WHERE account.id = $1 AND account.principal_type = 'EMPLOYEE' AND account.status = 'active'
          AND employee.status = 'active' AND employee.removed_at IS NULL`,
      [principal.id],
    );
    if (!found.rows[0]) {
      await send(reply, 403, { code: "EMPLOYEE_NOT_ACTIVE", message: "Akun tidak terhubung ke pegawai aktif." });
      return null;
    }
    return { principal, employeeId: found.rows[0].id };
  }

  function handleError(reply: FastifyReply, error: unknown) {
    if (error instanceof CommitteeError) {
      return send(reply, error.statusCode, { code: error.code, message: error.message, ...(error.details ?? {}) });
    }
    if (error instanceof DocumentError) return send(reply, error.statusCode, { code: error.code, message: error.message });
    if (isUniqueViolation(error)) {
      // A concurrent add raced the checks below; the partial unique indexes have the last word.
      return send(reply, 409, { code: "COMMITTEE_DUPLICATE_MEMBER", message: "Pegawai itu sudah menjadi anggota panitia ini." });
    }
    throw error;
  }

  /** Runs `work` in one transaction and answers with its result; domain errors become responses. */
  async function inTransaction(reply: FastifyReply, status: number, work: (client: PoolClient) => Promise<unknown>) {
    const client = await pool.connect();
    let result: unknown;
    try {
      await client.query("BEGIN");
      result = await work(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      return handleError(reply, error);
    } finally {
      client.release();
    }
    return send(reply, status, result);
  }

  const invalid = (reply: FastifyReply, code: string, message: string) => send(reply, 400, { code, message });
  const notFound = (reply: FastifyReply) =>
    send(reply, 404, { code: "COMMITTEE_NOT_FOUND", message: "Kepanitiaan tidak ditemukan." });

  async function loadMembers(committeeId: string, withEmployeeNumber: boolean) {
    const result = await pool.query(
      `SELECT member.id, member.employee_id AS "employeeId", employee.full_name AS "fullName",
              ${withEmployeeNumber ? `employee.employee_number AS "employeeNumber", employee.status AS "employeeStatus",` : ""}
              unit.name AS "unitName", member.role, member.section,
              to_char(member.joined_on, 'YYYY-MM-DD') AS "joinedOn", to_char(member.left_on, 'YYYY-MM-DD') AS "leftOn",
              member.end_reason AS "endReason"
         FROM committee_members member
         JOIN employees employee ON employee.id = member.employee_id
         LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
        WHERE member.committee_id = $1
        ORDER BY (member.left_on IS NULL) DESC, array_position($2::text[], member.role),
                 member.section NULLS LAST, employee.full_name, member.id`,
      [committeeId, COMMITTEE_ROLES],
    );
    return result.rows;
  }

  // ------------------------------------------------------------------ admin read

  app.get("/admin/committees", async (request, reply) => {
    if (!(await requirePermission(request, reply, "committees.read"))) return;
    const query = adminListQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_COMMITTEE_FILTER", "Filter kepanitiaan tidak valid.");
    const values: unknown[] = [];
    const add = (value: unknown) => `$${values.push(value)}`;
    const where: string[] = [];
    if (query.data.status) where.push(`committee.status = ${add(query.data.status)}`);
    if (query.data.category) where.push(`committee.category = ${add(query.data.category)}`);
    if (query.data.year) {
      const range = yearRange(query.data.year);
      where.push(`committee.start_on <= ${add(range.to)}::date AND committee.end_on >= ${add(range.from)}::date`);
    }
    if (query.data.q) where.push(`committee.name ILIKE ${add(likePattern(query.data.q))} ESCAPE '\\'`);
    const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const filterValues = [...values];
    const limit = add(query.data.pageSize);
    const offset = add(pageOffset(query.data));
    // ENG-LIST-001: filters run before LIMIT, and total counts the same filter.
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT ${COMMITTEE_COLUMNS}, committee.version,
                coalesce(document.document_number, committee.external_decree_number) AS "decreeNumber",
                (SELECT count(*)::int FROM committee_members member
                  WHERE member.committee_id = committee.id AND member.left_on IS NULL) AS "activeMemberCount",
                (SELECT employee.full_name FROM committee_members member
                   JOIN employees employee ON employee.id = member.employee_id
                  WHERE member.committee_id = committee.id AND member.role = 'CHAIR' AND member.left_on IS NULL) AS "chairName"
           FROM committees committee
           ${DECREE_JOIN}
           ${filter}
          ORDER BY array_position(ARRAY['DRAFT','ACTIVE','COMPLETED','CANCELLED']::text[], committee.status),
                   committee.start_on DESC, committee.name, committee.id
          LIMIT ${limit} OFFSET ${offset}`,
        values,
      ),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM committees committee ${filter}`, filterValues),
    ]);
    return send(reply, 200, { items: items.rows, pagination: pagination(query.data, count.rows[0]?.total ?? 0) });
  });

  app.get("/admin/committees/employee-options", async (request, reply) => {
    if (!(await requirePermission(request, reply, "committees.manage"))) return;
    const query = optionsQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_COMMITTEE_FILTER", "Ketik minimal 2 huruf.");
    // ENG-LIST-001 typeahead: at most 20 matches; the caller narrows the query for more.
    const result = await pool.query(
      `SELECT employee.id, employee.full_name AS "fullName", employee.employee_number AS "employeeNumber",
              unit.name AS "unitName"
         FROM employees employee
         LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
        WHERE employee.status = 'active' AND employee.removed_at IS NULL
          AND (employee.full_name ILIKE $1 ESCAPE '\\' OR employee.employee_number ILIKE $1 ESCAPE '\\')
        ORDER BY employee.full_name ASC, employee.id ASC
        LIMIT 20`,
      [likePattern(query.data.q)],
    );
    return send(reply, 200, { items: result.rows });
  });

  app.get("/admin/committees/participation", async (request, reply) => {
    if (!(await requirePermission(request, reply, "committees.read"))) return;
    const query = participationQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_COMMITTEE_FILTER", "Filter rekap tidak valid.");
    const selectedYear = query.data.year ?? currentYear();
    const range = yearRange(selectedYear);
    const values: unknown[] = [range.from, range.to, CORE_ROLES];
    const add = (value: unknown) => `$${values.push(value)}`;
    const search = query.data.q
      ? `AND (employee.full_name ILIKE ${add(likePattern(query.data.q))} ESCAPE '\\' OR employee.employee_number ILIKE $${values.length} ESCAPE '\\')`
      : "";
    // D-13: only ACTIVE and COMPLETED committees count, and only memberships that overlap the year.
    const memberships = `
      SELECT member.employee_id, member.role, member.left_on, committee.id AS committee_id, committee.status
        FROM committee_members member
        JOIN committees committee ON committee.id = member.committee_id
       WHERE committee.status IN ('ACTIVE', 'COMPLETED')
         AND member.joined_on <= $2::date AND coalesce(member.left_on, committee.end_on) >= $1::date`;
    const filterValues = [...values];
    const limit = add(query.data.pageSize);
    const offset = add(pageOffset(query.data));
    const [items, count] = await Promise.all([
      pool.query(
        `WITH memberships AS (${memberships})
         SELECT employee.id AS "employeeId", employee.full_name AS "fullName",
                employee.employee_number AS "employeeNumber", unit.name AS "unitName",
                count(DISTINCT memberships.committee_id)::int AS total,
                count(DISTINCT memberships.committee_id) FILTER (WHERE memberships.role = 'CHAIR')::int AS "asChair",
                count(DISTINCT memberships.committee_id) FILTER (WHERE memberships.role = ANY($3::text[]))::int AS "asCore",
                count(DISTINCT memberships.committee_id)
                  FILTER (WHERE memberships.status = 'ACTIVE' AND memberships.left_on IS NULL)::int AS ongoing
           FROM memberships
           JOIN employees employee ON employee.id = memberships.employee_id
           LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
          WHERE true ${search}
          GROUP BY employee.id, unit.name
          ORDER BY total DESC, employee.full_name, employee.id
          LIMIT ${limit} OFFSET ${offset}`,
        values,
      ),
      pool.query<{ total: number }>(
        `WITH memberships AS (${memberships})
         SELECT count(DISTINCT employee.id)::int AS total
           FROM memberships JOIN employees employee ON employee.id = memberships.employee_id
          WHERE $3::text[] IS NOT NULL ${search}`,
        filterValues,
      ),
    ]);
    return send(reply, 200, {
      year: selectedYear,
      items: items.rows,
      pagination: pagination(query.data, count.rows[0]?.total ?? 0),
    });
  });

  app.get("/admin/committees/participation/:employeeId", async (request, reply) => {
    if (!(await requirePermission(request, reply, "committees.read"))) return;
    const params = employeeParams.safeParse(request.params);
    const query = employeeParticipationQuery.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply, "INVALID_COMMITTEE_FILTER", "Filter rekap tidak valid.");
    const employee = await pool.query(
      `SELECT employee.id, employee.full_name AS "fullName", employee.employee_number AS "employeeNumber",
              unit.name AS "unitName"
         FROM employees employee
         LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
        WHERE employee.id = $1`,
      [params.data.employeeId],
    );
    if (!employee.rows[0]) return send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
    const selectedYear = query.data.year ?? currentYear();
    const range = yearRange(selectedYear);
    // Every activated committee of that year, cancelled ones flagged; drafts are not participation.
    const filter = `
      FROM committee_members member
      JOIN committees committee ON committee.id = member.committee_id
      ${DECREE_JOIN}
     WHERE member.employee_id = $1 AND ${VISIBLE_TO_MEMBERS}
       AND member.joined_on <= $3::date AND coalesce(member.left_on, committee.end_on) >= $2::date`;
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT member.id AS "memberId", committee.id AS "committeeId", committee.name, committee.category,
                committee.status, to_char(committee.start_on, 'YYYY-MM-DD') AS "startOn",
                to_char(committee.end_on, 'YYYY-MM-DD') AS "endOn", member.role, member.section,
                to_char(member.joined_on, 'YYYY-MM-DD') AS "joinedOn", to_char(member.left_on, 'YYYY-MM-DD') AS "leftOn",
                coalesce(document.document_number, committee.external_decree_number) AS "decreeNumber"
           ${filter}
          ORDER BY committee.start_on DESC, committee.name, member.id
          LIMIT $4 OFFSET $5`,
        [params.data.employeeId, range.from, range.to, query.data.pageSize, pageOffset(query.data)],
      ),
      pool.query<{ total: number }>(
        `SELECT count(*)::int AS total ${filter}`,
        [params.data.employeeId, range.from, range.to],
      ),
    ]);
    return send(reply, 200, {
      year: selectedYear,
      employee: employee.rows[0],
      items: items.rows,
      pagination: pagination(query.data, count.rows[0]?.total ?? 0),
    });
  });

  app.get("/admin/committees/:id", async (request, reply) => {
    if (!(await requirePermission(request, reply, "committees.read"))) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const found = await pool.query(
      `SELECT ${COMMITTEE_COLUMNS}, ${DECREE_COLUMNS}, committee.version,
              committee.created_at AS "createdAt", committee.updated_at AS "updatedAt"
         FROM committees committee
         ${DECREE_JOIN}
        WHERE committee.id = $1`,
      [params.data.id],
    );
    if (!found.rows[0]) return notFound(reply);
    // D-06: bounded at MAX_ACTIVE_MEMBERS open rows plus their history, so returned whole.
    const members = await loadMembers(params.data.id, true);
    return send(reply, 200, { ...found.rows[0], members });
  });

  app.get("/admin/committees/:id/history", async (request, reply) => {
    if (!(await requirePermission(request, reply, "committees.read"))) return;
    const params = idParams.safeParse(request.params);
    const query = pageQuerySchema.safeParse(request.query);
    if (!params.success) return notFound(reply);
    if (!query.success) return invalid(reply, "INVALID_COMMITTEE_FILTER", "Halaman riwayat tidak valid.");
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT event.id, event.event_type AS "eventType", event.employee_id AS "employeeId", event.reason,
                event.metadata, event.occurred_at AS "occurredAt",
                coalesce(employee.full_name, account.email) AS "actorName"
           FROM committee_audit_events event
           LEFT JOIN accounts account ON account.id = event.actor_account_id
           LEFT JOIN employees employee ON employee.id = account.employee_id
          WHERE event.committee_id = $1
          ORDER BY event.occurred_at DESC, event.id DESC
          LIMIT $2 OFFSET $3`,
        [params.data.id, query.data.pageSize, pageOffset(query.data)],
      ),
      pool.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM committee_audit_events WHERE committee_id = $1",
        [params.data.id],
      ),
    ]);
    return send(reply, 200, { items: items.rows, pagination: pagination(query.data, count.rows[0]?.total ?? 0) });
  });

  // ----------------------------------------------------------------- admin write

  app.post("/admin/committees", async (request, reply) => {
    const principal = await requirePermission(request, reply, "committees.manage");
    if (!principal) return;
    const body = committeeInput.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_COMMITTEE", body.error.issues[0]?.message ?? "Data kepanitiaan tidak valid.");
    const id = randomUUID();
    return inTransaction(reply, 201, async (client) => {
      await client.query(
        `INSERT INTO committees
           (id, name, category, description, organizer, start_on, end_on, created_by_account_id, updated_by_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [
          id, body.data.name, body.data.category, body.data.description ?? null, body.data.organizer ?? null,
          body.data.startOn, body.data.endOn, principal.id,
        ],
      );
      await writeCommitteeAudit(client, {
        eventType: "committee.created",
        committeeId: id,
        actorAccountId: principal.id,
        metadata: { name: body.data.name, category: body.data.category, startOn: body.data.startOn, endOn: body.data.endOn },
      });
      return { id, status: "DRAFT", version: 1 };
    });
  });

  app.patch("/admin/committees/:id", async (request, reply) => {
    const principal = await requirePermission(request, reply, "committees.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = committeeEdit.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_COMMITTEE", body.error.issues[0]?.message ?? "Data kepanitiaan tidak valid.");
    return inTransaction(reply, 200, async (client) => {
      const current = await lockCommittee(client, params.data.id);
      assertOpen(current.status);
      assertFreshVersion(current.version, body.data.version);
      const locked = lockedFieldChanges(current.status, current, body.data);
      if (locked.length) {
        throw new CommitteeError(409, "COMMITTEE_FIELD_LOCKED",
          "Nama, jenis, dan tanggal mulai sudah tertulis di SK dan tidak dapat diubah.", { fields: locked });
      }
      const next = {
        name: body.data.name, category: body.data.category, description: body.data.description ?? null,
        organizer: body.data.organizer ?? null, startOn: body.data.startOn, endOn: body.data.endOn,
      };
      const changes = Object.fromEntries((Object.keys(next) as Array<keyof typeof next>)
        .filter((field) => current[field] !== next[field])
        .map((field) => [field, { from: current[field], to: next[field] }]));
      if (!Object.keys(changes).length) return { id: params.data.id, status: current.status, version: current.version };
      // D-10: the end date may move, but never before someone on the committee joined.
      const lastJoin = await client.query<{ joinedOn: string | null }>(
        `SELECT to_char(max(joined_on), 'YYYY-MM-DD') AS "joinedOn" FROM committee_members
          WHERE committee_id = $1 AND left_on IS NULL`,
        [params.data.id],
      );
      const latest = current.status === "DRAFT" ? null : lastJoin.rows[0]?.joinedOn;
      if (latest && next.endOn < latest) {
        throw new CommitteeError(409, "COMMITTEE_STATE", "Tanggal selesai tidak boleh sebelum anggota terakhir bergabung.");
      }
      await client.query(
        `UPDATE committees SET name = $2, category = $3, description = $4, organizer = $5, start_on = $6, end_on = $7
          WHERE id = $1`,
        [params.data.id, next.name, next.category, next.description, next.organizer, next.startOn, next.endOn],
      );
      // D-11: draft members join on the start date, so they follow it.
      if (current.status === "DRAFT" && changes.startOn) {
        await client.query("UPDATE committee_members SET joined_on = $2, updated_at = now() WHERE committee_id = $1", [
          params.data.id, next.startOn,
        ]);
      }
      const version = await bumpVersion(client, params.data.id, principal.id);
      await writeCommitteeAudit(client, {
        eventType: "committee.updated",
        committeeId: params.data.id,
        actorAccountId: principal.id,
        metadata: { name: next.name, changes },
      });
      return { id: params.data.id, status: current.status, version };
    });
  });

  app.post("/admin/committees/:id/members", async (request, reply) => {
    const principal = await requirePermission(request, reply, "committees.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = memberAdd.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_COMMITTEE_MEMBER", body.error.issues[0]?.message ?? "Data anggota tidak valid.");
    return inTransaction(reply, 201, async (client) => {
      const current = await lockCommittee(client, params.data.id);
      assertOpen(current.status);
      assertFreshVersion(current.version, body.data.version);
      const employee = await assertActiveEmployee(client, body.data.employeeId);
      const open = await client.query<{ total: number; already: boolean }>(
        `SELECT count(*)::int AS total, bool_or(employee_id = $2) AS already
           FROM committee_members WHERE committee_id = $1 AND left_on IS NULL`,
        [params.data.id, body.data.employeeId],
      );
      if (open.rows[0]?.already) {
        throw new CommitteeError(409, "COMMITTEE_DUPLICATE_MEMBER", "Pegawai itu sudah menjadi anggota panitia ini.");
      }
      if ((open.rows[0]?.total ?? 0) >= MAX_ACTIVE_MEMBERS) {
        throw new CommitteeError(409, "COMMITTEE_MEMBER_LIMIT", `Satu kepanitiaan paling banyak ${MAX_ACTIVE_MEMBERS} anggota aktif.`);
      }
      if (body.data.role === "CHAIR") await demoteCurrentChair(client, params.data.id, null, principal.id);
      const memberId = randomUUID();
      const joinedOn = joinDate(current.status, current.startOn, today());
      await client.query(
        `INSERT INTO committee_members (id, committee_id, employee_id, role, section, joined_on, added_by_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [memberId, params.data.id, body.data.employeeId, body.data.role, body.data.section ?? null, joinedOn, principal.id],
      );
      const version = await bumpVersion(client, params.data.id, principal.id);
      await writeCommitteeAudit(client, {
        eventType: "committee.member.added",
        committeeId: params.data.id,
        employeeId: body.data.employeeId,
        actorAccountId: principal.id,
        metadata: { memberId, name: employee.fullName, role: body.data.role, section: body.data.section ?? null, joinedOn },
      });
      // D-17: only an established committee notifies; a draft is not news yet.
      if (current.status === "ACTIVE") {
        await notifyEmployee(client, body.data.employeeId, {
          eventKey: `committee.${params.data.id}.member.${memberId}.added`,
          category: "system",
          title: "Anda masuk kepanitiaan",
          body: `Anda ditetapkan sebagai ${ROLE_LABELS[body.data.role]} pada ${current.name}.`,
          href: `/app/committees?committee=${params.data.id}`,
          actorAccountId: principal.id,
        });
      }
      return { id: memberId, committeeId: params.data.id, version };
    });
  });

  app.patch("/admin/committees/:id/members/:memberId", async (request, reply) => {
    const principal = await requirePermission(request, reply, "committees.manage");
    if (!principal) return;
    const params = memberParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = memberEdit.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_COMMITTEE_MEMBER", body.error.issues[0]?.message ?? "Data anggota tidak valid.");
    return inTransaction(reply, 200, async (client) => {
      const current = await lockCommittee(client, params.data.id);
      assertOpen(current.status);
      assertFreshVersion(current.version, body.data.version);
      const member = await loadOpenMember(client, params.data.id, params.data.memberId);
      const section = body.data.section ?? null;
      if (member.role === body.data.role && member.section === section) {
        return { id: member.id, committeeId: params.data.id, version: current.version };
      }
      if (member.role === "CHAIR" && body.data.role !== "CHAIR" && current.status === "ACTIVE") {
        throw new CommitteeError(409, "COMMITTEE_CHAIR_REQUIRED",
          "Kepanitiaan yang sudah ditetapkan harus tetap punya Ketua. Jadikan anggota lain Ketua lebih dulu.");
      }
      if (body.data.role === "CHAIR" && member.role !== "CHAIR") {
        await demoteCurrentChair(client, params.data.id, member.id, principal.id);
      }
      await client.query("UPDATE committee_members SET role = $2, section = $3, updated_at = now() WHERE id = $1", [
        member.id, body.data.role, section,
      ]);
      const version = await bumpVersion(client, params.data.id, principal.id);
      await writeCommitteeAudit(client, {
        eventType: "committee.member.updated",
        committeeId: params.data.id,
        employeeId: member.employeeId,
        actorAccountId: principal.id,
        metadata: {
          memberId: member.id, name: member.fullName,
          before: { role: member.role, section: member.section }, after: { role: body.data.role, section },
        },
      });
      if (current.status === "ACTIVE") {
        await notifyEmployee(client, member.employeeId, {
          eventKey: `committee.${params.data.id}.member.${member.id}.updated.${version}`,
          category: "system",
          title: "Peran kepanitiaan berubah",
          body: `Peran Anda pada ${current.name} sekarang ${ROLE_LABELS[body.data.role]}${section ? ` (${section})` : ""}.`,
          href: `/app/committees?committee=${params.data.id}`,
          actorAccountId: principal.id,
        });
      }
      return { id: member.id, committeeId: params.data.id, version };
    });
  });

  app.post("/admin/committees/:id/members/:memberId/end", async (request, reply) => {
    const principal = await requirePermission(request, reply, "committees.manage");
    if (!principal) return;
    const params = memberParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = memberEnd.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_COMMITTEE_MEMBER", "Alasan paling banyak 300 karakter.");
    return inTransaction(reply, 200, async (client) => {
      const current = await lockCommittee(client, params.data.id);
      assertOpen(current.status);
      assertFreshVersion(current.version, body.data.version);
      const member = await loadOpenMember(client, params.data.id, params.data.memberId);
      const reason = body.data.reason ?? null;
      let leftOn: string | null = null;
      if (current.status === "DRAFT") {
        // D-11: nothing was established yet, so the draft row goes; the audit event stays.
        await client.query("DELETE FROM committee_members WHERE id = $1", [member.id]);
      } else {
        if (member.role === "CHAIR") {
          throw new CommitteeError(409, "COMMITTEE_CHAIR_REQUIRED",
            "Pindahkan peran Ketua ke anggota lain sebelum mengakhiri tugas Ketua.");
        }
        leftOn = leaveDate(member.joinedOn, today());
        await client.query(
          "UPDATE committee_members SET left_on = $2, end_reason = $3, updated_at = now() WHERE id = $1",
          [member.id, leftOn, reason],
        );
      }
      const version = await bumpVersion(client, params.data.id, principal.id);
      await writeCommitteeAudit(client, {
        eventType: current.status === "DRAFT" ? "committee.member.removed" : "committee.member.ended",
        committeeId: params.data.id,
        employeeId: member.employeeId,
        actorAccountId: principal.id,
        reason,
        metadata: { memberId: member.id, name: member.fullName, role: member.role, section: member.section, leftOn },
      });
      if (current.status === "ACTIVE") {
        await notifyEmployee(client, member.employeeId, {
          eventKey: `committee.${params.data.id}.member.${member.id}.ended`,
          category: "system",
          title: "Tugas kepanitiaan berakhir",
          body: `Tugas Anda pada ${current.name} berakhir per ${leftOn}.`,
          href: `/app/committees?committee=${params.data.id}`,
          actorAccountId: principal.id,
        });
      }
      return { id: member.id, committeeId: params.data.id, version, leftOn };
    });
  });

  app.post("/admin/committees/:id/activate", async (request, reply) => {
    const principal = await requirePermission(request, reply, "committees.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = activateInput.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_COMMITTEE", "Pilih cara SK: terbitkan di HCIS, atau isi nomor dan tanggal SK.");
    return inTransaction(reply, 200, async (client) => {
      const current = await lockCommittee(client, params.data.id);
      assertStatus(current.status, "DRAFT", "Hanya kepanitiaan draf yang dapat ditetapkan.");
      assertFreshVersion(current.version, body.data.version);
      const members = await client.query<{ employeeId: string; fullName: string; unitName: string | null;
        role: CommitteeRole; section: string | null; employeeActive: boolean }>(
        `SELECT member.employee_id AS "employeeId", employee.full_name AS "fullName", unit.name AS "unitName",
                member.role, member.section,
                (employee.status = 'active' AND employee.removed_at IS NULL) AS "employeeActive"
           FROM committee_members member
           JOIN employees employee ON employee.id = member.employee_id
           LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
          WHERE member.committee_id = $1 AND member.left_on IS NULL
          ORDER BY array_position($2::text[], member.role), member.section NULLS LAST, employee.full_name, member.id
          FOR SHARE OF employee`,
        [params.data.id, COMMITTEE_ROLES],
      );
      // D-07: nothing is numbered unless the committee is complete enough to be decreed.
      const problems = activationProblems(members.rows);
      if (problems.length) {
        throw new CommitteeError(409, "COMMITTEE_NOT_READY", problems.join(" "), { problems });
      }
      const chair = members.rows.find((member) => member.role === "CHAIR")!;
      let issuedDocumentId: string | null = null;
      let decreeNumber: string;
      if (body.data.decree.mode === "ISSUE") {
        const chairFacts = await loadEmployeeFacts(client, chair.employeeId);
        // D-09: without an eligible signer issueDocument throws before a number is taken, and
        // the rollback leaves the committee in DRAFT.
        const issued = await issueDocument(client, {
          documentKind: "COMMITTEE",
          documentCode: COMMITTEE_DOCUMENT_CODE,
          numberCode: COMMITTEE_NUMBER_CODE,
          employee: chairFacts!,
          issuedByAccountId: principal.id,
          // §5.4 / DOC-001 D-15: the committee and its line-up; never NIK, address, pay or contacts.
          contentSnapshot: {
            committeeId: params.data.id,
            name: current.name,
            category: current.category,
            organizer: current.organizer,
            startOn: current.startOn,
            endOn: current.endOn,
            members: members.rows.map((member) => ({
              fullName: member.fullName, unitName: member.unitName, role: member.role, section: member.section,
            })),
          },
        });
        issuedDocumentId = issued.id;
        decreeNumber = issued.documentNumber;
        await writeDocumentAudit(client, {
          eventType: "doc.issued",
          issuedDocumentId: issued.id,
          employeeId: chair.employeeId,
          actorAccountId: principal.id,
          metadata: { source: "ORG-012", committeeId: params.data.id, documentCode: COMMITTEE_DOCUMENT_CODE, documentNumber: decreeNumber },
        });
      } else {
        decreeNumber = body.data.decree.number;
      }
      await client.query(
        `UPDATE committees
            SET status = 'ACTIVE', activated_at = now(), decree_mode = $2, issued_document_id = $3,
                external_decree_number = $4, external_decree_date = $5
          WHERE id = $1`,
        [
          params.data.id, body.data.decree.mode === "ISSUE" ? "ISSUED" : "EXTERNAL", issuedDocumentId,
          body.data.decree.mode === "EXTERNAL" ? body.data.decree.number : null,
          body.data.decree.mode === "EXTERNAL" ? body.data.decree.date : null,
        ],
      );
      const version = await bumpVersion(client, params.data.id, principal.id);
      await writeCommitteeAudit(client, {
        eventType: "committee.activated",
        committeeId: params.data.id,
        actorAccountId: principal.id,
        metadata: {
          name: current.name, decreeMode: body.data.decree.mode === "ISSUE" ? "ISSUED" : "EXTERNAL",
          decreeNumber, memberCount: members.rows.length,
        },
      });
      for (const member of members.rows) {
        await notifyEmployee(client, member.employeeId, {
          eventKey: `committee.${params.data.id}.activated`,
          category: "system",
          title: "Anda ditetapkan sebagai panitia",
          body: `${current.name}: ${ROLE_LABELS[member.role]}${member.section ? ` (${member.section})` : ""}. SK ${decreeNumber}.`,
          href: `/app/committees?committee=${params.data.id}`,
          actorAccountId: principal.id,
        });
      }
      return { id: params.data.id, status: "ACTIVE", version, decreeNumber, issuedDocumentId };
    });
  });

  /** D-12: a final state leaves no open membership behind. */
  async function closeOpenMemberships(client: Db, committeeId: string, endOn: string) {
    const end = endOn < today() ? endOn : today();
    await client.query(
      `UPDATE committee_members SET left_on = GREATEST(joined_on, $2::date), updated_at = now()
        WHERE committee_id = $1 AND left_on IS NULL`,
      [committeeId, end],
    );
  }

  app.post("/admin/committees/:id/complete", async (request, reply) => {
    const principal = await requirePermission(request, reply, "committees.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = versionInput.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_COMMITTEE", "Versi kepanitiaan wajib dikirim.");
    return inTransaction(reply, 200, async (client) => {
      const current = await lockCommittee(client, params.data.id);
      assertStatus(current.status, "ACTIVE", "Hanya kepanitiaan yang sudah ditetapkan yang dapat diselesaikan.");
      assertFreshVersion(current.version, body.data.version);
      await closeOpenMemberships(client, params.data.id, current.endOn);
      await client.query("UPDATE committees SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [params.data.id]);
      const version = await bumpVersion(client, params.data.id, principal.id);
      await writeCommitteeAudit(client, {
        eventType: "committee.completed",
        committeeId: params.data.id,
        actorAccountId: principal.id,
        metadata: { name: current.name },
      });
      return { id: params.data.id, status: "COMPLETED", version };
    });
  });

  app.post("/admin/committees/:id/cancel", async (request, reply) => {
    const principal = await requirePermission(request, reply, "committees.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const body = cancelInput.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_COMMITTEE", "Alasan pembatalan 10–500 karakter.");
    return inTransaction(reply, 200, async (client) => {
      const current = await lockCommittee(client, params.data.id);
      assertOpen(current.status);
      assertFreshVersion(current.version, body.data.version);
      const reason = body.data.reason;
      const recipients = current.status === "ACTIVE"
        ? (await client.query<{ employeeId: string }>(
          `SELECT employee_id AS "employeeId" FROM committee_members WHERE committee_id = $1 AND left_on IS NULL`,
          [params.data.id],
        )).rows
        : [];
      await closeOpenMemberships(client, params.data.id, current.endOn);
      await client.query(
        "UPDATE committees SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $2 WHERE id = $1",
        [params.data.id, reason],
      );
      const version = await bumpVersion(client, params.data.id, principal.id);
      await writeCommitteeAudit(client, {
        eventType: "committee.cancelled",
        committeeId: params.data.id,
        actorAccountId: principal.id,
        reason,
        metadata: { name: current.name, previousStatus: current.status },
      });
      // D-12: an HCIS decree is revoked with the committee; its number stays used (DOC-001 D-03).
      if (current.issuedDocumentId) {
        const revoked = await client.query<{ employeeId: string }>(
          `UPDATE hr_issued_documents
              SET status = 'REVOKED', revoked_at = now(), revoked_by_account_id = $2, revoke_reason = $3
            WHERE id = $1 AND status = 'ISSUED'
            RETURNING employee_id AS "employeeId"`,
          [current.issuedDocumentId, principal.id, reason],
        );
        if (revoked.rows[0]) {
          await writeCommitteeAudit(client, {
            eventType: "committee.decree.revoked",
            committeeId: params.data.id,
            actorAccountId: principal.id,
            reason,
            metadata: { name: current.name, decreeNumber: current.decreeNumber },
          });
          await writeDocumentAudit(client, {
            eventType: "doc.revoked",
            issuedDocumentId: current.issuedDocumentId,
            employeeId: revoked.rows[0].employeeId,
            actorAccountId: principal.id,
            reason,
            metadata: {
              source: "ORG-012", committeeId: params.data.id, documentCode: COMMITTEE_DOCUMENT_CODE,
              documentNumber: current.decreeNumber,
            },
          });
        }
      }
      for (const recipient of recipients) {
        await notifyEmployee(client, recipient.employeeId, {
          eventKey: `committee.${params.data.id}.cancelled`,
          category: "system",
          title: "Kepanitiaan dibatalkan",
          body: `${current.name} dibatalkan.`,
          href: `/app/committees?committee=${params.data.id}`,
          actorAccountId: principal.id,
        });
      }
      return { id: params.data.id, status: "CANCELLED", version };
    });
  });

  // ------------------------------------------------------------------- employee

  app.get("/me/committees", async (request, reply) => {
    const me = await requireEmployee(request, reply);
    if (!me) return;
    const query = myListQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_COMMITTEE_FILTER", "Filter kepanitiaan tidak valid.");
    // One row per committee: the latest membership, so someone re-added after leaving appears once.
    const current = "(committee.status = 'ACTIVE' AND mine.left_on IS NULL)";
    const filter = query.data.scope === "current" ? current : `NOT ${current}`;
    const mine = `
      SELECT DISTINCT ON (member.committee_id) member.committee_id, member.role, member.section,
             member.joined_on, member.left_on
        FROM committee_members member
       WHERE member.employee_id = $1
       ORDER BY member.committee_id, member.left_on IS NULL DESC, member.joined_on DESC, member.id`;
    const from = `
      FROM (${mine}) mine
      JOIN committees committee ON committee.id = mine.committee_id
      ${DECREE_JOIN}
     WHERE ${VISIBLE_TO_MEMBERS} AND ${filter}`;
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT ${COMMITTEE_COLUMNS},
                coalesce(document.document_number, committee.external_decree_number) AS "decreeNumber",
                mine.role, mine.section, to_char(mine.joined_on, 'YYYY-MM-DD') AS "joinedOn",
                to_char(mine.left_on, 'YYYY-MM-DD') AS "leftOn"
           ${from}
          ORDER BY committee.start_on DESC, committee.name, committee.id
          LIMIT $2 OFFSET $3`,
        [me.employeeId, query.data.pageSize, pageOffset(query.data)],
      ),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total ${from}`, [me.employeeId]),
    ]);
    return send(reply, 200, { items: items.rows, pagination: pagination(query.data, count.rows[0]?.total ?? 0) });
  });

  app.get("/me/committees/meeting-groups", async (request, reply) => {
    const me = await requireEmployee(request, reply);
    if (!me) return;
    // D-16: at most 20 active committees, each with its other active members as CAL-001
    // participant options (name and unit only; no e-mail, phone or employee number).
    const committees = await pool.query<{ id: string; name: string }>(
      `SELECT committee.id, committee.name
         FROM committees committee
         JOIN committee_members member ON member.committee_id = committee.id
        WHERE committee.status = 'ACTIVE' AND member.employee_id = $1 AND member.left_on IS NULL
        ORDER BY committee.start_on DESC, committee.name, committee.id
        LIMIT 20`,
      [me.employeeId],
    );
    if (!committees.rows.length) return send(reply, 200, { items: [] });
    const members = await pool.query<{ committeeId: string; id: string; name: string; unitName: string | null;
      hasAccount: boolean; phone: string | null }>(
      `SELECT member.committee_id AS "committeeId", employee.id, employee.full_name AS name, unit.name AS "unitName",
              employee.phone,
              EXISTS (SELECT 1 FROM accounts account
                       WHERE account.employee_id = employee.id AND account.principal_type = 'EMPLOYEE'
                         AND account.status = 'active') AS "hasAccount"
         FROM committee_members member
         JOIN employees employee ON employee.id = member.employee_id
         LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
        WHERE member.committee_id = ANY($1::uuid[]) AND member.left_on IS NULL AND employee.id <> $2
          AND employee.status = 'active' AND employee.removed_at IS NULL
        ORDER BY employee.full_name, employee.id`,
      [committees.rows.map((committee) => committee.id), me.employeeId],
    );
    return send(reply, 200, {
      items: committees.rows.map((committee) => ({
        id: committee.id,
        name: committee.name,
        members: members.rows
          .filter((member) => member.committeeId === committee.id)
          .map((member) => ({
            id: member.id, name: member.name, unitName: member.unitName, hasAccount: member.hasAccount,
            hasWhatsApp: normalizeWhatsAppNumber(member.phone) !== null,
          })),
      })),
    });
  });

  app.get("/me/committees/:id", async (request, reply) => {
    const me = await requireEmployee(request, reply);
    if (!me) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    // ORG-012-F: a committee I am not on is indistinguishable from a missing one.
    const found = await pool.query(
      `SELECT ${COMMITTEE_COLUMNS}, ${DECREE_COLUMNS}
         FROM committees committee
         ${DECREE_JOIN}
        WHERE committee.id = $1 AND ${VISIBLE_TO_MEMBERS}
          AND EXISTS (SELECT 1 FROM committee_members member WHERE member.committee_id = committee.id AND member.employee_id = $2)`,
      [params.data.id, me.employeeId],
    );
    if (!found.rows[0]) return notFound(reply);
    const members = await loadMembers(params.data.id, false);
    return send(reply, 200, {
      ...found.rows[0],
      members,
      myMemberIds: members.filter((member) => member.employeeId === me.employeeId).map((member) => member.id),
    });
  });
}
