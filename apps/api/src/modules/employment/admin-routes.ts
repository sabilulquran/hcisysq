// EMP-005 / EMP-006 Package 1 S2 admin routes: rollout mode, read API, and the
// SHADOW consistency report (spec §8.1, §8.3, §9, §13.6). Read-only except the
// rollout mode. employment.* is HC-only: legacy Super Admin compatibility never
// grants it; the rollout mode is governance (access.governance.manage).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { requirePermissionsFromCookie } from "../auth/authorization.js";
import type { EmploymentPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthError, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import {
  DEFAULT_EMPLOYMENT_POLICY as policy,
  checkConsistency,
  isIsoDate,
  resolveEmployment,
  type ConsistencyIssueCode,
  type EmploymentHistory,
  type PlacementRecord,
} from "./domain/index.js";
import { loadStructureMismatches } from "./infrastructure/postgres-action-store.js";
import {
  getRolloutMode,
  jakartaToday,
  loadBaselineSources,
  loadHistories,
  loadTimeline,
  setRolloutMode,
  type EmploymentRolloutMode,
} from "./infrastructure/postgres-employment-store.js";

const employeeParams = z.object({ employeeId: z.string().uuid() });
const dateQuery = z.object({ date: z.string().refine(isIsoDate).optional() });
const consistencyQuery = z.object({
  date: z.string().refine(isIsoDate).optional(),
  code: z.string().max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const rolloutBody = z.object({
  mode: z.enum(["OFF", "SHADOW", "AUTHORITATIVE"]),
  reason: z.string().trim().min(10).max(500),
});

/**
 * Modes this release can serve. AUTHORITATIVE became available with S5 (the
 * contract actions and the projection writer) and S5A (the automatic account
 * deactivation D-15 requires). Being available is not being switched on:
 * production activation still follows the S8 runbook and its exit criteria.
 */
const AVAILABLE_MODES: readonly EmploymentRolloutMode[] = ["OFF", "SHADOW", "AUTHORITATIVE"];

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

export async function registerEmploymentAdminRoutes(app: FastifyInstance, pool: Pool, config: ApiConfig) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for employment admin routes");
  const auth = new AuthService(pool, config.AUTH_ENCRYPTION_KEY, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production");

  async function authenticateEmployment(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: EmploymentPermission,
  ): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    const context = await auth.getAuthorizationContext(session.principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, { code: "EMPLOYMENT_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
      return null;
    }
    return session.principal;
  }

  async function authenticateGovernance(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    try {
      return await requirePermissionsFromCookie(auth, request.headers.cookie, "access.governance.manage");
    } catch (error) {
      if (error instanceof AuthError) {
        await send(reply, error.statusCode, { code: error.code, message: error.message });
        return null;
      }
      throw error;
    }
  }

  async function requireReadableMode(reply: FastifyReply): Promise<EmploymentRolloutMode | null> {
    const { mode } = await getRolloutMode(pool);
    if (mode === "OFF") {
      await send(reply, 409, { code: "EMPLOYMENT_HISTORY_DISABLED", message: "Riwayat kepegawaian belum diaktifkan." });
      return null;
    }
    return mode;
  }

  app.get("/admin/employment/rollout", async (request, reply) => {
    if (!(await authenticateGovernance(request, reply))) return;
    const setting = await getRolloutMode(pool);
    return send(reply, 200, { ...setting, availableModes: AVAILABLE_MODES });
  });

  app.put("/admin/employment/rollout", async (request, reply) => {
    const principal = await authenticateGovernance(request, reply);
    if (!principal) return;
    const body = rolloutBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, { code: "INVALID_EMPLOYMENT_ROLLOUT", message: "Mode atau alasan tidak valid (alasan minimal 10 karakter)." });
    }
    if (!AVAILABLE_MODES.includes(body.data.mode)) {
      return send(reply, 409, {
        code: "EMPLOYMENT_MODE_NOT_AVAILABLE",
        message: "Mode tersebut belum tersedia pada rilis ini.",
      });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await setRolloutMode(client, body.data.mode, body.data.reason, principal.id);
      await client.query("COMMIT");
      return send(reply, 200, result);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/admin/employees/:employeeId/employment", async (request, reply) => {
    if (!(await authenticateEmployment(request, reply, "employment.read"))) return;
    const params = employeeParams.safeParse(request.params);
    const query = dateQuery.safeParse(request.query);
    if (!params.success || !query.success) {
      return send(reply, 400, { code: "INVALID_EMPLOYMENT_REQUEST", message: "Pegawai atau tanggal tidak valid." });
    }
    const mode = await requireReadableMode(reply);
    if (!mode) return;
    const employee = await pool.query<{ id: string }>("SELECT id FROM employees WHERE id = $1", [params.data.employeeId]);
    if (!employee.rows[0]) return send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });

    const date = query.data.date ?? jakartaToday();
    const history = (await loadHistories(pool, [params.data.employeeId])).get(params.data.employeeId) ?? emptyHistory(params.data.employeeId);
    const names = await loadReferenceNames(pool, history.placements);
    const resolved = resolveEmployment(history, date, policy);
    return send(reply, 200, {
      mode,
      date,
      state: resolved.state,
      flags: resolved.flags,
      current: {
        employment: resolved.employment,
        term: resolved.term,
        primaryPlacement: describePlacement(resolved.primaryPlacement, names),
        additionalPlacements: resolved.additionalPlacements.map((placement) => describePlacement(placement, names)),
      },
      employments: history.employments
        .filter((employment) => !employment.voided)
        .sort((a, b) => (b.startedOn ?? "").localeCompare(a.startedOn ?? ""))
        .map((employment) => ({
          ...employment,
          terms: history.terms.filter((term) => term.employmentId === employment.id && !term.voided).sort((a, b) => b.sequence - a.sequence),
          placements: history.placements
            .filter((placement) => placement.employmentId === employment.id && !placement.voided)
            .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
            .map((placement) => describePlacement(placement, names)),
        })),
    });
  });

  app.get("/admin/employees/:employeeId/employment/timeline", async (request, reply) => {
    if (!(await authenticateEmployment(request, reply, "employment.read"))) return;
    const params = employeeParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYMENT_REQUEST", message: "Pegawai tidak valid." });
    const mode = await requireReadableMode(reply);
    if (!mode) return;
    const employee = await pool.query<{ id: string }>("SELECT id FROM employees WHERE id = $1", [params.data.employeeId]);
    if (!employee.rows[0]) return send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
    return send(reply, 200, { mode, items: await loadTimeline(pool, params.data.employeeId) });
  });

  app.get("/admin/employment/consistency", async (request, reply) => {
    if (!(await authenticateEmployment(request, reply, "employment.read"))) return;
    const query = consistencyQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_EMPLOYMENT_REQUEST", message: "Parameter laporan tidak valid." });
    const mode = await requireReadableMode(reply);
    if (!mode) return;

    const date = query.data.date ?? jakartaToday();
    const structure = await loadStructureMismatches(pool, date);
    const [sources, histories, identities] = await Promise.all([
      loadBaselineSources(pool),
      loadHistories(pool),
      pool.query<{ id: string; employeeNumber: string; fullName: string }>(
        `SELECT id, employee_number AS "employeeNumber", full_name AS "fullName" FROM employees`,
      ),
    ]);
    const identityById = new Map(identities.rows.map((row) => [row.id, row]));
    const findings = sources.map((source) => {
      const finding = checkConsistency(source, histories.get(source.employeeId) ?? null, date, policy);
      // EMP-006 D-18: structure and placement are compared, never reconciled
      // automatically; HC decides which record to correct.
      if (structure.withoutPlacement.includes(source.employeeId)) finding.codes.push("STRUCTURE_SEAT_WITHOUT_PLACEMENT");
      if (structure.withoutSeat.includes(source.employeeId)) finding.codes.push("PLACEMENT_WITHOUT_STRUCTURE_SEAT");
      return finding;
    });

    const counts = new Map<ConsistencyIssueCode, number>();
    for (const finding of findings) for (const code of finding.codes) counts.set(code, (counts.get(code) ?? 0) + 1);
    const selected = findings.filter((finding) =>
      query.data.code ? finding.codes.includes(query.data.code as ConsistencyIssueCode) : finding.codes.length > 0,
    );
    const start = (query.data.page - 1) * query.data.pageSize;
    return send(reply, 200, {
      mode,
      date,
      employeeCount: sources.length,
      groups: [...counts.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
      total: selected.length,
      page: query.data.page,
      pageSize: query.data.pageSize,
      rows: selected.slice(start, start + query.data.pageSize).map((finding) => ({
        ...finding,
        employeeNumber: identityById.get(finding.employeeId)?.employeeNumber ?? null,
        fullName: identityById.get(finding.employeeId)?.fullName ?? null,
      })),
    });
  });
}

function emptyHistory(employeeId: string): EmploymentHistory {
  return { employeeId, employments: [], terms: [], placements: [], actions: [] };
}

type ReferenceNames = { units: Map<string, string>; positions: Map<string, string> };

async function loadReferenceNames(pool: Pool, placements: PlacementRecord[]): Promise<ReferenceNames> {
  const unitIds = placements.flatMap((placement) => (placement.unitRef.kind === "LEGACY_UNIT" ? [placement.unitRef.id] : []));
  const positionIds = placements.flatMap((placement) => (placement.positionRef?.kind === "LEGACY_POSITION" ? [placement.positionRef.id] : []));
  const [units, positions] = await Promise.all([
    pool.query<{ id: string; name: string }>("SELECT id, name FROM organizational_units WHERE id = ANY($1::uuid[])", [unitIds]),
    pool.query<{ id: string; name: string }>("SELECT id, name FROM positions WHERE id = ANY($1::uuid[])", [positionIds]),
  ]);
  return {
    units: new Map(units.rows.map((row) => [row.id, row.name])),
    positions: new Map(positions.rows.map((row) => [row.id, row.name])),
  };
}

function describePlacement(placement: PlacementRecord | null, names: ReferenceNames) {
  if (!placement) return null;
  const unitName = placement.unitRef.kind === "LEGACY_UNIT" ? names.units.get(placement.unitRef.id) ?? null : null;
  const positionName = placement.positionRef?.kind === "LEGACY_POSITION" ? names.positions.get(placement.positionRef.id) ?? null : null;
  return { ...placement, unitName, positionName };
}
