// REWARD-001 database work shared by the routes and the scheduler: building a round from a
// snapshot (§4.1), notifying the Kepala HCM, and the publication outbox (§4.3).
// Spec: docs/domain/rewards.md.

import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { notifyAccount, notifyEmployee } from "../notifications/service.js";
import { snapshotRecipients, notifyRecipients, writeAnnouncementAudit } from "../announcements/service.js";
import { renderCertificatePdf } from "./certificate-pdf.js";
import {
  categoryLabel,
  dueMonth,
  monthLabel,
  RewardError,
  selectCandidates,
  type RewardLabel,
  type RewardScope,
  type SnapshotRow,
} from "./domain.js";
import type { MonthlyScoreboardReader, MonthlySnapshot } from "./quran-scoreboard-client.js";

type Queryable = Pool | PoolClient;

export const PROGRAM_CODE = "TILAWAH";
export const FETCH_RETRY_WINDOW_MS = 72 * 60 * 60 * 1000;
export const FETCH_RETRY_INTERVAL_MS = 60 * 60 * 1000;
const MAX_EFFECT_ATTEMPTS = 8;

export interface RewardRuntime {
  pool: Pool;
  reader: MonthlyScoreboardReader;
  /** True when no QURAN_* setting is present: the manual CSV path is open (R-14). */
  sourceConfigured: boolean;
  verifyBaseUrl: string;
  now: () => Date;
  log: { warn: (object: object, message: string) => void };
}

export async function writeRewardAudit(
  db: Queryable,
  event: {
    eventType: string;
    roundId?: string | null;
    candidateId?: string | null;
    awardId?: string | null;
    importId?: string | null;
    actorAccountId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await db.query(
    `INSERT INTO reward_audit_events (id, event_type, round_id, candidate_id, award_id, import_id, actor_account_id, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      randomUUID(), event.eventType, event.roundId ?? null, event.candidateId ?? null, event.awardId ?? null,
      event.importId ?? null, event.actorAccountId ?? null, event.reason ?? null, JSON.stringify(event.metadata ?? {}),
    ],
  );
}

export async function activeProgramId(db: Queryable): Promise<string> {
  const found = await db.query<{ id: string; active: boolean }>(
    "SELECT id, active FROM reward_programs WHERE code = $1",
    [PROGRAM_CODE],
  );
  const program = found.rows[0];
  if (!program?.active) throw new RewardError(409, "REWARD_PROGRAM_INACTIVE", "Program penghargaan Tilawah tidak aktif.");
  return program.id;
}

/** Accounts that hold reward.manage today, by role or by seat (same rule as the permission guard). */
export async function rewardManagerAccounts(db: Queryable): Promise<string[]> {
  const found = await db.query<{ accountId: string }>(
    `SELECT account.id AS "accountId"
       FROM account_role_assignments assignment
       JOIN role_permissions grant_row ON grant_row.role_id = assignment.role_id AND grant_row.permission_key = 'reward.manage'
       JOIN accounts account ON account.id = assignment.account_id
       JOIN employees holder ON holder.id = account.employee_id
      WHERE assignment.scope_type = 'organization' AND assignment.organizational_unit_id IS NULL
        AND account.principal_type = 'EMPLOYEE' AND account.status = 'active' AND holder.status = 'active'
        AND (assignment.starts_on IS NULL OR assignment.starts_on <= current_date)
        AND (assignment.ends_on IS NULL OR assignment.ends_on >= current_date)
     UNION
     SELECT seat.account_id FROM hcis_seat_permissions(current_date) seat WHERE seat.permission_key = 'reward.manage'
     ORDER BY 1`,
  );
  return found.rows.map((row) => row.accountId);
}

export async function notifyRewardManagers(
  db: Queryable,
  input: { eventKey: string; title: string; body: string; href: string },
) {
  for (const accountId of await rewardManagerAccounts(db)) {
    await notifyAccount(db, { recipientAccountId: accountId, category: "system", ...input });
  }
}

/** Unit names for hcis:org-node refs, from the published structure (today's first, else latest). */
export async function unitNames(db: Queryable, unitRefs: string[]): Promise<Map<string, string>> {
  const keys = [...new Set(unitRefs.filter(Boolean).map((ref) => ref.replace(/^hcis:org-node:/, "")))];
  if (!keys.length) return new Map();
  const found = await db.query<{ key: string; name: string }>(
    `SELECT DISTINCT ON (node.stable_key) node.stable_key::text AS key, node.name
       FROM organization_nodes node
       JOIN organization_change_sets change_set ON change_set.id = node.change_set_id AND change_set.status = 'PUBLISHED'
      WHERE node.stable_key = ANY($1::uuid[])
      ORDER BY node.stable_key, (change_set.effective_on <= current_date) DESC, change_set.effective_on DESC`,
    [keys],
  );
  return new Map(found.rows.map((row) => [`hcis:org-node:${row.key}`, row.name]));
}

interface EmployeeState {
  id: string;
  active: boolean;
}

async function employeeStates(db: Queryable, personRefs: string[]): Promise<Map<string, EmployeeState>> {
  const ids = [...new Set(personRefs.map((ref) => ref.replace(/^hcis:employee:/, "")))];
  if (!ids.length) return new Map();
  const found = await db.query<{ id: string; active: boolean }>(
    `SELECT id, (status = 'active' AND management_scope = 'MANAGED') AS active
       FROM employees WHERE id = ANY($1::uuid[]) AND removed_at IS NULL`,
    [ids],
  );
  return new Map(found.rows.map((row) => [`hcis:employee:${row.id}`, row]));
}

export function rowsFromSnapshot(snapshot: MonthlySnapshot): SnapshotRow[] {
  return snapshot.scopes.flatMap((scope) => scope.entries.map((entry) => ({
    scope: scope.scope as RewardScope,
    unitRef: scope.unitId ?? "",
    personRef: entry.personId,
    rank: entry.rank,
    pages: entry.pages,
    activeDays: entry.activeDays,
    khatam: entry.khatam,
    labels: [...new Set(entry.labels)] as RewardLabel[],
  })));
}

export interface RoundSource {
  sourceKind: "QURAN_API" | "MANUAL_IMPORT";
  importId: string | null;
  snapshotVersion: string;
  snapshotFinalizedAt: string | null;
  directoryVersion: string | null;
  directoryAsOf: string | null;
  directoryStale: boolean;
}

/**
 * §4.1 steps 2–4 inside the caller's transaction: store the snapshot (R-13), resolve people, choose
 * candidates (R-03, R-07, R-11, R-15) and record the round. The live-round unique index refuses a
 * second round for the month, so a race between the scheduler and a manual build leaves one.
 */
export async function createRound(
  client: PoolClient,
  input: { programId: string; month: string; rows: SnapshotRow[]; source: RoundSource; actorAccountId: string | null },
) {
  const roundId = randomUUID();
  await client.query(
    `INSERT INTO reward_rounds (
       id, program_id, month, status, source_kind, import_id, snapshot_version, snapshot_finalized_at,
       directory_version, directory_as_of, directory_stale, fetched_at, created_by_account_id
     ) VALUES ($1, $2, $3, 'PENDING_DECISION', $4, $5, $6, $7, $8, $9, $10, now(), $11)`,
    [
      roundId, input.programId, input.month, input.source.sourceKind, input.source.importId, input.source.snapshotVersion,
      input.source.snapshotFinalizedAt, input.source.directoryVersion, input.source.directoryAsOf, input.source.directoryStale,
      input.actorAccountId,
    ],
  ).catch((error: unknown) => {
    if ((error as { code?: string; constraint?: string }).constraint === "reward_rounds_one_live_idx") {
      throw new RewardError(409, "REWARD_ROUND_EXISTS", "Putaran untuk bulan ini sudah ada.");
    }
    throw error;
  });

  const states = await employeeStates(client, input.rows.map((row) => row.personRef));
  for (let start = 0; start < input.rows.length; start += 1000) {
    const chunk = input.rows.slice(start, start + 1000);
    await client.query(
      `INSERT INTO reward_snapshot_rows (id, round_id, scope, unit_ref, person_ref, employee_id, rank, pages, active_days, khatam, labels)
       SELECT gen_random_uuid(), $1, item.scope, item.unit_ref, item.person_ref, item.employee_id, item.rank, item.pages,
              item.active_days, item.khatam, string_to_array(item.labels, ',')::text[]
         FROM unnest($2::text[], $3::text[], $4::text[], $5::uuid[], $6::int[], $7::numeric[], $8::int[], $9::int[], $10::text[])
           AS item(scope, unit_ref, person_ref, employee_id, rank, pages, active_days, khatam, labels)`,
      [
        roundId,
        chunk.map((row) => row.scope),
        chunk.map((row) => row.unitRef),
        chunk.map((row) => row.personRef),
        chunk.map((row) => states.get(row.personRef)?.id ?? null),
        chunk.map((row) => row.rank),
        chunk.map((row) => row.pages),
        chunk.map((row) => row.activeDays),
        chunk.map((row) => row.khatam),
        chunk.map((row) => row.labels.join(",")),
      ],
    );
  }

  const seats = selectCandidates(input.rows);
  const names = await unitNames(client, seats.map((seat) => seat.unitRef));
  for (const seat of seats) {
    await insertCandidate(client, roundId, seat.category, seat.unitRef, names.get(seat.unitRef) ?? null, seat.seat, seat.row, states, null);
  }
  await writeRewardAudit(client, {
    eventType: "reward.round.created",
    roundId,
    importId: input.source.importId,
    actorAccountId: input.actorAccountId,
    metadata: {
      month: input.month,
      sourceKind: input.source.sourceKind,
      snapshotVersion: input.source.snapshotVersion,
      directoryStale: input.source.directoryStale,
      rows: input.rows.length,
      candidates: seats.length,
    },
  });
  await notifyRewardManagers(client, {
    eventKey: `reward.round.${roundId}.created`,
    title: "Kandidat penghargaan siap diputuskan",
    body: `Kandidat Penghargaan Tilawah bulan ${monthLabel(input.month)} sudah tersusun.`,
    href: `/admin/rewards?putaran=${roundId}`,
  });
  return { roundId, candidates: seats.length };
}

export async function insertCandidate(
  client: PoolClient,
  roundId: string,
  category: RewardScope,
  unitRef: string,
  unitName: string | null,
  seat: number,
  row: SnapshotRow,
  states: Map<string, EmployeeState>,
  replacesCandidateId: string | null,
) {
  const state = states.get(row.personRef);
  const unresolved = !state ? "UNKNOWN_PERSON" : !state.active ? "INACTIVE_EMPLOYEE" : null;
  const id = randomUUID();
  await client.query(
    `INSERT INTO reward_candidates (
       id, round_id, category, unit_ref, unit_name, seat, rank, pages, active_days, khatam, labels,
       person_ref, employee_id, status, unresolved_reason, replaces_candidate_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12, $13, $14, $15, $16)`,
    [
      id, roundId, category, unitRef, unitName, seat, row.rank, row.pages, row.activeDays, row.khatam, row.labels,
      row.personRef, state?.id ?? null, unresolved ? "UNRESOLVED" : "CANDIDATE", unresolved, replacesCandidateId,
    ],
  );
  return { id, unresolved };
}

export { employeeStates };

/** §4.1: build a round from the Al-Qur'an source. The network call happens outside any transaction. */
export async function buildRoundFromSource(runtime: RewardRuntime, month: string, actorAccountId: string | null) {
  const read = await runtime.reader.read(month);
  if (read.status === "NOT_CONFIGURED") {
    throw new RewardError(409, "REWARD_SOURCE_NOT_CONFIGURED", "Sumber papan skor Al-Qur'an belum tersedia. Gunakan impor snapshot manual.");
  }
  if (read.status === "NOT_FINAL") {
    throw new RewardError(409, "REWARD_PERIOD_NOT_FINAL", "Papan skor bulan ini belum final.");
  }
  if (read.status === "UNAVAILABLE") {
    runtime.log.warn({ code: `REWARD_SOURCE_${read.failure}`, httpStatus: read.httpStatus }, "Al-Qur'an scoreboard could not be read");
    throw new RewardError(409, "REWARD_SOURCE_UNAVAILABLE", "Papan skor belum bisa diambil. Coba lagi nanti.");
  }
  return inTransaction(runtime.pool, async (client) => {
    const programId = await activeProgramId(client);
    return createRound(client, {
      programId,
      month,
      rows: rowsFromSnapshot(read.snapshot),
      actorAccountId,
      source: {
        sourceKind: "QURAN_API",
        importId: null,
        snapshotVersion: read.snapshot.snapshotVersion,
        snapshotFinalizedAt: read.snapshot.finalizedAt,
        directoryVersion: read.snapshot.directory.version,
        directoryAsOf: read.snapshot.directory.asOf,
        directoryStale: read.snapshot.directory.stale,
      },
    });
  });
}

export async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------------------------
// §4.3 outbox

async function runEffect(runtime: RewardRuntime, client: PoolClient, item: { id: string; roundId: string; awardId: string | null; effect: string }) {
  if (item.effect === "ANNOUNCEMENT") {
    const round = await client.query<{ month: string; announcementId: string | null; publishedBy: string }>(
      `SELECT month, announcement_id AS "announcementId", published_by_account_id AS "publishedBy"
         FROM reward_rounds WHERE id = $1 FOR UPDATE`,
      [item.roundId],
    );
    const row = round.rows[0]!;
    if (row.announcementId) return;
    const awards = await client.query<{ categoryLabel: string; recipientName: string }>(
      `SELECT category_label AS "categoryLabel", recipient_name AS "recipientName"
         FROM reward_awards award
         JOIN reward_candidates candidate ON candidate.id = award.candidate_id
        WHERE award.round_id = $1 AND award.status = 'ACTIVE'
        ORDER BY (award.category = 'UNIT'), candidate.seat, candidate.rank, award.category_label, award.recipient_name`,
      [item.roundId],
    );
    if (!awards.rows.length) return;
    // R-12 DRAFT: names and categories only; no score is ever printed.
    const title = `Penerima Penghargaan Tilawah ${monthLabel(row.month)}`;
    const body = [
      `Alhamdulillah. Atas keistiqamahan membaca Al-Qur'an selama bulan ${monthLabel(row.month)}, yayasan memberikan penghargaan kepada:`,
      awards.rows.map((award) => `- ${award.categoryLabel}: ${award.recipientName}`).join("\n"),
      "Semoga menjadi penyemangat bagi kita semua.",
    ].join("\n\n");
    const announcementId = randomUUID();
    await client.query(
      `INSERT INTO announcements (id, title, body, level, status, published_at, created_by_account_id, published_by_account_id)
       VALUES ($1, $2, $3, 'NORMAL', 'PUBLISHED', now(), $4, $4)`,
      [announcementId, title, body, row.publishedBy],
    );
    await client.query(
      `INSERT INTO announcement_audiences (id, announcement_id, audience_kind) VALUES ($1, $2, 'ALL_EMPLOYEES')`,
      [randomUUID(), announcementId],
    );
    const reach = await snapshotRecipients(client, announcementId);
    await notifyRecipients(client, announcementId, "Pengumuman baru", title);
    await writeAnnouncementAudit(client, {
      eventType: "announcement.published",
      announcementId,
      actorAccountId: row.publishedBy,
      metadata: { reach, source: "REWARD-001", roundId: item.roundId },
    });
    await client.query("UPDATE reward_rounds SET announcement_id = $2 WHERE id = $1", [item.roundId, announcementId]);
    return;
  }

  const award = await client.query<{
    employeeId: string; status: string; month: string; categoryLabel: string; recipientName: string;
    verificationCode: string; hasPdf: boolean; issuerName: string | null;
  }>(
    `SELECT award.employee_id AS "employeeId", award.status, award.month, award.category_label AS "categoryLabel",
            award.recipient_name AS "recipientName", award.verification_code AS "verificationCode",
            award.certificate_pdf IS NOT NULL AS "hasPdf", issuer.full_name AS "issuerName"
       FROM reward_awards award
       JOIN reward_rounds round ON round.id = award.round_id
       LEFT JOIN accounts issuer_account ON issuer_account.id = round.published_by_account_id
       LEFT JOIN employees issuer ON issuer.id = issuer_account.employee_id
      WHERE award.id = $1 FOR UPDATE OF award`,
    [item.awardId],
  );
  const row = award.rows[0]!;
  // A revoked award gets neither a notification nor a certificate.
  if (row.status !== "ACTIVE") return;
  if (item.effect === "NOTIFICATION") {
    await notifyEmployee(client, row.employeeId, {
      eventKey: `reward.award.${item.awardId}`,
      category: "system",
      title: "Selamat, Anda menerima penghargaan",
      body: `${row.categoryLabel}, bulan ${monthLabel(row.month)}. Sertifikat dapat diunduh di menu Penghargaan.`,
      href: "/app/rewards",
    });
    return;
  }
  if (row.hasPdf) return;
  const pdf = renderCertificatePdf({
    recipientName: row.recipientName,
    categoryLabel: row.categoryLabel,
    monthLabel: monthLabel(row.month),
    issuerName: row.issuerName ?? "Kepala Human Capital Management",
    verificationCode: row.verificationCode,
    verifyUrl: `${runtime.verifyBaseUrl}/verifikasi/penghargaan/${row.verificationCode}`,
  });
  await client.query(
    "UPDATE reward_awards SET certificate_pdf = $2, certificate_generated_at = now() WHERE id = $1",
    [item.awardId, pdf],
  );
}

/** One effect, in its own transaction. A failure is recorded with a short code and retried later. */
export async function processOutboxItem(runtime: RewardRuntime, outboxId: string): Promise<"DONE" | "PENDING" | "FAILED" | "SKIPPED"> {
  try {
    return await inTransaction(runtime.pool, async (client) => {
      const found = await client.query<{ id: string; roundId: string; awardId: string | null; effect: string }>(
        `SELECT id, round_id AS "roundId", award_id AS "awardId", effect
           FROM reward_outbox WHERE id = $1 AND status = 'PENDING' FOR UPDATE SKIP LOCKED`,
        [outboxId],
      );
      const item = found.rows[0];
      if (!item) return "SKIPPED" as const;
      await runEffect(runtime, client, item);
      await client.query(
        "UPDATE reward_outbox SET status = 'DONE', attempts = attempts + 1, done_at = now(), last_error = NULL WHERE id = $1",
        [outboxId],
      );
      return "DONE" as const;
    });
  } catch (error) {
    const code = String((error as { code?: unknown }).code ?? (error instanceof Error ? error.name : "UNEXPECTED")).slice(0, 60);
    runtime.log.warn({ code: `REWARD_EFFECT_FAILED`, cause: code }, "reward publication effect failed");
    const updated = await runtime.pool.query<{ status: "PENDING" | "FAILED" }>(
      `UPDATE reward_outbox
          SET attempts = attempts + 1,
              last_error = $2,
              status = CASE WHEN attempts + 1 >= $3 THEN 'FAILED' ELSE 'PENDING' END,
              next_attempt_at = now() + make_interval(mins => LEAST(360, 5 * power(2, attempts)::int))
        WHERE id = $1 AND status = 'PENDING'
        RETURNING status`,
      [outboxId, code, MAX_EFFECT_ATTEMPTS],
    );
    return updated.rows[0]?.status ?? "FAILED";
  }
}

export async function processDueOutbox(runtime: RewardRuntime, roundId: string | null = null, limit = 50) {
  const due = await runtime.pool.query<{ id: string }>(
    `SELECT id FROM reward_outbox
      WHERE status = 'PENDING' AND next_attempt_at <= now() AND ($1::uuid IS NULL OR round_id = $1)
      ORDER BY (effect = 'ANNOUNCEMENT') DESC, created_at, id
      LIMIT $2`,
    [roundId, limit],
  );
  let done = 0;
  for (const item of due.rows) {
    if ((await processOutboxItem(runtime, item.id)) === "DONE") done += 1;
  }
  return done;
}

// ---------------------------------------------------------------------------------------------
// §4.1 scheduler: one pass

export async function schedulerTick(runtime: RewardRuntime): Promise<{ month: string | null; outcome: string; effects: number }> {
  const now = runtime.now();
  const month = dueMonth(now);
  let outcome = "NOT_DUE";
  if (month && runtime.sourceConfigured) outcome = await attemptMonth(runtime, month);
  else if (month) outcome = "NOT_CONFIGURED";
  const effects = await processDueOutbox(runtime);
  return { month, outcome, effects };
}

async function attemptMonth(runtime: RewardRuntime, month: string): Promise<string> {
  const programId = await activeProgramId(runtime.pool).catch(() => null);
  if (!programId) return "PROGRAM_INACTIVE";
  // Any round for the month, cancelled ones included: after a cancellation only a person rebuilds.
  const existing = await runtime.pool.query("SELECT 1 FROM reward_rounds WHERE program_id = $1 AND month = $2 LIMIT 1", [programId, month]);
  if (existing.rows.length) return "ROUND_EXISTS";
  await runtime.pool.query(
    "INSERT INTO reward_fetch_attempts (program_id, month) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [programId, month],
  );
  // Claim this hour's attempt atomically, so two processes never ask the source twice.
  const claimed = await runtime.pool.query(
    `UPDATE reward_fetch_attempts SET last_attempt_at = $3
      WHERE program_id = $1 AND month = $2 AND exhausted_at IS NULL
        AND (last_attempt_at IS NULL OR last_attempt_at <= $3::timestamptz - make_interval(secs => $4))
      RETURNING month`,
    [programId, month, runtime.now().toISOString(), FETCH_RETRY_INTERVAL_MS / 1000 - 60],
  );
  if (!claimed.rows.length) return "WAITING";
  try {
    await buildRoundFromSource(runtime, month, null);
    await runtime.pool.query(
      "UPDATE reward_fetch_attempts SET attempts = attempts + 1, last_outcome = 'CREATED' WHERE program_id = $1 AND month = $2",
      [programId, month],
    );
    return "CREATED";
  } catch (error) {
    const code = error instanceof RewardError ? error.code : "UNEXPECTED";
    if (code === "REWARD_ROUND_EXISTS") return "ROUND_EXISTS";
    if (code === "REWARD_PERIOD_NOT_FINAL") {
      await runtime.pool.query(
        "UPDATE reward_fetch_attempts SET last_outcome = 'NOT_FINAL' WHERE program_id = $1 AND month = $2",
        [programId, month],
      );
      return "NOT_FINAL";
    }
    const recorded = await runtime.pool.query<{ exhausted: boolean }>(
      `UPDATE reward_fetch_attempts
          SET attempts = attempts + 1,
              first_failure_at = COALESCE(first_failure_at, $3::timestamptz),
              last_outcome = $4,
              exhausted_at = CASE WHEN $3::timestamptz - COALESCE(first_failure_at, $3::timestamptz) >= make_interval(secs => $5)
                                  THEN $3::timestamptz ELSE NULL END
        WHERE program_id = $1 AND month = $2
        RETURNING exhausted_at IS NOT NULL AS exhausted`,
      [programId, month, runtime.now().toISOString(), code.slice(0, 40), FETCH_RETRY_WINDOW_MS / 1000],
    );
    if (recorded.rows[0]?.exhausted) {
      await notifyRewardManagers(runtime.pool, {
        eventKey: `reward.fetch.${month}.exhausted`,
        title: "Papan skor belum bisa diambil",
        body: `Papan skor Al-Qur'an bulan ${monthLabel(month)} gagal diambil selama 3 hari. Gunakan tombol Susun ulang di Penghargaan.`,
        href: "/admin/rewards",
      });
      return "EXHAUSTED";
    }
    if (!(error instanceof RewardError)) throw error;
    return "UNAVAILABLE";
  }
}

export { categoryLabel };
