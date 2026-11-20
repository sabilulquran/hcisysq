import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { AuthPrincipal } from "../auth/service.js";
import {
  APPROVAL_SEAT_KEYS,
  APPROVAL_SEAT_LABELS,
  approvalSeatReadiness,
  loadApprovalSeatMappings,
  type ApprovalSeatKey,
} from "./approval-seats.js";
import { LOAN_GOVERNANCE_CAPABILITY } from "./domain.js";
import { effectiveDateOrToday, jakartaBusinessDate } from "./jakarta-date.js";
import { PostgresOrganizationRepository } from "./repository.js";
import { searchPositions } from "./structure-lookups.js";

/**
 * LOAN-002 / APR-002 — Pengaturan > Kursi persetujuan. The write path for the approval seat
 * registry (migration 0177), modelled line for line on ATT-011's Pengaturan > Aturan lembur
 * (`attendance/overtime-rule-routes.ts`): everything needs `organization.manage`, a mapping is
 * added and ended but never edited or deleted (the table's own trigger refuses it too), and both
 * are audited in `access_audit_events`.
 *
 * Two rules this module is here to hold:
 *
 * 1. **`seat_label` is derived from the published structure, never taken from the caller.** It is
 *    display text, and the whole AUTH-010-K prohibition on reading job-title text collapses if a
 *    caller can post its own label: a seat would then be named by whatever someone typed rather
 *    than by the position it points at. No route here accepts a label.
 * 2. **A mapping never starts in the past** (DRAFT, approved 2026-11-18). Approval steps are
 *    snapshotted at submission, so a backdated mapping cannot change a chain that already ran — it
 *    would only re-explain it, which is worse than refusing.
 *
 * Ending a mapping is allowed even though it stops every kasbon (employee-loans.md §16.5 D-18):
 * both writes answer with the readiness of all five seats so the screen can say what the change
 * costs before and after. The system makes sure HC knows; HC decides.
 */

type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<AuthPrincipal | null>;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);

const seatKeySchema = z.enum(APPROVAL_SEAT_KEYS);

class ApprovalSeatWriteError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "ApprovalSeatWriteError";
  }
}

const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof ApprovalSeatWriteError) {
    reply.header("Cache-Control", "no-store");
    return reply.status(error.statusCode).send({ code: error.code, message: error.message });
  }
  throw error;
}

async function audit(
  db: Pick<PoolClient, "query">,
  actorAccountId: string,
  action: string,
  entityId: string,
  payload: Record<string, unknown>,
) {
  await db.query(
    `INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload)
     VALUES ($1, $2, $3, 'organization_approval_seat', $4, $5::jsonb)`,
    [randomUUID(), actorAccountId, action, entityId, JSON.stringify(payload)],
  );
}

interface HistoryRow {
  id: string;
  seatKey: string;
  positionKey: string;
  seatLabel: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  createdByName: string | null;
  endedByName: string | null;
}

const HISTORY_QUERY = `
  SELECT seat.id, seat.seat_key AS "seatKey", seat.position_key::text AS "positionKey",
         seat.seat_label AS "seatLabel", seat.effective_from::text AS "effectiveFrom",
         seat.effective_to::text AS "effectiveTo", seat.created_at AS "createdAt",
         seat.ended_at AS "endedAt", seat.end_reason AS "endReason",
         creator.full_name AS "createdByName", ender.full_name AS "endedByName"
    FROM organization_approval_seats seat
    LEFT JOIN accounts creator_account ON creator_account.id = seat.created_by_account_id
    LEFT JOIN employees creator ON creator.id = creator_account.employee_id
    LEFT JOIN accounts ender_account ON ender_account.id = seat.ended_by_account_id
    LEFT JOIN employees ender ON ender.id = ender_account.employee_id
   ORDER BY seat.seat_key, seat.effective_from DESC, seat.created_at DESC`;

export function registerApprovalSeatRoutes(app: FastifyInstance, pool: Pool, manage: Authenticate) {
  const repository = new PostgresOrganizationRepository(pool);

  /**
   * The state of all five seats on a date, plus the full mapping history.
   *
   * Every seat in the closed set is always present, so a seat that has **never** been mapped reads
   * as `UNMAPPED` rather than being absent. That is production's opening state — all five unmapped
   * — and it is the one most likely to confuse, so it is a state the screen is handed, not a gap
   * it has to infer from a short list.
   */
  /**
   * LOAN-002 D-19: the organ accounts that are the same person as this employee, by ORG-013-1
   * butir 5's e-mail rule, so a seat they hold reads SEAT_HELD_BY_REQUESTER.
   */
  async function requesterFor(employeeId: string | undefined) {
    if (!employeeId) return undefined;
    const accounts = await pool.query<{ id: string }>(
      `SELECT organ.id
         FROM accounts organ
         JOIN employees requester ON requester.id = $1
         LEFT JOIN accounts linked
           ON linked.employee_id = requester.id AND linked.principal_type = 'EMPLOYEE'
        WHERE organ.principal_type = 'FOUNDATION_BOARD' AND organ.employee_id IS NULL
          AND NULLIF(lower(btrim(organ.email)), '') IS NOT NULL
          AND NULLIF(lower(btrim(organ.email)), '') IN (
            NULLIF(lower(btrim(requester.email)), ''), NULLIF(lower(btrim(linked.email)), '')
          )`,
      [employeeId],
    );
    return { employeeId, accountIds: accounts.rows.map((row) => row.id) };
  }

  /**
   * F2 (§16.6 prasyarat 2): which organ accounts could actually decide a loan step on `asOf` —
   * active, and holding `loans.governance.approve` at organization scope. Holding the seat is
   * never the capability (ORG-013-1), and the role is granted through the AUTH-014 channel, so a
   * seat can be perfectly mapped and occupied while every kasbon still fails.
   */
  async function capableAccounts(asOf: string, accountIds: readonly string[]): Promise<Set<string>> {
    if (accountIds.length === 0) return new Set();
    const rows = await pool.query<{ id: string }>(
      `SELECT account.id
         FROM accounts account
        WHERE account.id = ANY($1::uuid[])
          AND account.principal_type = 'FOUNDATION_BOARD'
          AND account.employee_id IS NULL
          AND account.status = 'active'
          AND EXISTS (
            SELECT 1
              FROM account_role_assignments assignment
              JOIN role_permissions grant_row ON grant_row.role_id = assignment.role_id
             WHERE assignment.account_id = account.id
               AND assignment.scope_type = 'organization'
               AND grant_row.permission_key = $2
               AND (assignment.starts_on IS NULL OR assignment.starts_on <= $3::date)
               AND (assignment.ends_on IS NULL OR assignment.ends_on >= $3::date)
          )`,
      [[...accountIds], LOAN_GOVERNANCE_CAPABILITY, asOf],
    );
    return new Set(rows.rows.map((row) => row.id));
  }

  async function readiness(asOf: string, employeeId?: string | undefined) {
    const [mappings, snapshot, requester] = await Promise.all([
      loadApprovalSeatMappings(pool, asOf),
      repository.loadEffectiveSnapshot(asOf),
      requesterFor(employeeId),
    ]);
    // Only the accounts sitting in a mapped seat matter, so this asks about those and no others.
    const mappedPositions = new Set(mappings.map((item) => item.positionKey));
    const seatAccountIds = (snapshot?.incumbencies ?? [])
      .filter((item) => mappedPositions.has(item.positionKey) && item.accountId)
      .map((item) => item.accountId!);
    const items = approvalSeatReadiness(
      mappings, snapshot, asOf, requester, await capableAccounts(asOf, seatAccountIds),
    );
    return {
      asOf,
      structurePublished: snapshot !== null,
      ready: items.every((item) => item.state === "READY"),
      /** Named so the screen can say "belum pernah dipetakan" without counting states itself. */
      neverMapped: items.filter((item) => item.state === "UNMAPPED").map((item) => item.seatKey),
      items,
    };
  }

  app.get("/admin/organization/approval-seats", async (request, reply) => {
    if (!(await manage(request, reply))) return;
    const query = z.object({
      asOf: dateSchema.optional(),
      employeeId: z.string().uuid().optional(),
    }).safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ code: "INVALID_APPROVAL_SEAT_QUERY", message: "Filter kursi persetujuan tidak valid." });
    }
    const history = await pool.query<HistoryRow>(HISTORY_QUERY);
    reply.header("Cache-Control", "no-store");
    return reply.send({
      ...(await readiness(effectiveDateOrToday(query.data.asOf), query.data.employeeId)),
      // Bounded by the closed seat set: five seats, each with the few mappings they have ever had.
      history: history.rows,
    });
  });

  /**
   * The seat picker: positions of the structure in force, by stable key. HC chooses from the chart;
   * no route here takes a job title as text, and the label stored is the one derived below.
   */
  app.get("/admin/organization/approval-seats/targets", async (request, reply) => {
    if (!(await manage(request, reply))) return;
    const query = z.object({
      q: z.string().trim().max(120).optional(),
      asOf: dateSchema.optional(),
    }).safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ code: "INVALID_APPROVAL_SEAT_QUERY", message: "Filter kursi persetujuan tidak valid." });
    }
    const asOf = effectiveDateOrToday(query.data.asOf);
    const snapshot = await repository.loadEffectiveSnapshot(asOf);
    const holderByKey = new Map(
      (snapshot?.positions ?? []).map((position) => [position.stableKey, position.holderSource ?? "EMPLOYEE"]),
    );
    const items = snapshot ? searchPositions(snapshot, { q: query.data.q, asOf, limit: 50 }) : [];
    reply.header("Cache-Control", "no-store");
    return reply.send({
      asOf,
      structurePublished: snapshot !== null,
      items: items.map((item) => ({
        key: item.stableKey,
        label: item.title,
        detail: item.unitPath.join(" › "),
        // ORG-013: an account-held seat resolves to an organ account, which also needs the loan
        // governance role. HC sees that before choosing, not after a kasbon fails.
        holderSource: holderByKey.get(item.stableKey) ?? "EMPLOYEE",
      })),
    });
  });

  /** Derives the stored label from the published structure, and proves the position is real there. */
  async function labelFor(positionKey: string, asOf: string): Promise<string> {
    const snapshot = await repository.loadEffectiveSnapshot(asOf);
    const found = snapshot
      ? searchPositions(snapshot, { asOf, limit: Number.MAX_SAFE_INTEGER })
        .find((item) => item.stableKey === positionKey)
      : undefined;
    if (!found) {
      throw new ApprovalSeatWriteError(422, "APPROVAL_SEAT_TARGET_NOT_FOUND",
        "Jabatan tidak ditemukan pada struktur yang berlaku di tanggal itu.");
    }
    return [found.title, found.unitPath.join(" › ")].filter(Boolean).join(" — ");
  }

  app.post("/admin/organization/approval-seats", async (request, reply) => {
    const principal = await manage(request, reply);
    if (!principal) return;
    // `.strict()`: a caller that tries to send `seatLabel` is refused outright rather than having
    // it quietly dropped, so the derivation above can never be bypassed unnoticed.
    const body = z.object({
      seatKey: seatKeySchema,
      positionKey: z.string().uuid(),
      effectiveFrom: dateSchema,
    }).strict().safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ code: "INVALID_APPROVAL_SEAT", message: "Kursi, jabatan, atau tanggal berlaku tidak valid." });
    }
    const id = randomUUID();
    try {
      const today = jakartaBusinessDate();
      if (body.data.effectiveFrom < today) {
        throw new ApprovalSeatWriteError(422, "APPROVAL_SEAT_DATE_IN_PAST",
          "Pemetaan kursi hanya dapat berlaku mulai hari ini atau sesudahnya.");
      }
      const seatLabel = await labelFor(body.data.positionKey, body.data.effectiveFrom);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const open = await client.query(
          `SELECT 1 FROM organization_approval_seats
            WHERE seat_key = $1 AND effective_to IS NULL FOR UPDATE`,
          [body.data.seatKey],
        );
        if (open.rows[0]) {
          throw new ApprovalSeatWriteError(409, "APPROVAL_SEAT_ALREADY_MAPPED",
            `Kursi ${APPROVAL_SEAT_LABELS[body.data.seatKey]} sudah dipetakan. Akhiri dulu pemetaan itu.`);
        }
        await client.query(
          `INSERT INTO organization_approval_seats (
             id, seat_key, position_key, seat_label, effective_from, created_by_account_id
           ) VALUES ($1, $2, $3::uuid, $4, $5::date, $6)`,
          [id, body.data.seatKey, body.data.positionKey, seatLabel, body.data.effectiveFrom, principal.id],
        );
        await audit(client, principal.id, "organization.approval_seat.mapped", id, {
          seatKey: body.data.seatKey, positionKey: body.data.positionKey, seatLabel,
          effectiveFrom: body.data.effectiveFrom,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        if ((error as { code?: string }).code === "23505") {
          throw new ApprovalSeatWriteError(409, "APPROVAL_SEAT_ALREADY_MAPPED",
            `Kursi ${APPROVAL_SEAT_LABELS[body.data.seatKey]} sudah dipetakan. Akhiri dulu pemetaan itu.`);
        }
        // F-1 (migration 0181): the new mapping's period overlaps one this seat already had —
        // an ended one, which the open-row index above cannot see. Refusing is the point: two
        // mappings in force on one date make the chain resolve to one position or the other
        // depending on row order.
        if ((error as { code?: string }).code === "23P01") {
          throw new ApprovalSeatWriteError(409, "APPROVAL_SEAT_PERIOD_OVERLAP",
            `Kursi ${APPROVAL_SEAT_LABELS[body.data.seatKey]} sudah punya pemetaan lain yang berlaku `
            + "pada rentang tanggal itu. Pilih tanggal berlaku setelah pemetaan itu berakhir.");
        }
        throw error;
      } finally {
        client.release();
      }
      reply.header("Cache-Control", "no-store");
      return reply.status(201).send({
        id, seatKey: body.data.seatKey, positionKey: body.data.positionKey, seatLabel,
        effectiveFrom: body.data.effectiveFrom, effectiveTo: null,
        // D-18: what the chain looks like after this change, so the screen can stop warning once
        // the last seat is mapped — and keep warning while one is still missing.
        readiness: await readiness(jakartaBusinessDate()),
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/admin/organization/approval-seats/:id/end", async (request, reply) => {
    const principal = await manage(request, reply);
    if (!principal) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({
      /** Last day the mapping still applies. Default: yesterday, or the day before it starts. */
      lastDay: dateSchema.optional(),
      reason: z.string().trim().min(3).max(1000),
    }).strict().safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ code: "INVALID_APPROVAL_SEAT_END", message: "Alasan mengakhiri pemetaan wajib diisi." });
    }
    let lastDay = "";
    let seatKey: ApprovalSeatKey | null = null;
    try {
      const today = jakartaBusinessDate();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query<{
          seatKey: ApprovalSeatKey; positionKey: string; seatLabel: string;
          effectiveFrom: string; effectiveTo: string | null;
        }>(
          `SELECT seat_key AS "seatKey", position_key::text AS "positionKey", seat_label AS "seatLabel",
                  effective_from::text AS "effectiveFrom", effective_to::text AS "effectiveTo"
             FROM organization_approval_seats WHERE id = $1 FOR UPDATE`,
          [params.data.id],
        );
        const mapping = current.rows[0];
        if (!mapping) throw new ApprovalSeatWriteError(404, "APPROVAL_SEAT_NOT_FOUND", "Pemetaan kursi tidak ditemukan.");
        if (mapping.effectiveTo !== null) {
          throw new ApprovalSeatWriteError(409, "APPROVAL_SEAT_ALREADY_ENDED", "Pemetaan ini sudah diakhiri.");
        }
        seatKey = mapping.seatKey;
        // F1: the earliest end is TODAY, not yesterday. A mapping that is in force today has
        // already explained every chain resolved today — a kasbon submitted at nine this morning
        // resolved against it — so ending it at `today - 1` would make the registry say the seat
        // was not in force on a day it demonstrably was. That is the same backdating the mapping
        // route refuses, arriving through the other door. The mapping stops applying from the day
        // after `lastDay`, which is the soonest it can stop without rewriting anything.
        //
        // A mapping that has not started yet keeps its "never applied" form: `effectiveFrom - 1`
        // is still >= today, so it wins the max below and the period stays empty.
        const earliest = [addDays(mapping.effectiveFrom, -1), today].sort().at(-1)!;
        lastDay = body.data.lastDay ?? earliest;
        if (lastDay < earliest) {
          throw new ApprovalSeatWriteError(422, "APPROVAL_SEAT_END_TOO_EARLY",
            `Tanggal terakhir pemetaan paling awal ${earliest}.`);
        }
        await client.query(
          `UPDATE organization_approval_seats
              SET effective_to = $2::date, ended_at = now(), ended_by_account_id = $3, end_reason = $4
            WHERE id = $1`,
          [params.data.id, lastDay, principal.id, body.data.reason],
        );
        await audit(client, principal.id, "organization.approval_seat.ended", params.data.id, {
          seatKey: mapping.seatKey, positionKey: mapping.positionKey, seatLabel: mapping.seatLabel,
          effectiveFrom: mapping.effectiveFrom, lastDay, reason: body.data.reason,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      reply.header("Cache-Control", "no-store");
      // D-18 again, and this is the direction that hurts: the day after `lastDay` this seat is
      // unmapped and every kasbon stops until it is mapped again. Reported, never blocked.
      const after = await readiness(addDays(lastDay, 1));
      return reply.send({
        id: params.data.id,
        seatKey,
        effectiveTo: lastDay,
        readiness: after,
        stopsEmployeeLoans: !after.ready,
      });
    } catch (error) {
      return fail(reply, error);
    }
  });
}
