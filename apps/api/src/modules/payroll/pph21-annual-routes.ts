// PAY-003 annual PPh21, bukti potong 1721-A1 and the tax identity it prints
// (specification section 7.4). Every response is no-store: each carries pay data
// or an identity number (section 8). Reads are recorded without any figure and
// without the NIK/NPWP itself.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie } from "../auth/service.js";
import { resolveDocumentSigner } from "../documents/signer-authority.js";
import type { AnnualSegment } from "./pph21-annual.js";
import {
  annualRecapToCsv,
  findPph21AnnualPolicy,
  loadAnnualYear,
  loadEmployeeHeader,
  loadTaxIdentities,
  maskedTaxIdentity,
  openedTaxIdentity,
  segmentToJson,
  type AnnualPolicyLookup,
} from "./pph21-annual-store.js";
import { PPH21_OBJECT_CODE } from "./policy.js";
import { PER_PERSON_READER_PERMISSIONS } from "./routes.js";
import { writeAudit } from "./store.js";
import { normalizeTaxNumber, sealTaxIdentity, taxNumberProblem } from "./tax-identity.js";

const yearParam = z.coerce.number().int().min(2024).max(2100);
const recapQuery = z.object({ year: yearParam, format: z.enum(["json", "csv"]).default("json") });
const a1Params = z.object({ year: yearParam, employeeId: z.string().uuid(), index: z.coerce.number().int().min(1).max(12) });
const selfA1Params = z.object({ year: yearParam, index: z.coerce.number().int().min(1).max(12) });
const employeeParams = z.object({ employeeId: z.string().uuid() });
const identityBody = z
  .object({
    nik: z.string().trim().max(40).nullable().optional(),
    npwp: z.string().trim().max(40).nullable().optional(),
  })
  .refine((body) => body.nik !== undefined || body.npwp !== undefined, "Isi NIK atau NPWP.");

/**
 * An employee sees a bukti potong once its final masa pajak is published to them
 * like a payslip (DRAFT): the span is closed and the period of its last month
 * has reached PUBLISHED.
 */
const SELF_VISIBLE_STATE = "PUBLISHED";

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

function jakartaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

export async function registerPph21AnnualRoutes(app: FastifyInstance, pool: Pool, config: ApiConfig) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for payroll routes");
  const serverKey = config.AUTH_ENCRYPTION_KEY;
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  async function requireAny(
    request: FastifyRequest,
    reply: FastifyReply,
    permissions: readonly string[],
  ): Promise<{ accountId: string; employeeId: string | null } | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    const context = await auth.getAuthorizationContext(session.principal);
    if (!permissions.some((permission) => context.organizationPermissions.includes(permission))) {
      await send(reply, 403, { code: "PAYROLL_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
      return null;
    }
    const linked = await pool.query<{ employeeId: string | null }>(
      `SELECT employee_id AS "employeeId" FROM accounts WHERE id = $1`,
      [session.principal.id],
    );
    return { accountId: session.principal.id, employeeId: linked.rows[0]?.employeeId ?? null };
  }

  /** The signed-in employee, active and linked, like every self route (PAYSLIP-002). */
  async function requireSelf(request: FastifyRequest, reply: FastifyReply) {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    const { rows } = await pool.query<{ employeeId: string }>(
      `SELECT account.employee_id AS "employeeId"
         FROM accounts account
         JOIN employees employee ON employee.id = account.employee_id
        WHERE account.id = $1
          AND account.principal_type = 'EMPLOYEE'
          AND account.status = 'active'
          AND employee.status = 'active'
        LIMIT 1`,
      [session.principal.id],
    );
    const employeeId = rows[0]?.employeeId;
    if (!employeeId) {
      await send(reply, 403, { code: "EMPLOYEE_LINK_REQUIRED", message: "Akun tidak terhubung ke pegawai aktif." });
      return null;
    }
    return { accountId: session.principal.id, employeeId };
  }

  async function audit(accountId: string, action: string, payload: Record<string, unknown>) {
    const client = await pool.connect();
    try {
      await writeAudit(client, { actorAccountId: accountId, action, periodId: null, payload });
    } finally {
      client.release();
    }
  }

  async function policyOr409(reply: FastifyReply, year: number): Promise<Extract<AnnualPolicyLookup, { ok: true }> | null> {
    const lookup = await findPph21AnnualPolicy(pool, year);
    if (!lookup.ok) {
      await send(reply, 409, { code: lookup.code, message: lookup.message });
      return null;
    }
    return lookup;
  }

  /** The 1721-A1 of one closed span, with the numbers it must print. */
  async function a1Document(lookup: Extract<AnnualPolicyLookup, { ok: true }>, year: number, segment: AnnualSegment) {
    const header = await loadEmployeeHeader(pool, segment.employeeId);
    const identity = openedTaxIdentity(serverKey, (await loadTaxIdentities(pool, [segment.employeeId])).get(segment.employeeId));
    const signer = await resolveDocumentSigner(pool, segment.employeeId);
    return {
      year,
      objectCode: PPH21_OBJECT_CODE,
      reference: `HCIS-A1-${year}-${segment.employeeNumber}-${segment.index}`,
      issuedOn: jakartaToday(),
      withholder: lookup.policy.withholder,
      employee: {
        employeeNumber: header?.employeeNumber ?? segment.employeeNumber,
        fullName: header?.fullName ?? segment.fullName,
        position: header?.position ?? null,
        nik: identity.nik,
        npwp: identity.npwp,
        // Which number is on file but could not be opened (corrupt row or rotated key); never the value.
        unreadable: identity.unreadable,
      },
      policy: { versionId: lookup.versionId, effectiveFrom: lookup.effectiveFrom, source: lookup.policy.source },
      segment: segmentToJson(segment),
      signer,
    };
  }

  // HC recap of one tax year: every span, open or closed.
  app.get("/payroll/pph21/annual", async (request, reply) => {
    const actor = await requireAny(request, reply, PER_PERSON_READER_PERMISSIONS);
    if (!actor) return;
    const query = recapQuery.safeParse(request.query ?? {});
    if (!query.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Tahun pajak tidak valid." });
    }
    const lookup = await policyOr409(reply, query.data.year);
    if (!lookup) return;
    const annual = await loadAnnualYear(pool, query.data.year, lookup.policy);
    const identities = await loadTaxIdentities(pool, [...new Set(annual.segments.map((segment) => segment.employeeId))]);

    if (query.data.format === "csv") {
      const opened = new Map(
        [...identities.values()].map((row) => [row.employeeId, openedTaxIdentity(serverKey, row)]),
      );
      await audit(actor.accountId, "payroll.report.read", {
        scope: "pph21_annual_csv",
        tax_year: query.data.year,
        row_count: annual.segments.length,
        includes_tax_identity: true,
        unreadable_count: [...opened.values()].filter((identity) => identity.unreadable.length > 0).length,
      });
      reply.header("Cache-Control", "no-store");
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="pph21-tahunan-${query.data.year}.csv"`);
      return reply.status(200).send(annualRecapToCsv(annual.segments, opened));
    }

    await audit(actor.accountId, "payroll.report.read", {
      scope: "pph21_annual",
      tax_year: query.data.year,
      row_count: annual.segments.length,
    });
    return send(reply, 200, {
      annual: {
        year: annual.year,
        objectCode: PPH21_OBJECT_CODE,
        policy: { versionId: lookup.versionId, effectiveFrom: lookup.effectiveFrom, source: lookup.policy.source },
        pendingPeriods: annual.pendingPeriods,
        periodsWithoutTer: annual.periodsWithoutTer,
        totals: {
          segmentCount: annual.segments.length,
          closedCount: annual.segments.filter((segment) => segment.closed).length,
          annualTax: String(annual.segments.reduce((total, segment) => total + (segment.annualTax ?? 0), 0)),
          finalMasaTax: String(annual.segments.reduce((total, segment) => total + (segment.finalMasaTax ?? 0), 0)),
        },
        rows: annual.segments.map((segment) => ({
          ...segmentToJson(segment),
          // Whether the numbers are on file, never the numbers (section 8).
          taxIdentity: {
            nik: Boolean(identities.get(segment.employeeId)?.nikLast4),
            npwp: Boolean(identities.get(segment.employeeId)?.npwpLast4),
          },
        })),
      },
    });
  });

  // HC: the 1721-A1 of one person's closed span.
  app.get("/payroll/pph21/annual/:year/employees/:employeeId/a1/:index", async (request, reply) => {
    const actor = await requireAny(request, reply, PER_PERSON_READER_PERMISSIONS);
    if (!actor) return;
    const params = a1Params.safeParse(request.params);
    if (!params.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Parameter tidak valid." });
    }
    const lookup = await policyOr409(reply, params.data.year);
    if (!lookup) return;
    const annual = await loadAnnualYear(pool, params.data.year, lookup.policy, params.data.employeeId);
    const segment = annual.segments.find((candidate) => candidate.index === params.data.index);
    if (!segment) {
      return send(reply, 404, { code: "PPH21_A1_NOT_FOUND", message: "Bukti potong tidak ditemukan." });
    }
    if (!segment.closed) {
      return send(reply, 409, {
        code: "PPH21_A1_NOT_FINAL",
        message: "Masa pajak terakhir belum disahkan; bukti potong 1721-A1 belum dapat dibuat.",
      });
    }
    if (segment.flags.includes("PERIOD_PENDING")) {
      return send(reply, 409, {
        code: "PPH21_A1_PERIOD_PENDING",
        message: "Ada periode tahun ini yang belum disahkan atau sedang dibuka ulang; bukti potong menunggu periode itu final.",
      });
    }
    await audit(actor.accountId, "payroll.a1.read", {
      scope: "pph21_a1",
      tax_year: params.data.year,
      employee_id: params.data.employeeId,
      segment_index: params.data.index,
    });
    return send(reply, 200, { a1: await a1Document(lookup, params.data.year, segment) });
  });

  // Employee: own bukti potong, list without figures.
  app.get("/payroll/me/a1", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    const { rows: years } = await pool.query<{ year: number }>(
      `SELECT DISTINCT extract(year FROM period.period_month)::int AS year
         FROM payroll_results result
         JOIN payroll_periods period ON period.id = result.period_id
         JOIN employments e ON e.id = result.employment_id
        WHERE e.employee_id = $1 AND period.state = $2
        ORDER BY 1 DESC`,
      [self.employeeId, SELF_VISIBLE_STATE],
    );
    const items: Array<{ year: number; index: number; startPeriod: string; endPeriod: string }> = [];
    for (const { year } of years) {
      const lookup = await findPph21AnnualPolicy(pool, year);
      if (!lookup.ok) continue;
      for (const segment of await visibleSelfSegments(year, lookup, self.employeeId)) {
        items.push({ year, index: segment.index, startPeriod: segment.startPeriod, endPeriod: segment.endPeriod });
      }
    }
    return send(reply, 200, { items });
  });

  // Employee: one own bukti potong, printable.
  app.get("/payroll/me/a1/:year/:index", async (request, reply) => {
    const self = await requireSelf(request, reply);
    if (!self) return;
    const params = selfA1Params.safeParse(request.params);
    if (!params.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Parameter tidak valid." });
    }
    const lookup = await findPph21AnnualPolicy(pool, params.data.year);
    const segment = lookup.ok
      ? (await visibleSelfSegments(params.data.year, lookup, self.employeeId)).find(
          (candidate) => candidate.index === params.data.index,
        )
      : undefined;
    if (!lookup.ok || !segment) {
      return send(reply, 404, { code: "PPH21_A1_NOT_FOUND", message: "Bukti potong tidak ditemukan." });
    }
    await audit(self.accountId, "payroll.a1.read", {
      scope: "pph21_a1_self",
      tax_year: params.data.year,
      employee_id: self.employeeId,
      segment_index: params.data.index,
    });
    return send(reply, 200, { a1: await a1Document(lookup, params.data.year, segment) });
  });

  /** Closed spans whose final masa pajak has been published (DRAFT). */
  async function visibleSelfSegments(
    year: number,
    lookup: Extract<AnnualPolicyLookup, { ok: true }>,
    employeeId: string,
  ): Promise<AnnualSegment[]> {
    const annual = await loadAnnualYear(pool, year, lookup.policy, employeeId);
    const { rows } = await pool.query<{ month: string }>(
      `SELECT to_char(period_month, 'YYYY-MM') AS month FROM payroll_periods
        WHERE extract(year FROM period_month)::int = $1 AND state = $2`,
      [year, SELF_VISIBLE_STATE],
    );
    const published = new Set(rows.map((row) => row.month));
    return annual.segments.filter(
      (segment) => segment.closed && !segment.flags.includes("PERIOD_PENDING") && published.has(segment.endPeriod),
    );
  }

  // HC: whether NIK/NPWP are on file, masked.
  app.get("/payroll/employees/:employeeId/tax-identity", async (request, reply) => {
    const actor = await requireAny(request, reply, ["payroll.profiles.manage"]);
    if (!actor) return;
    const params = employeeParams.safeParse(request.params);
    if (!params.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_QUERY", message: "Identifier pegawai tidak valid." });
    }
    const identities = await loadTaxIdentities(pool, [params.data.employeeId]);
    return send(reply, 200, { taxIdentity: maskedTaxIdentity(identities.get(params.data.employeeId)) });
  });

  // HC: record or clear NIK/NPWP. Not sent = kept; null = cleared.
  app.put("/payroll/employees/:employeeId/tax-identity", async (request, reply) => {
    const actor = await requireAny(request, reply, ["payroll.profiles.manage"]);
    if (!actor) return;
    const params = employeeParams.safeParse(request.params);
    const body = identityBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return send(reply, 400, { code: "PAYROLL_INVALID_TAX_IDENTITY", message: "Isi NIK atau NPWP." });
    }
    const employeeId = params.data.employeeId;
    // Same conflict-of-interest rule as the compensation profile (section 2).
    if (actor.employeeId === employeeId) {
      return send(reply, 403, {
        code: "PAYROLL_SELF_EDIT_FORBIDDEN",
        message: "Data pajak milik sendiri diisi oleh petugas lain.",
      });
    }
    const exists = await pool.query("SELECT 1 FROM employees WHERE id = $1", [employeeId]);
    if (exists.rowCount === 0) {
      return send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
    }

    const sealed: Record<"nik" | "npwp", { sealed: string | null; last4: string | null } | undefined> = {
      nik: undefined,
      npwp: undefined,
    };
    for (const field of ["nik", "npwp"] as const) {
      const value = body.data[field];
      if (value === undefined) continue;
      if (value === null || value.length === 0) {
        sealed[field] = { sealed: null, last4: null };
        continue;
      }
      const digits = normalizeTaxNumber(value);
      const problem = taxNumberProblem(field, digits);
      if (problem) return send(reply, 400, { code: "PAYROLL_INVALID_TAX_IDENTITY", message: problem });
      sealed[field] = { sealed: sealTaxIdentity(serverKey, employeeId, field, digits), last4: digits.slice(-4) };
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO payroll_tax_identities (employee_id, nik_sealed, nik_last4, npwp_sealed, npwp_last4, updated_by_account_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (employee_id) DO UPDATE SET
           nik_sealed = CASE WHEN $7 THEN EXCLUDED.nik_sealed ELSE payroll_tax_identities.nik_sealed END,
           nik_last4 = CASE WHEN $7 THEN EXCLUDED.nik_last4 ELSE payroll_tax_identities.nik_last4 END,
           npwp_sealed = CASE WHEN $8 THEN EXCLUDED.npwp_sealed ELSE payroll_tax_identities.npwp_sealed END,
           npwp_last4 = CASE WHEN $8 THEN EXCLUDED.npwp_last4 ELSE payroll_tax_identities.npwp_last4 END,
           updated_by_account_id = EXCLUDED.updated_by_account_id,
           updated_at = now()`,
        [
          employeeId,
          sealed.nik?.sealed ?? null,
          sealed.nik?.last4 ?? null,
          sealed.npwp?.sealed ?? null,
          sealed.npwp?.last4 ?? null,
          actor.accountId,
          sealed.nik !== undefined,
          sealed.npwp !== undefined,
        ],
      );
      // Which fields changed and whether they were cleared; never a value (section 8).
      await writeAudit(client, {
        actorAccountId: actor.accountId,
        action: "payroll.tax_identity.updated",
        periodId: null,
        payload: {
          employee_id: employeeId,
          fields: (["nik", "npwp"] as const).filter((field) => sealed[field] !== undefined),
          cleared: (["nik", "npwp"] as const).filter((field) => sealed[field]?.sealed === null),
        },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const identities = await loadTaxIdentities(pool, [employeeId]);
    return send(reply, 200, { taxIdentity: maskedTaxIdentity(identities.get(employeeId)) });
  });
}
