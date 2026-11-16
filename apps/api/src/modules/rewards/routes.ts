// REWARD-001 Package 1 routes: award rounds from the Al-Qur'an monthly scoreboard, the Kepala HCM's
// decisions, publication with its outbox, revocation, the recipients list, one's own awards and
// certificate, and the public certificate check. Spec: docs/domain/rewards.md.
//
// reward.* is HC-only and never granted through legacy Super Admin compatibility, so the admin
// routes read the organization permissions directly. Scores appear only on the admin screens
// (R-12): the recipients list, notifications, announcement and certificate carry none.

import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import { publicOrigin } from "../auth/csrf.js";
import { hasOrganizationPermission, type RewardPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import {
  categoryLabel,
  generateVerificationCode,
  isMonth,
  isMonthFinal,
  MAX_IMPORT_BYTES,
  monthLabel,
  nextRank,
  normalizeVerificationCode,
  parseManualSnapshot,
  RewardError,
  type RewardLabel,
  type RewardScope,
  type SnapshotRow,
} from "./domain.js";
import {
  QuranMonthlyScoreboardClient,
  notConfiguredReader,
  type MonthlyScoreboardReader,
} from "./quran-scoreboard-client.js";
import {
  activeProgramId,
  buildRoundFromSource,
  createRound,
  employeeStates,
  inTransaction,
  insertCandidate,
  processDueOutbox,
  processOutboxItem,
  schedulerTick,
  writeRewardAudit,
  type RewardRuntime,
} from "./service.js";

const DEFAULT_VERIFY_BASE_URL = "https://hcis.sabilulquran.or.id";
const HC_ADMIN_ROLE_KEY = "human_capital_admin";
const PUBLIC_RATE_LIMIT = 30;
const PUBLIC_RATE_WINDOW_MS = 60_000;
const PUBLIC_RATE_MAX_KEYS = 10_000;

const month = z.string().refine(isMonth, "month must be YYYY-MM");
const idParams = z.object({ id: z.string().uuid() });
const reasonBody = z.object({ reason: z.string().trim().min(5).max(500) });
const createRoundBody = z.object({ month });
const importBody = z.object({
  month,
  note: z.string().trim().min(5).max(500),
  csv: z.string().min(1).max(MAX_IMPORT_BYTES),
});
const roundListQuery = pageQuerySchema.extend({
  status: z.enum(["PENDING_DECISION", "PUBLISHED", "CANCELLED"]).optional(),
  month: month.optional(),
});
const eventsQuery = pageQuerySchema;
const recipientsQuery = pageQuerySchema.extend({ month: month.optional() });

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

function invalid(reply: FastifyReply, message = "Permintaan penghargaan tidak valid.") {
  return send(reply, 400, { code: "INVALID_REWARD_REQUEST", message });
}

/** Adapter when every QURAN_* setting is present; config validation refuses a partial set. */
export function createScoreboardReader(config: ApiConfig): MonthlyScoreboardReader | null {
  if (!config.OIDC_ISSUER || !config.QURAN_SCOREBOARD_URL || !config.QURAN_MACHINE_CLIENT_ID || !config.QURAN_MACHINE_CLIENT_SECRET) {
    return null;
  }
  return new QuranMonthlyScoreboardClient(
    config.OIDC_ISSUER,
    config.QURAN_MACHINE_CLIENT_ID,
    config.QURAN_MACHINE_CLIENT_SECRET,
    config.QURAN_SCOREBOARD_URL,
    config.QURAN_SCOREBOARD_AUDIENCE ?? "sq-hub-quran",
  );
}

function numeric(value: unknown): number {
  return Number(value);
}

export async function registerRewardRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  dependencies: {
    reader?: MonthlyScoreboardReader | null;
    auth?: Pick<AuthService, "getSession" | "getAuthorizationContext">;
    now?: () => Date;
  } = {},
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for reward routes");
  const auth = dependencies.auth ?? new AuthService(
    pool, config.AUTH_ENCRYPTION_KEY, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production",
  );
  const configuredReader = dependencies.reader !== undefined ? dependencies.reader : createScoreboardReader(config);
  const now = dependencies.now ?? (() => new Date());
  const runtime: RewardRuntime = {
    pool,
    reader: configuredReader ?? notConfiguredReader,
    sourceConfigured: configuredReader !== null,
    verifyBaseUrl: publicOrigin(config) ?? DEFAULT_VERIFY_BASE_URL,
    now,
    log: app.log,
  };

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    return session.principal;
  }

  async function permissionsOf(principal: AuthPrincipal): Promise<string[]> {
    return (await auth.getAuthorizationContext(principal)).organizationPermissions;
  }

  async function requirePermission(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: RewardPermission,
  ): Promise<{ principal: AuthPrincipal; permissions: string[] } | null> {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    const permissions = await permissionsOf(principal);
    if (!permissions.includes(permission)) {
      await send(reply, 403, { code: "REWARD_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
      return null;
    }
    return { principal, permissions };
  }

  /** The active employee behind an EMPLOYEE session, or null. */
  async function employeeOf(db: Pool | PoolClient, accountId: string): Promise<{ id: string; active: boolean } | null> {
    const found = await db.query<{ id: string; active: boolean }>(
      `SELECT employee.id, (employee.status = 'active') AS active
         FROM accounts account
         JOIN employees employee ON employee.id = account.employee_id
        WHERE account.id = $1 AND account.principal_type = 'EMPLOYEE' AND account.status = 'active'
          AND employee.removed_at IS NULL`,
      [accountId],
    );
    return found.rows[0] ?? null;
  }

  async function requireEmployee(request: FastifyRequest, reply: FastifyReply) {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    const employee = principal.principalType === "EMPLOYEE" ? await employeeOf(pool, principal.id) : null;
    if (!employee?.active) {
      await send(reply, 403, { code: "FORBIDDEN", message: "Penghargaan hanya tersedia untuk pegawai aktif." });
      return null;
    }
    return { principal, employeeId: employee.id };
  }

  async function handle(reply: FastifyReply, work: () => Promise<unknown>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RewardError) return send(reply, error.statusCode, { code: error.code, message: error.message });
      throw error;
    }
  }

  async function holdsHcAdminRole(db: Pool | PoolClient, accountId: string): Promise<boolean> {
    // Directly assigned, or following a seat the account's employee holds (AUTH-015).
    const found = await db.query(
      `SELECT 1
         FROM account_role_assignments assignment
         JOIN roles role ON role.id = assignment.role_id
        WHERE assignment.account_id = $1 AND role.role_key = $2
          AND assignment.scope_type = 'organization' AND assignment.organizational_unit_id IS NULL
          AND (assignment.starts_on IS NULL OR assignment.starts_on <= current_date)
          AND (assignment.ends_on IS NULL OR assignment.ends_on >= current_date)
       UNION ALL
       SELECT 1 FROM hcis_seat_permissions(current_date, $1::uuid) seat WHERE seat.role_key = $2
        LIMIT 1`,
      [accountId, HC_ADMIN_ROLE_KEY],
    );
    return found.rows.length > 0;
  }

  /** R-09: the candidate is the Kepala HCM when their own account holds reward.manage. */
  async function candidateIsRewardManager(db: Pool | PoolClient, employeeId: string | null): Promise<boolean> {
    if (!employeeId) return false;
    const accounts = await db.query<{ id: string }>(
      `SELECT id FROM accounts WHERE employee_id = $1 AND principal_type = 'EMPLOYEE' AND status = 'active'`,
      [employeeId],
    );
    for (const account of accounts.rows) {
      if (await hasOrganizationPermission(db, account.id, "reward.manage")) return true;
    }
    return false;
  }

  interface LockedCandidate {
    id: string;
    roundId: string;
    category: RewardScope;
    unitRef: string;
    unitName: string | null;
    seat: number;
    status: "CANDIDATE" | "AWARDED" | "DECLINED" | "UNRESOLVED";
    employeeId: string | null;
    personRef: string;
    roundStatus: string;
    importedBy: string | null;
    replaced: boolean;
  }

  async function lockCandidate(client: PoolClient, id: string): Promise<LockedCandidate> {
    const found = await client.query<LockedCandidate>(
      `SELECT candidate.id, candidate.round_id AS "roundId", candidate.category, candidate.unit_ref AS "unitRef",
              candidate.unit_name AS "unitName", candidate.seat, candidate.status, candidate.employee_id AS "employeeId",
              candidate.person_ref AS "personRef", round.status AS "roundStatus",
              source_import.imported_by_account_id AS "importedBy",
              EXISTS (SELECT 1 FROM reward_candidates other WHERE other.replaces_candidate_id = candidate.id) AS replaced
         FROM reward_candidates candidate
         JOIN reward_rounds round ON round.id = candidate.round_id
         LEFT JOIN reward_snapshot_imports source_import ON source_import.id = round.import_id
        WHERE candidate.id = $1
        FOR UPDATE OF candidate, round`,
      [id],
    );
    const candidate = found.rows[0];
    if (!candidate) throw new RewardError(404, "REWARD_CANDIDATE_NOT_FOUND", "Kandidat tidak ditemukan.");
    return candidate;
  }

  /**
   * §4.2 guard for a decision: reward.manage, or the R-09 path (HC admin role, candidate is the
   * Kepala HCM). Nobody decides about themselves; R-14 DRAFT: nobody decides on a snapshot they
   * imported.
   */
  async function assertMayDecide(client: PoolClient, principal: AuthPrincipal, permissions: string[], candidate: LockedCandidate) {
    const employee = await employeeOf(client, principal.id);
    if (employee && candidate.employeeId === employee.id) {
      throw new RewardError(403, "REWARD_SELF_DECISION", "Anda tidak dapat memutuskan penghargaan untuk diri sendiri.");
    }
    if (!permissions.includes("reward.manage")) {
      const r09 = await holdsHcAdminRole(client, principal.id) && await candidateIsRewardManager(client, candidate.employeeId);
      if (!r09) throw new RewardError(403, "REWARD_FORBIDDEN", "Anda tidak memiliki akses untuk tindakan ini.");
    }
    if (candidate.importedBy && candidate.importedBy === principal.id) {
      throw new RewardError(403, "REWARD_IMPORTER_DECISION", "Pengimpor snapshot tidak dapat memutuskan kandidat dari snapshot itu.");
    }
    if (candidate.roundStatus !== "PENDING_DECISION") {
      throw new RewardError(409, "REWARD_CANDIDATE_LOCKED", "Putaran ini sudah tidak menerima keputusan.");
    }
    if (candidate.status === "UNRESOLVED") {
      throw new RewardError(409, "REWARD_CANDIDATE_UNRESOLVED", "Kandidat ini tidak bisa ditetapkan.");
    }
  }

  // -------------------------------------------------------------------------------------------
  // Admin: source and rounds

  app.get("/admin/rewards/source", async (request, reply) => {
    if (!(await requirePermission(request, reply, "reward.read"))) return;
    const current = now();
    const latestFinal = (() => {
      const date = new Date(current.getTime() + 7 * 3_600_000);
      const candidate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
      const text = `${candidate.getUTCFullYear()}-${String(candidate.getUTCMonth() + 1).padStart(2, "0")}`;
      if (isMonthFinal(text, current)) return text;
      const earlier = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 2, 1));
      return `${earlier.getUTCFullYear()}-${String(earlier.getUTCMonth() + 1).padStart(2, "0")}`;
    })();
    const read = await runtime.reader.read(latestFinal);
    if (read.status === "UNAVAILABLE") {
      request.log.warn({ code: `REWARD_SOURCE_${read.failure}`, httpStatus: read.httpStatus }, "Al-Qur'an scoreboard could not be read");
    }
    const attempts = await pool.query(
      `SELECT attempt.month, attempt.attempts, attempt.last_attempt_at AS "lastAttemptAt",
              attempt.last_outcome AS "lastOutcome", attempt.exhausted_at AS "exhaustedAt"
         FROM reward_fetch_attempts attempt
         JOIN reward_programs program ON program.id = attempt.program_id AND program.code = 'TILAWAH'
        WHERE attempt.month = $1`,
      [latestFinal],
    );
    return send(reply, 200, {
      status: read.status,
      latestFinalMonth: latestFinal,
      manualImportOpen: !runtime.sourceConfigured,
      fetch: attempts.rows[0] ?? null,
    });
  });

  app.get("/admin/rewards/rounds", async (request, reply) => {
    if (!(await requirePermission(request, reply, "reward.read"))) return;
    const query = roundListQuery.safeParse(request.query);
    if (!query.success) return invalid(reply);
    const filters = [query.data.status ?? null, query.data.month ?? null];
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT round.id, round.month, round.status, round.source_kind AS "sourceKind",
                round.directory_stale AS "directoryStale", round.created_at AS "createdAt",
                round.published_at AS "publishedAt",
                (SELECT count(*)::int FROM reward_candidates candidate WHERE candidate.round_id = round.id) AS "candidateCount",
                (SELECT count(*)::int FROM reward_candidates candidate
                  WHERE candidate.round_id = round.id AND candidate.status = 'AWARDED') AS "awardedCount"
           FROM reward_rounds round
          WHERE ($1::text IS NULL OR round.status = $1) AND ($2::text IS NULL OR round.month = $2)
          ORDER BY round.month DESC, round.created_at DESC, round.id
          LIMIT $3 OFFSET $4`,
        [...filters, query.data.pageSize, pageOffset(query.data)],
      ),
      pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM reward_rounds round
          WHERE ($1::text IS NULL OR round.status = $1) AND ($2::text IS NULL OR round.month = $2)`,
        filters,
      ),
    ]);
    return send(reply, 200, { items: rows.rows, pagination: pagination(query.data, total.rows[0]?.total ?? 0) });
  });

  async function roundDetail(id: string, viewer: { principal: AuthPrincipal; permissions: string[] }) {
    const found = await pool.query(
      `SELECT round.id, round.month, round.status, round.source_kind AS "sourceKind",
              round.snapshot_version AS "snapshotVersion", round.snapshot_finalized_at AS "snapshotFinalizedAt",
              round.directory_version AS "directoryVersion", round.directory_as_of AS "directoryAsOf",
              round.directory_stale AS "directoryStale", round.fetched_at AS "fetchedAt",
              round.created_at AS "createdAt", creator.email AS "createdBy",
              round.cancel_reason AS "cancelReason", round.cancelled_at AS "cancelledAt",
              round.published_at AS "publishedAt", publisher_employee.full_name AS "publishedByName",
              round.announcement_id AS "announcementId",
              source_import.note AS "importNote", source_import.file_sha256 AS "importSha256", source_import.row_count AS "importRowCount",
              source_import.imported_by_account_id AS "importedByAccountId", importer_employee.full_name AS "importedByName",
              (SELECT count(*)::int FROM reward_snapshot_rows snapshot_row WHERE snapshot_row.round_id = round.id) AS "snapshotRowCount"
         FROM reward_rounds round
         LEFT JOIN accounts creator ON creator.id = round.created_by_account_id
         LEFT JOIN accounts publisher ON publisher.id = round.published_by_account_id
         LEFT JOIN employees publisher_employee ON publisher_employee.id = publisher.employee_id
         LEFT JOIN reward_snapshot_imports source_import ON source_import.id = round.import_id
         LEFT JOIN accounts importer ON importer.id = source_import.imported_by_account_id
         LEFT JOIN employees importer_employee ON importer_employee.id = importer.employee_id
        WHERE round.id = $1`,
      [id],
    );
    const round = found.rows[0] as (Record<string, unknown> & { importedByAccountId: string | null; status: string }) | undefined;
    if (!round) throw new RewardError(404, "REWARD_ROUND_NOT_FOUND", "Putaran tidak ditemukan.");
    // Bounded by the round: 3 foundation seats, one per scoreboard unit, ties and replacements.
    const [candidates, awards, outbox] = await Promise.all([
      pool.query<{ pages: string; employeeId: string | null; status: string } & Record<string, unknown>>(
        `SELECT candidate.id, candidate.category, candidate.unit_ref AS "unitRef", candidate.unit_name AS "unitName",
                candidate.seat, candidate.rank, candidate.pages::text AS pages, candidate.active_days AS "activeDays",
                candidate.khatam, candidate.labels, candidate.person_ref AS "personRef", candidate.employee_id AS "employeeId",
                employee.full_name AS "employeeName", employee.employee_number AS "employeeNumber",
                unit.name AS "employeeUnitName",
                candidate.status, candidate.unresolved_reason AS "unresolvedReason", candidate.decline_reason AS "declineReason",
                candidate.decided_at AS "decidedAt", decider_employee.full_name AS "decidedByName",
                candidate.replaces_candidate_id AS "replacesCandidateId",
                EXISTS (SELECT 1 FROM reward_candidates other WHERE other.replaces_candidate_id = candidate.id) AS replaced
           FROM reward_candidates candidate
           LEFT JOIN employees employee ON employee.id = candidate.employee_id
           LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
           LEFT JOIN accounts decider ON decider.id = candidate.decided_by_account_id
           LEFT JOIN employees decider_employee ON decider_employee.id = decider.employee_id
          WHERE candidate.round_id = $1
          ORDER BY (candidate.category = 'UNIT'), candidate.unit_name NULLS FIRST, candidate.unit_ref, candidate.seat,
                   candidate.rank, candidate.created_at, candidate.id`,
        [id],
      ),
      pool.query(
        `SELECT award.id, award.candidate_id AS "candidateId", award.employee_id AS "employeeId", award.category,
                award.category_label AS "categoryLabel", award.recipient_name AS "recipientName", award.status,
                award.revoke_reason AS "revokeReason", award.revoked_at AS "revokedAt",
                award.certificate_generated_at IS NOT NULL AS "certificateReady", award.awarded_at AS "awardedAt"
           FROM reward_awards award WHERE award.round_id = $1
          ORDER BY (award.category = 'UNIT'), award.category_label, award.recipient_name, award.id`,
        [id],
      ),
      pool.query(
        `SELECT outbox.id, outbox.award_id AS "awardId", outbox.effect, outbox.status, outbox.attempts,
                outbox.last_error AS "lastError", outbox.next_attempt_at AS "nextAttemptAt", outbox.done_at AS "doneAt"
           FROM reward_outbox outbox WHERE outbox.round_id = $1
          ORDER BY (outbox.effect = 'ANNOUNCEMENT') DESC, outbox.created_at, outbox.id`,
        [id],
      ),
    ]);

    // UI hint only; every decision route checks again. Which candidates this viewer may decide.
    const canManage = viewer.permissions.includes("reward.manage");
    const viewerEmployee = await employeeOf(pool, viewer.principal.id);
    const importer = round.importedByAccountId === viewer.principal.id;
    const hcAdmin = !canManage && round.status === "PENDING_DECISION" && await holdsHcAdminRole(pool, viewer.principal.id);
    const decidable: string[] = [];
    if (round.status === "PENDING_DECISION" && !importer) {
      for (const candidate of candidates.rows) {
        if (candidate.status === "UNRESOLVED" || (viewerEmployee && candidate.employeeId === viewerEmployee.id)) continue;
        if (canManage || (hcAdmin && await candidateIsRewardManager(pool, candidate.employeeId))) {
          decidable.push(candidate.id as string);
        }
      }
    }
    return {
      ...round,
      candidates: candidates.rows.map((candidate) => ({ ...candidate, pages: numeric(candidate.pages) })),
      awards: awards.rows,
      outbox: outbox.rows,
      viewer: { canManage, decidableCandidateIds: decidable, isImporter: importer, employeeId: viewerEmployee?.id ?? null },
    };
  }

  app.get("/admin/rewards/rounds/:id", async (request, reply) => {
    const viewer = await requirePermission(request, reply, "reward.read");
    if (!viewer) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 404, { code: "REWARD_ROUND_NOT_FOUND", message: "Putaran tidak ditemukan." });
    return handle(reply, async () => send(reply, 200, await roundDetail(params.data.id, viewer)));
  });

  app.get("/admin/rewards/rounds/:id/events", async (request, reply) => {
    if (!(await requirePermission(request, reply, "reward.read"))) return;
    const params = idParams.safeParse(request.params);
    const query = eventsQuery.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply);
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT event.id, event.event_type AS "eventType", event.candidate_id AS "candidateId", event.award_id AS "awardId",
                event.reason, event.metadata, event.occurred_at AS "occurredAt",
                COALESCE(actor_employee.full_name, actor.email, 'Sistem') AS "actorName"
           FROM reward_audit_events event
           LEFT JOIN accounts actor ON actor.id = event.actor_account_id
           LEFT JOIN employees actor_employee ON actor_employee.id = actor.employee_id
          WHERE event.round_id = $1
          ORDER BY event.occurred_at DESC, event.id
          LIMIT $2 OFFSET $3`,
        [params.data.id, query.data.pageSize, pageOffset(query.data)],
      ),
      pool.query<{ total: number }>("SELECT count(*)::int AS total FROM reward_audit_events WHERE round_id = $1", [params.data.id]),
    ]);
    return send(reply, 200, { items: rows.rows, pagination: pagination(query.data, total.rows[0]?.total ?? 0) });
  });

  /** §4.1 manual trigger ("Susun ulang"): only for a final month without a live round. */
  app.post("/admin/rewards/rounds", async (request, reply) => {
    const actor = await requirePermission(request, reply, "reward.manage");
    if (!actor) return;
    const body = createRoundBody.safeParse(request.body);
    if (!body.success) return invalid(reply);
    return handle(reply, async () => {
      if (!isMonthFinal(body.data.month, now())) {
        throw new RewardError(409, "REWARD_PERIOD_NOT_FINAL", "Papan skor bulan ini belum final.");
      }
      const programId = await activeProgramId(pool);
      const live = await pool.query(
        "SELECT 1 FROM reward_rounds WHERE program_id = $1 AND month = $2 AND status <> 'CANCELLED'",
        [programId, body.data.month],
      );
      if (live.rows.length) throw new RewardError(409, "REWARD_ROUND_EXISTS", "Putaran untuk bulan ini sudah ada.");
      const created = await buildRoundFromSource(runtime, body.data.month, actor.principal.id);
      return send(reply, 201, { id: created.roundId, candidates: created.candidates });
    });
  });

  /** R-14 DRAFT: HC imports the monthly snapshot from CSV while the Al-Qur'an source is not configured. */
  app.post("/admin/rewards/imports", { bodyLimit: MAX_IMPORT_BYTES * 2 }, async (request, reply) => {
    const actor = await requirePermission(request, reply, "reward.import");
    if (!actor) return;
    const body = importBody.safeParse(request.body);
    if (!body.success) return invalid(reply);
    return handle(reply, async () => {
      if (runtime.sourceConfigured) {
        throw new RewardError(409, "REWARD_MANUAL_IMPORT_CLOSED", "Sumber papan skor Al-Qur'an sudah tersambung; impor manual ditutup.");
      }
      if (!isMonthFinal(body.data.month, now())) {
        throw new RewardError(409, "REWARD_PERIOD_NOT_FINAL", "Papan skor bulan ini belum final.");
      }
      const parsed = parseManualSnapshot(body.data.csv);
      if (parsed.problems.length) {
        return send(reply, 400, { code: "INVALID_REWARD_IMPORT", message: "Berkas CSV tidak valid.", problems: parsed.problems });
      }
      const result = await inTransaction(pool, async (client) => {
        const programId = await activeProgramId(client);
        // People by NIP; a NIP HCIS does not know is a problem in the file, not a guess.
        const numbers = [...new Set(parsed.rows.map((row) => row.employeeNumber))];
        const people = await client.query<{ id: string; employeeNumber: string }>(
          `SELECT id, employee_number AS "employeeNumber" FROM employees WHERE employee_number = ANY($1::text[]) AND removed_at IS NULL`,
          [numbers],
        );
        const byNumber = new Map(people.rows.map((row) => [row.employeeNumber, row.id]));
        // Units by hcis:org-node ref, bare stable key, or exact name in today's published structure.
        const tokens = [...new Set(parsed.rows.map((row) => row.scopeToken).filter((token) => token !== "YAYASAN"))];
        const units = await client.query<{ key: string; name: string }>(
          `WITH latest AS (
             SELECT id FROM organization_change_sets
              WHERE status = 'PUBLISHED' AND effective_on <= current_date
              ORDER BY effective_on DESC, published_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 1
           )
           SELECT node.stable_key::text AS key, node.name FROM latest JOIN organization_nodes node ON node.change_set_id = latest.id
            WHERE node.active`,
        );
        const unitRefByToken = new Map<string, string>();
        const problems: Array<{ line: number; message: string }> = [];
        for (const token of tokens) {
          const key = token.replace(/^hcis:org-node:/i, "").toLowerCase();
          const byKey = units.rows.find((unit) => unit.key === key);
          const byName = units.rows.filter((unit) => unit.name.trim().toLowerCase() === token.trim().toLowerCase());
          const match = byKey ?? (byName.length === 1 ? byName[0] : undefined);
          if (match) unitRefByToken.set(token, `hcis:org-node:${match.key}`);
          else {
            const line = parsed.rows.find((row) => row.scopeToken === token)!.line;
            problems.push({ line, message: byName.length > 1 ? `Nama unit "${token}" tidak unik; pakai kode unit.` : `Unit "${token}" tidak dikenal.` });
          }
        }
        // Two spellings of one unit (name and code) are one board: a NIP twice on it is a duplicate.
        const seenOnBoard = new Set<string>();
        for (const row of parsed.rows) {
          if (!byNumber.has(row.employeeNumber)) {
            problems.push({ line: row.line, message: `NIP ${row.employeeNumber} tidak dikenal.` });
            continue;
          }
          const board = row.scopeToken === "YAYASAN" ? "YAYASAN" : unitRefByToken.get(row.scopeToken);
          if (!board) continue;
          const key = `${board}\u0000${byNumber.get(row.employeeNumber)}`;
          if (seenOnBoard.has(key)) problems.push({ line: row.line, message: "Pegawai yang sama muncul dua kali dalam satu cakupan." });
          seenOnBoard.add(key);
        }
        if (problems.length) {
          throw Object.assign(new RewardError(400, "INVALID_REWARD_IMPORT", "Berkas CSV tidak valid."), { problems: problems.slice(0, 50) });
        }
        const rows: SnapshotRow[] = parsed.rows.map((row) => ({
          scope: row.scopeToken === "YAYASAN" ? "FOUNDATION" : "UNIT",
          unitRef: row.scopeToken === "YAYASAN" ? "" : unitRefByToken.get(row.scopeToken)!,
          personRef: `hcis:employee:${byNumber.get(row.employeeNumber)}`,
          rank: row.rank,
          pages: row.pages,
          activeDays: row.activeDays,
          khatam: row.khatam,
          labels: row.labels as RewardLabel[],
        }));
        const sha256 = createHash("sha256").update(body.data.csv, "utf8").digest("hex");
        const importId = randomUUID();
        await client.query(
          `INSERT INTO reward_snapshot_imports (id, program_id, month, file_sha256, row_count, note, imported_by_account_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [importId, programId, body.data.month, sha256, rows.length, body.data.note, actor.principal.id],
        );
        await writeRewardAudit(client, {
          eventType: "reward.snapshot.imported",
          importId,
          actorAccountId: actor.principal.id,
          reason: body.data.note,
          metadata: { month: body.data.month, rows: rows.length, sha256 },
        });
        const created = await createRound(client, {
          programId,
          month: body.data.month,
          rows,
          actorAccountId: actor.principal.id,
          source: {
            sourceKind: "MANUAL_IMPORT",
            importId,
            snapshotVersion: `manual:sha256:${sha256}`,
            snapshotFinalizedAt: null,
            directoryVersion: null,
            directoryAsOf: null,
            directoryStale: false,
          },
        });
        return { ...created, importId, rows: rows.length };
      }).catch((error: unknown) => {
        const problems = (error as { problems?: unknown }).problems;
        if (error instanceof RewardError && problems) {
          return { problems, error };
        }
        throw error;
      });
      if ("problems" in result) {
        return send(reply, 400, { code: result.error.code, message: result.error.message, problems: result.problems });
      }
      return send(reply, 201, { id: result.roundId, importId: result.importId, rows: result.rows, candidates: result.candidates });
    });
  });

  // -------------------------------------------------------------------------------------------
  // Admin: decisions

  async function decide(
    request: FastifyRequest,
    reply: FastifyReply,
    decision: "AWARDED" | "DECLINED",
  ) {
    const principal = await authenticate(request, reply);
    if (!principal) return;
    const permissions = await permissionsOf(principal);
    // reward.read is the floor: the R-09 path is an HC admin, who holds it.
    if (!permissions.includes("reward.manage") && !permissions.includes("reward.read")) {
      return send(reply, 403, { code: "REWARD_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    const body = decision === "DECLINED" ? reasonBody.safeParse(request.body) : { success: true as const, data: { reason: null } };
    if (!body.success) return invalid(reply, "Alasan wajib diisi 5–500 karakter.");
    return handle(reply, async () => {
      const result = await inTransaction(pool, async (client) => {
        const candidate = await lockCandidate(client, params.data.id);
        await assertMayDecide(client, principal, permissions, candidate);
        if (candidate.status === decision && decision === "AWARDED") return { id: candidate.id, status: decision, unchanged: true };
        if (decision === "AWARDED") {
          if (candidate.replaced) {
            throw new RewardError(409, "REWARD_CANDIDATE_LOCKED", "Kursi kandidat ini sudah diisi peringkat berikutnya.");
          }
          const states = await employeeStates(client, [candidate.personRef]);
          if (!states.get(candidate.personRef)?.active) {
            throw new RewardError(409, "REWARD_CANDIDATE_UNRESOLVED", "Pegawai ini tidak lagi aktif dan tidak bisa ditetapkan.");
          }
        }
        await client.query(
          `UPDATE reward_candidates
              SET status = $2, decline_reason = $3, decided_by_account_id = $4, decided_at = now()
            WHERE id = $1`,
          [candidate.id, decision, body.data.reason, principal.id],
        );
        const eventType = candidate.status === "CANDIDATE"
          ? (decision === "AWARDED" ? "reward.candidate.awarded" : "reward.candidate.declined")
          : "reward.candidate.decision_changed";
        await writeRewardAudit(client, {
          eventType,
          roundId: candidate.roundId,
          candidateId: candidate.id,
          actorAccountId: principal.id,
          reason: body.data.reason,
          metadata: { from: candidate.status, to: decision, viaR09: !permissions.includes("reward.manage") },
        });
        return { id: candidate.id, status: decision, unchanged: false };
      });
      return send(reply, 200, result);
    });
  }

  app.post("/admin/rewards/candidates/:id/award", async (request, reply) => decide(request, reply, "AWARDED"));
  app.post("/admin/rewards/candidates/:id/decline", async (request, reply) => decide(request, reply, "DECLINED"));

  /** R-08: fill a vacated seat from the same snapshot; never from outside it. */
  app.post("/admin/rewards/candidates/:id/next-rank", async (request, reply) => {
    const actor = await requirePermission(request, reply, "reward.manage");
    if (!actor) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    return handle(reply, async () => {
      const added = await inTransaction(pool, async (client) => {
        const candidate = await lockCandidate(client, params.data.id);
        if (candidate.roundStatus !== "PENDING_DECISION") {
          throw new RewardError(409, "REWARD_CANDIDATE_LOCKED", "Putaran ini sudah tidak menerima keputusan.");
        }
        if (candidate.status !== "DECLINED" && candidate.status !== "UNRESOLVED") {
          throw new RewardError(409, "REWARD_CANDIDATE_LOCKED", "Kursi ini belum kosong. Tidak tetapkan kandidat lebih dulu.");
        }
        if (candidate.replaced) {
          throw new RewardError(409, "REWARD_CANDIDATE_LOCKED", "Kursi ini sudah diisi peringkat berikutnya.");
        }
        const board = await client.query<{ personRef: string; rank: number; pages: string; activeDays: number; khatam: number; labels: string[] }>(
          `SELECT person_ref AS "personRef", rank, pages::text AS pages, active_days AS "activeDays", khatam, labels
             FROM reward_snapshot_rows
            WHERE round_id = $1 AND scope = $2 AND unit_ref = $3
            ORDER BY rank, id`,
          [candidate.roundId, candidate.category, candidate.unitRef],
        );
        const taken = await client.query<{ personRef: string }>(
          `SELECT person_ref AS "personRef" FROM reward_candidates WHERE round_id = $1`,
          [candidate.roundId],
        );
        const rows: SnapshotRow[] = board.rows.map((row) => ({
          scope: candidate.category,
          unitRef: candidate.unitRef,
          personRef: row.personRef,
          rank: row.rank,
          pages: numeric(row.pages),
          activeDays: row.activeDays,
          khatam: row.khatam,
          labels: row.labels as RewardLabel[],
        }));
        const next = nextRank(rows, new Set(taken.rows.map((row) => row.personRef)));
        if (!next.length) throw new RewardError(409, "REWARD_NO_NEXT_RANK", "Tidak ada peringkat berikutnya di papan skor ini.");
        const states = await employeeStates(client, next.map((row) => row.personRef));
        const created: string[] = [];
        for (const [index, row] of next.entries()) {
          const inserted = await insertCandidate(
            client, candidate.roundId, candidate.category, candidate.unitRef, candidate.unitName, candidate.seat, row, states,
            index === 0 ? candidate.id : null,
          );
          created.push(inserted.id);
          await writeRewardAudit(client, {
            eventType: "reward.candidate.replacement_added",
            roundId: candidate.roundId,
            candidateId: inserted.id,
            actorAccountId: actor.principal.id,
            metadata: { replaces: candidate.id, rank: row.rank, unresolved: inserted.unresolved },
          });
        }
        return created;
      });
      return send(reply, 201, { candidateIds: added });
    });
  });

  // -------------------------------------------------------------------------------------------
  // Admin: publication, cancellation, revocation, outbox

  app.post("/admin/rewards/rounds/:id/publish", async (request, reply) => {
    const actor = await requirePermission(request, reply, "reward.manage");
    if (!actor) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    return handle(reply, async () => {
      const published = await inTransaction(pool, async (client) => {
        const found = await client.query<{ status: string; month: string }>(
          "SELECT status, month FROM reward_rounds WHERE id = $1 FOR UPDATE",
          [params.data.id],
        );
        const round = found.rows[0];
        if (!round) throw new RewardError(404, "REWARD_ROUND_NOT_FOUND", "Putaran tidak ditemukan.");
        const counts = await client.query<{ open: number; awarded: number }>(
          `SELECT count(*) FILTER (WHERE status = 'CANDIDATE')::int AS open,
                  count(*) FILTER (WHERE status = 'AWARDED')::int AS awarded
             FROM reward_candidates WHERE round_id = $1`,
          [params.data.id],
        );
        const { open, awarded } = counts.rows[0]!;
        if (round.status !== "PENDING_DECISION" || open > 0 || awarded === 0) {
          throw new RewardError(409, "REWARD_ROUND_NOT_READY", round.status !== "PENDING_DECISION"
            ? "Putaran ini tidak bisa diterbitkan lagi."
            : open > 0 ? "Masih ada kandidat yang belum diputuskan." : "Belum ada kandidat yang ditetapkan.");
        }
        const winners = await client.query<{ id: string; employeeId: string; category: RewardScope; seat: number; unitName: string | null; fullName: string; active: boolean }>(
          `SELECT candidate.id, candidate.employee_id AS "employeeId", candidate.category, candidate.seat,
                  candidate.unit_name AS "unitName", employee.full_name AS "fullName",
                  (employee.status = 'active' AND employee.removed_at IS NULL
                   AND employee.management_scope = 'MANAGED') AS active
             FROM reward_candidates candidate
             JOIN employees employee ON employee.id = candidate.employee_id
            WHERE candidate.round_id = $1 AND candidate.status = 'AWARDED'
            ORDER BY candidate.id`,
          [params.data.id],
        );
        if (winners.rows.some((winner) => !winner.active)) {
          throw new RewardError(409, "REWARD_ROUND_NOT_READY", "Ada penerima yang tidak lagi aktif. Ubah keputusannya dulu.");
        }
        const awardIds: string[] = [];
        for (const winner of winners.rows) {
          const awardId = randomUUID();
          awardIds.push(awardId);
          await client.query(
            `INSERT INTO reward_awards (id, round_id, candidate_id, employee_id, month, category, category_label, recipient_name, verification_code, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE')`,
            [
              awardId, params.data.id, winner.id, winner.employeeId, round.month, winner.category,
              categoryLabel(winner.category, winner.seat, winner.unitName), winner.fullName, generateVerificationCode(),
            ],
          );
          await client.query(
            `INSERT INTO reward_outbox (id, round_id, award_id, effect, status)
             VALUES ($1, $3, $4, 'NOTIFICATION', 'PENDING'), ($2, $3, $4, 'CERTIFICATE', 'PENDING')`,
            [randomUUID(), randomUUID(), params.data.id, awardId],
          );
        }
        await client.query(
          "INSERT INTO reward_outbox (id, round_id, award_id, effect, status) VALUES ($1, $2, NULL, 'ANNOUNCEMENT', 'PENDING')",
          [randomUUID(), params.data.id],
        );
        await client.query(
          "UPDATE reward_rounds SET status = 'PUBLISHED', published_at = now(), published_by_account_id = $2 WHERE id = $1",
          [params.data.id, actor.principal.id],
        );
        await writeRewardAudit(client, {
          eventType: "reward.round.published",
          roundId: params.data.id,
          actorAccountId: actor.principal.id,
          metadata: { awards: awardIds.length, month: round.month },
        });
        return { awards: awardIds.length };
      });
      // §4.3: effects run after the commit; a failure stays "Belum terkirim" with a retry button.
      try {
        await processDueOutbox(runtime, params.data.id, 1_000);
      } catch (error) {
        request.log.warn({ code: "REWARD_EFFECT_FAILED", cause: error instanceof Error ? error.name : "UNEXPECTED" }, "reward effects deferred");
      }
      return send(reply, 200, { id: params.data.id, status: "PUBLISHED", awards: published.awards });
    });
  });

  app.post("/admin/rewards/rounds/:id/cancel", async (request, reply) => {
    const actor = await requirePermission(request, reply, "reward.manage");
    if (!actor) return;
    const params = idParams.safeParse(request.params);
    const body = reasonBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Alasan wajib diisi 5–500 karakter.");
    return handle(reply, async () => {
      await inTransaction(pool, async (client) => {
        const found = await client.query<{ status: string }>("SELECT status FROM reward_rounds WHERE id = $1 FOR UPDATE", [params.data.id]);
        const round = found.rows[0];
        if (!round) throw new RewardError(404, "REWARD_ROUND_NOT_FOUND", "Putaran tidak ditemukan.");
        if (round.status !== "PENDING_DECISION") {
          throw new RewardError(409, "REWARD_ROUND_NOT_CANCELLABLE", "Hanya putaran yang menunggu keputusan yang bisa dibatalkan.");
        }
        await client.query(
          `UPDATE reward_rounds SET status = 'CANCELLED', cancel_reason = $2, cancelled_by_account_id = $3, cancelled_at = now() WHERE id = $1`,
          [params.data.id, body.data.reason, actor.principal.id],
        );
        await writeRewardAudit(client, {
          eventType: "reward.round.cancelled", roundId: params.data.id, actorAccountId: actor.principal.id, reason: body.data.reason,
        });
      });
      return send(reply, 200, { id: params.data.id, status: "CANCELLED" });
    });
  });

  app.post("/admin/rewards/awards/:id/revoke", async (request, reply) => {
    const actor = await requirePermission(request, reply, "reward.manage");
    if (!actor) return;
    const params = idParams.safeParse(request.params);
    const body = reasonBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "Alasan wajib diisi 5–500 karakter.");
    return handle(reply, async () => {
      await inTransaction(pool, async (client) => {
        const found = await client.query<{ status: string; roundId: string; employeeId: string }>(
          `SELECT status, round_id AS "roundId", employee_id AS "employeeId" FROM reward_awards WHERE id = $1 FOR UPDATE`,
          [params.data.id],
        );
        const award = found.rows[0];
        if (!award) throw new RewardError(404, "REWARD_AWARD_NOT_FOUND", "Penghargaan tidak ditemukan.");
        if (award.status !== "ACTIVE") throw new RewardError(409, "REWARD_AWARD_ALREADY_REVOKED", "Penghargaan ini sudah dicabut.");
        const self = await employeeOf(client, actor.principal.id);
        if (self && self.id === award.employeeId) {
          throw new RewardError(403, "REWARD_SELF_DECISION", "Anda tidak dapat memutuskan penghargaan untuk diri sendiri.");
        }
        await client.query(
          `UPDATE reward_awards SET status = 'REVOKED', revoke_reason = $2, revoked_by_account_id = $3, revoked_at = now() WHERE id = $1`,
          [params.data.id, body.data.reason, actor.principal.id],
        );
        await writeRewardAudit(client, {
          eventType: "reward.award.revoked", roundId: award.roundId, awardId: params.data.id,
          actorAccountId: actor.principal.id, reason: body.data.reason,
        });
      });
      return send(reply, 200, { id: params.data.id, status: "REVOKED" });
    });
  });

  app.post("/admin/rewards/outbox/:id/retry", async (request, reply) => {
    const actor = await requirePermission(request, reply, "reward.manage");
    if (!actor) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    return handle(reply, async () => {
      await inTransaction(pool, async (client) => {
        const found = await client.query<{ status: string; roundId: string }>(
          `SELECT status, round_id AS "roundId" FROM reward_outbox WHERE id = $1 FOR UPDATE`,
          [params.data.id],
        );
        const item = found.rows[0];
        if (!item) throw new RewardError(404, "REWARD_EFFECT_NOT_FOUND", "Efek penerbitan tidak ditemukan.");
        if (item.status === "DONE") throw new RewardError(409, "REWARD_EFFECT_DONE", "Efek ini sudah terkirim.");
        await client.query(
          "UPDATE reward_outbox SET status = 'PENDING', attempts = 0, next_attempt_at = now() WHERE id = $1",
          [params.data.id],
        );
        await writeRewardAudit(client, {
          eventType: "reward.effect.retried", roundId: item.roundId, actorAccountId: actor.principal.id,
          metadata: { outboxId: params.data.id },
        });
      });
      const status = await processOutboxItem(runtime, params.data.id);
      return send(reply, 200, { id: params.data.id, status: status === "SKIPPED" ? "PENDING" : status });
    });
  });

  // -------------------------------------------------------------------------------------------
  // Employees

  app.get("/rewards/recipients", async (request, reply) => {
    if (!(await requireEmployee(request, reply))) return;
    const query = recipientsQuery.safeParse(request.query);
    if (!query.success) return invalid(reply);
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT award.id, award.month, award.category, award.category_label AS "categoryLabel",
                award.recipient_name AS "recipientName", unit.name AS "unitName", round.published_at AS "publishedAt"
           FROM reward_awards award
           JOIN reward_rounds round ON round.id = award.round_id AND round.status = 'PUBLISHED'
           JOIN reward_candidates candidate ON candidate.id = award.candidate_id
           JOIN employees employee ON employee.id = award.employee_id
           LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
          WHERE award.status = 'ACTIVE' AND ($1::text IS NULL OR award.month = $1)
          ORDER BY award.month DESC, (award.category = 'UNIT'), candidate.seat, award.category_label, award.recipient_name, award.id
          LIMIT $2 OFFSET $3`,
        [query.data.month ?? null, query.data.pageSize, pageOffset(query.data)],
      ),
      pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM reward_awards award
           JOIN reward_rounds round ON round.id = award.round_id AND round.status = 'PUBLISHED'
          WHERE award.status = 'ACTIVE' AND ($1::text IS NULL OR award.month = $1)`,
        [query.data.month ?? null],
      ),
    ]);
    return send(reply, 200, {
      items: rows.rows.map((row: Record<string, unknown>) => ({ ...row, monthLabel: monthLabel(row.month as string) })),
      pagination: pagination(query.data, total.rows[0]?.total ?? 0),
    });
  });

  app.get("/me/rewards", async (request, reply) => {
    const self = await requireEmployee(request, reply);
    if (!self) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(reply);
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT award.id, award.month, award.category, award.category_label AS "categoryLabel", award.status,
                award.revoke_reason AS "revokeReason", award.awarded_at AS "awardedAt",
                award.certificate_generated_at IS NOT NULL AS "certificateReady"
           FROM reward_awards award
          WHERE award.employee_id = $1
          ORDER BY award.month DESC, award.id
          LIMIT $2 OFFSET $3`,
        [self.employeeId, query.data.pageSize, pageOffset(query.data)],
      ),
      pool.query<{ total: number }>("SELECT count(*)::int AS total FROM reward_awards WHERE employee_id = $1", [self.employeeId]),
    ]);
    return send(reply, 200, {
      items: rows.rows.map((row: Record<string, unknown>) => ({ ...row, monthLabel: monthLabel(row.month as string) })),
      pagination: pagination(query.data, total.rows[0]?.total ?? 0),
    });
  });

  app.get("/me/rewards/:id/certificate", async (request, reply) => {
    const self = await requireEmployee(request, reply);
    if (!self) return;
    const params = idParams.safeParse(request.params);
    const notFound = { code: "REWARD_AWARD_NOT_FOUND", message: "Penghargaan tidak ditemukan." };
    if (!params.success) return send(reply, 404, notFound);
    const found = await pool.query<{ month: string; status: string; pdf: Buffer | null }>(
      `SELECT month, status, certificate_pdf AS pdf FROM reward_awards WHERE id = $1 AND employee_id = $2`,
      [params.data.id, self.employeeId],
    );
    const award = found.rows[0];
    // Someone else's award reads as missing, never as forbidden.
    if (!award || award.status !== "ACTIVE") return send(reply, 404, notFound);
    if (!award.pdf) {
      return send(reply, 409, { code: "REWARD_CERTIFICATE_NOT_READY", message: "Sertifikat sedang disiapkan. Coba lagi nanti." });
    }
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `attachment; filename="sertifikat-penghargaan-${award.month}.pdf"`);
    return reply.status(200).send(award.pdf);
  });

  // -------------------------------------------------------------------------------------------
  // Public certificate check (§9): name, category, month and validity, nothing else.

  const publicHits = new Map<string, { windowStart: number; count: number }>();
  function publicRateLimited(request: FastifyRequest): boolean {
    const at = Date.now();
    // Same client address as the employee-card check: CF-Connecting-IP first, then request.ip.
    const forwarded = request.headers["cf-connecting-ip"];
    const address = (typeof forwarded === "string" && forwarded.trim()) || request.ip || "unknown";
    const state = publicHits.get(address);
    if (!state || at - state.windowStart >= PUBLIC_RATE_WINDOW_MS) {
      if (!state && publicHits.size >= PUBLIC_RATE_MAX_KEYS) {
        for (const [entry, value] of publicHits) {
          if (at - value.windowStart >= PUBLIC_RATE_WINDOW_MS) publicHits.delete(entry);
        }
        if (publicHits.size >= PUBLIC_RATE_MAX_KEYS) publicHits.delete(publicHits.keys().next().value!);
      }
      publicHits.set(address, { windowStart: at, count: 1 });
      return false;
    }
    state.count += 1;
    return state.count > PUBLIC_RATE_LIMIT;
  }

  app.get("/public/rewards/verify/:code", async (request, reply) => {
    if (publicRateLimited(request)) {
      return send(reply, 429, { code: "RATE_LIMITED", message: "Terlalu banyak pemeriksaan. Coba lagi sebentar lagi." });
    }
    const raw = (request.params as { code?: unknown }).code;
    const code = typeof raw === "string" ? normalizeVerificationCode(raw) : null;
    const notFound = { code: "REWARD_CERTIFICATE_NOT_FOUND", message: "Kode sertifikat tidak dikenal." };
    if (!code) return send(reply, 404, notFound);
    const found = await pool.query<{ status: string; recipientName: string; categoryLabel: string; month: string }>(
      `SELECT award.status, award.recipient_name AS "recipientName", award.category_label AS "categoryLabel", award.month
         FROM reward_awards award
         JOIN reward_rounds round ON round.id = award.round_id AND round.status = 'PUBLISHED'
        WHERE award.verification_code = $1`,
      [code],
    );
    const award = found.rows[0];
    if (!award) return send(reply, 404, notFound);
    return send(reply, 200, {
      status: award.status === "ACTIVE" ? "VALID" : "REVOKED",
      recipientName: award.recipientName,
      categoryLabel: award.categoryLabel,
      month: award.month,
      monthLabel: monthLabel(award.month),
    });
  });

  return { runtime, tick: () => schedulerTick(runtime) };
}

/** §4.1 scheduler inside the API process, behind the same switch as the other runners. */
export function registerRewardScheduler(
  app: FastifyInstance,
  config: ApiConfig,
  handle: { tick: () => Promise<unknown> },
  intervalMs = 10 * 60_000,
) {
  if (config.NODE_ENV === "test" || config.MEETING_RUNNER_ENABLED !== "1") return;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;
  const run = () => {
    if (running) return;
    running = handle.tick()
      .catch((error: unknown) => app.log.error({ error: error instanceof Error ? error.name : typeof error }, "reward scheduler tick failed"))
      .finally(() => { running = null; });
  };
  app.addHook("onReady", async () => {
    timer = setInterval(run, intervalMs);
    timer.unref();
    setTimeout(run, 11_000).unref();
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    await running;
  });
}
