// EMP-012 Package 1 routes: employee ID cards.
// Spec: docs/domain/employee-id-card.md.
//
// Three audiences. An EMPLOYEE session sees and reports its own card (/me/employee-card*).
// employee_cards.manage (HC only, never through legacy Super Admin compatibility) manages photos,
// cards and settings (/admin/employee-cards/*). Anyone holding a printed card's QR reads the check
// page without a session (/public/employee-cards/*), limited per client address.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import type { EmployeeCardPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import {
  assertIssueReason,
  CARD_FILTERS,
  decodeImage,
  EmployeeCardError,
  formatCardNumber,
  generateVerifyCode,
  invalidReason,
  ISSUE_REASONS,
  MAX_PHOTO_BYTES,
  MAX_PRINT_BATCH,
  MAX_SIGNATURE_BYTES,
  normalizeVerifyCode,
  PHOTO_CONTENT_TYPES,
  validUntil,
  wibDate,
  type CardStatus,
} from "./domain.js";

type Db = Pick<PoolClient, "query">;

/** A 2 MB photo grows by a third as base64 inside JSON; same limit as training certificates. */
const IMAGE_BODY_LIMIT = 3_500_000;
/** §5.3: per client address, per minute, for the unauthenticated check page. */
const PUBLIC_RATE_LIMIT = 30;
const PUBLIC_RATE_WINDOW_MS = 60_000;
const PUBLIC_RATE_MAX_KEYS = 5_000;

const noNul = (value: string) => !value.includes("\u0000");
const text = (min: number, max: number) => z.string().trim().min(min).max(max).refine(noNul);

const employeeParams = z.object({ employeeId: z.string().uuid() });
const cardParams = z.object({ cardId: z.string().uuid() });
const codeParams = z.object({ code: z.string().max(40) });
const optionalQuery = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  text(2, 100).optional(),
);
const listQuery = pageQuerySchema.extend({ q: optionalQuery, filter: z.enum(CARD_FILTERS).optional() });
const imageBody = z.object({
  contentType: z.enum(PHOTO_CONTENT_TYPES),
  contentBase64: z.string().min(1).max(3_000_000),
});
const signatureBody = z.object({
  contentType: z.literal("image/png"),
  contentBase64: z.string().min(1).max(800_000),
});
const issueBody = z.object({
  reason: z.enum(ISSUE_REASONS),
  note: text(1, 300).optional(),
});
const revokeBody = z.object({ reason: text(5, 300) });
const printIds = z.array(z.string().uuid()).min(1).max(MAX_PRINT_BATCH)
  .refine((ids) => new Set(ids).size === ids.length);
const printQuery = z.object({
  cardIds: z.string().max(MAX_PRINT_BATCH * 37).transform((value) => value.split(",").filter(Boolean)).pipe(printIds),
});
const printBody = z.object({ cardIds: printIds });
const settingsBody = z.object({
  signerTitle: text(1, 120),
  signerName: text(1, 120),
  validityMonths: z.number().int().min(12).max(60),
});

/** D-13: what a card freezes; blank source text counts as missing (the 0132 CHECKs refuse ''). */
const POSITION_TITLE_SQL = `coalesce(nullif(btrim(position.name), ''), nullif(btrim(employee.structural_position), ''),
  nullif(btrim(employee.functional_position), ''))`;
const UNIT_NAME_SQL = `nullif(btrim(unit.name), '')`;

/** D-14: an employee HCIS manages and who still works here. */
const EMPLOYEE_ACTIVE_SQL = `(employee.status = 'active' AND employee.removed_at IS NULL AND employee.management_scope = 'MANAGED')`;

const CARD_COLUMNS = `
  card.id, card.employee_id AS "employeeId", card.card_number AS "cardNumber", card.edition,
  card.verify_code AS "verifyCode", card.status, card.issue_reason AS "issueReason",
  card.issued_at AS "issuedAt", to_char(card.valid_until, 'YYYY-MM-DD') AS "validUntil",
  card.full_name AS "fullName", card.employee_number AS "employeeNumber",
  card.position_title AS "positionTitle", card.unit_name AS "unitName",
  card.signer_name AS "signerName", card.signer_title AS "signerTitle",
  card.print_count AS "printCount", card.last_printed_at AS "lastPrintedAt",
  card.ended_at AS "endedAt", card.end_reason AS "endReason"`;

interface CardRow {
  id: string;
  employeeId: string;
  cardNumber: string;
  edition: number;
  verifyCode: string;
  status: CardStatus;
  issueReason: string;
  issuedAt: Date;
  validUntil: string;
  fullName: string;
  employeeNumber: string;
  positionTitle: string | null;
  unitName: string | null;
  signerName: string;
  signerTitle: string;
  printCount: number;
  lastPrintedAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
}

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

function sendImage(reply: FastifyReply, contentType: string, encrypted: { ciphertext: string; iv: string; tag: string }, key: string) {
  const base64 = decryptSecret(encrypted, key);
  reply.header("Cache-Control", "private, no-store");
  reply.header("Content-Type", contentType);
  reply.header("Content-Disposition", "inline");
  return reply.send(Buffer.from(base64, "base64"));
}

async function writeCardAudit(
  db: Db,
  event: {
    eventType: string;
    employeeId?: string | null;
    cardId?: string | null;
    actorAccountId: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  // clock_timestamp keeps the order of several events written in one transaction.
  await db.query(
    `INSERT INTO employee_card_audit_events (id, event_type, employee_id, card_id, actor_account_id, reason, metadata, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb, clock_timestamp())`,
    [
      randomUUID(), event.eventType, event.employeeId ?? null, event.cardId ?? null,
      event.actorAccountId, event.reason ?? null, JSON.stringify(event.metadata ?? {}),
    ],
  );
}

/** §7: audit metadata names the card, never the person. */
function cardMetadata(card: { cardNumber: string; edition: number }, extra: Record<string, unknown> = {}) {
  return { cardNumber: card.cardNumber, edition: card.edition, ...extra };
}

/** D-08 for one stored card, evaluated now in WIB. */
function withValidity<T extends { status: CardStatus; validUntil: string }>(card: T, employeeActive: boolean, today: string) {
  return { ...card, invalidReason: invalidReason({ ...card, employeeActive }, today) };
}

type Facts = { fullName: string; employeeNumber: string; positionTitle: string | null; unitName: string | null };

/** Today's facts for a card, read with the same position and unit rules as the admin list. */
async function loadCardFacts(db: Db, employeeId: string) {
  const found = await db.query<Facts & { id: string; status: string }>(
    `SELECT employee.id, employee.employee_number AS "employeeNumber", employee.full_name AS "fullName", employee.status,
            ${POSITION_TITLE_SQL} AS "positionTitle", ${UNIT_NAME_SQL} AS "unitName"
       FROM employees employee
       LEFT JOIN positions position ON position.id = employee.position_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
      WHERE employee.id = $1`,
    [employeeId],
  );
  return found.rows[0] ?? null;
}

const blankToNull = (value: string | null) => (value && value.trim() ? value.trim() : null);

/** D-13: the facts a card freezes, in the shape the 0132 CHECKs accept; anything else is a clear 409. */
function frozenFacts(facts: Facts) {
  const frozen = {
    fullName: facts.fullName.trim(),
    employeeNumber: facts.employeeNumber.trim(),
    positionTitle: blankToNull(facts.positionTitle),
    unitName: blankToNull(facts.unitName),
  };
  if (!frozen.fullName || frozen.fullName.length > 200 || !frozen.employeeNumber || frozen.employeeNumber.length > 60
    || (frozen.positionTitle?.length ?? 0) > 200 || (frozen.unitName?.length ?? 0) > 200) {
    throw new EmployeeCardError(
      409, "EMPLOYEE_CARD_DATA_INVALID",
      "Nama (maks 200 karakter), NIP (maks 60), jabatan, atau unit pegawai tidak dapat dicetak. Perbaiki data pegawai dulu.",
    );
  }
  return frozen;
}

/** D-13: whether today's employee facts differ from what the card froze. */
function dataChanged(card: Pick<CardRow, "fullName" | "employeeNumber" | "positionTitle" | "unitName">, facts: Facts) {
  return card.fullName !== facts.fullName.trim() || card.employeeNumber !== facts.employeeNumber.trim()
    || (card.positionTitle ?? null) !== blankToNull(facts.positionTitle) || (card.unitName ?? null) !== blankToNull(facts.unitName);
}

export async function registerEmployeeCardRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession" | "getAuthorizationContext">,
  now: () => Date = () => new Date(),
) {
  const encryptionKey = config.AUTH_ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error("AUTH_ENCRYPTION_KEY is required for employee card routes");
  const key: string = encryptionKey;
  const auth = injectedAuth ?? new AuthService(
    pool, key, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production",
  );

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    return session.principal;
  }

  async function requireEmployee(request: FastifyRequest, reply: FastifyReply) {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    if (principal.principalType !== "EMPLOYEE") {
      await send(reply, 403, { code: "FORBIDDEN", message: "Kartu Pegawai hanya tersedia untuk pegawai." });
      return null;
    }
    return principal;
  }

  async function requirePermission(request: FastifyRequest, reply: FastifyReply, permission: EmployeeCardPermission) {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    const context = await auth.getAuthorizationContext(principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, { code: "EMPLOYEE_CARD_FORBIDDEN", message: "Anda tidak memiliki akses untuk mengelola Kartu Pegawai." });
      return null;
    }
    return principal;
  }

  function handleError(reply: FastifyReply, error: unknown) {
    if (error instanceof EmployeeCardError) return send(reply, error.statusCode, { code: error.code, message: error.message });
    throw error;
  }

  /** Runs `work` in one transaction and answers only after COMMIT succeeded. */
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

  const cardNotFound = () => new EmployeeCardError(404, "EMPLOYEE_CARD_NOT_FOUND", "Kartu pegawai tidak ditemukan.");

  /** The employee behind an EMPLOYEE session, active or not: a former employee still sees why the card fails. */
  async function selfEmployeeId(db: Db, accountId: string): Promise<string | null> {
    const found = await db.query<{ id: string }>(
      `SELECT employee.id
         FROM accounts account
         JOIN employees employee ON employee.id = account.employee_id
        WHERE account.id = $1 AND account.principal_type = 'EMPLOYEE' AND account.status = 'active'
          AND employee.removed_at IS NULL`,
      [accountId],
    );
    return found.rows[0]?.id ?? null;
  }

  async function employeeActive(db: Db, employeeId: string): Promise<boolean> {
    const found = await db.query<{ active: boolean }>(
      `SELECT ${EMPLOYEE_ACTIVE_SQL} AS active FROM employees employee WHERE employee.id = $1`,
      [employeeId],
    );
    return found.rows[0]?.active ?? false;
  }

  /** The card an employee holds now: the ACTIVE one, else the most recent edition. */
  async function latestCard(db: Db, employeeId: string): Promise<CardRow | null> {
    const found = await db.query<CardRow>(
      `SELECT ${CARD_COLUMNS} FROM employee_cards card
        WHERE card.employee_id = $1
        ORDER BY (card.status = 'ACTIVE') DESC, card.edition DESC
        LIMIT 1`,
      [employeeId],
    );
    return found.rows[0] ?? null;
  }

  async function settings(db: Db) {
    const found = await db.query<{
      signerTitle: string; signerName: string | null; validityMonths: number;
      hasSignature: boolean; updatedAt: Date;
    }>(
      `SELECT signer_title AS "signerTitle", signer_name AS "signerName", validity_months AS "validityMonths",
              (signature_ciphertext IS NOT NULL) AS "hasSignature", updated_at AS "updatedAt"
         FROM employee_card_settings WHERE id = 1`,
    );
    const row = found.rows[0];
    if (!row) throw new Error("employee_card_settings row is missing (migration 0132)");
    return row;
  }

  async function sendSignature(reply: FastifyReply) {
    const found = await pool.query<{ contentType: string; ciphertext: string; iv: string; tag: string }>(
      `SELECT signature_content_type AS "contentType", signature_ciphertext AS ciphertext,
              signature_iv AS iv, signature_auth_tag AS tag
         FROM employee_card_settings WHERE id = 1 AND signature_ciphertext IS NOT NULL`,
    );
    const row = found.rows[0];
    if (!row) return send(reply, 404, { code: "EMPLOYEE_CARD_SIGNATURE_NOT_FOUND", message: "Gambar tanda tangan belum diunggah." });
    return sendImage(reply, row.contentType, row, key);
  }

  async function sendCardPhoto(reply: FastifyReply, cardId: string) {
    const found = await pool.query<{ contentType: string; ciphertext: string; iv: string; tag: string }>(
      `SELECT photo.content_type AS "contentType", photo.ciphertext, photo.iv, photo.auth_tag AS tag
         FROM employee_cards card
         JOIN employee_card_photos photo ON photo.id = card.photo_id
        WHERE card.id = $1`,
      [cardId],
    );
    const row = found.rows[0];
    if (!row) return send(reply, 404, { code: "EMPLOYEE_CARD_PHOTO_NOT_FOUND", message: "Foto kartu tidak ditemukan." });
    return sendImage(reply, row.contentType, row, key);
  }

  // ---------------------------------------------------------------- public

  // §5.3: one fixed window per client address, kept in this process only. trustProxy makes
  // request.ip the address the edge saw.
  const publicHits = new Map<string, { windowStart: number; count: number }>();
  function publicRateLimited(request: FastifyRequest): boolean {
    const at = Date.now();
    // Cloudflare sets CF-Connecting-IP itself. The Mi8 edge proxy also rewrites X-Forwarded-For to
    // that address, so request.ip (trustProxy) is the client too; a client-written X-Forwarded-For
    // never reaches the API through the edge.
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

  async function publicCard(request: FastifyRequest, reply: FastifyReply) {
    if (publicRateLimited(request)) {
      await send(reply, 429, { code: "RATE_LIMITED", message: "Terlalu banyak pemeriksaan. Coba lagi sebentar lagi." });
      return null;
    }
    const params = codeParams.safeParse(request.params);
    const code = params.success ? normalizeVerifyCode(params.data.code) : null;
    const found = code
      ? await pool.query<CardRow & { employeeActive: boolean }>(
        `SELECT ${CARD_COLUMNS}, ${EMPLOYEE_ACTIVE_SQL} AS "employeeActive"
           FROM employee_cards card
           JOIN employees employee ON employee.id = card.employee_id
          WHERE card.verify_code = $1`,
        [code],
      )
      : null;
    const card = found?.rows[0];
    if (!card) {
      await send(reply, 404, { code: "EMPLOYEE_CARD_NOT_FOUND", message: "Kode kartu tidak dikenal." });
      return null;
    }
    return { card, reason: invalidReason(card, wibDate(now())) };
  }

  app.get("/public/employee-cards/:code", async (request, reply) => {
    const found = await publicCard(request, reply);
    if (!found) return;
    const { card, reason } = found;
    const checkedAt = now().toISOString();
    // D-11 and EMP-012-E: a card that does not verify shows no name and no photo; NIP never shows.
    if (reason) {
      return send(reply, 200, {
        valid: false,
        reason,
        cardNumber: card.cardNumber,
        edition: card.edition,
        validUntil: card.validUntil,
        invalidSince: reason === "EXPIRED" ? card.validUntil : card.endedAt,
        checkedAt,
      });
    }
    return send(reply, 200, {
      valid: true,
      cardNumber: card.cardNumber,
      edition: card.edition,
      validUntil: card.validUntil,
      fullName: card.fullName,
      positionTitle: card.positionTitle,
      unitName: card.unitName,
      checkedAt,
    });
  });

  app.get("/public/employee-cards/:code/photo", async (request, reply) => {
    const found = await publicCard(request, reply);
    if (!found) return;
    if (found.reason) return send(reply, 404, { code: "EMPLOYEE_CARD_PHOTO_NOT_FOUND", message: "Foto kartu tidak ditemukan." });
    return sendCardPhoto(reply, found.card.id);
  });

  // ---------------------------------------------------------------- employee

  app.get("/me/employee-card", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const employeeId = await selfEmployeeId(pool, principal.id);
    if (!employeeId) return send(reply, 404, { code: "EMPLOYEE_CARD_NOT_FOUND", message: "Akun tidak terhubung ke data pegawai." });
    const [card, active, current] = await Promise.all([latestCard(pool, employeeId), employeeActive(pool, employeeId), settings(pool)]);
    if (!card) return send(reply, 200, { card: null, hasSignature: current.hasSignature });
    // The employee already knows their own NIP; the public check page never sees it.
    return send(reply, 200, { card: withValidity(card, active, wibDate(now())), hasSignature: current.hasSignature });
  });

  app.get("/me/employee-card/photo", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const employeeId = await selfEmployeeId(pool, principal.id);
    const card = employeeId ? await latestCard(pool, employeeId) : null;
    if (!card) return send(reply, 404, { code: "EMPLOYEE_CARD_PHOTO_NOT_FOUND", message: "Foto kartu tidak ditemukan." });
    return sendCardPhoto(reply, card.id);
  });

  app.get("/me/employee-card/signature", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    return sendSignature(reply);
  });

  // D-10: the holder can switch the card off at once; HC then reissues.
  app.post("/me/employee-card/report-lost", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    return inTransaction(reply, 200, async (client) => {
      const employeeId = await selfEmployeeId(client, principal.id);
      if (!employeeId) throw cardNotFound();
      const found = await client.query<CardRow>(
        `SELECT ${CARD_COLUMNS} FROM employee_cards card WHERE card.employee_id = $1 AND card.status = 'ACTIVE' FOR UPDATE`,
        [employeeId],
      );
      const card = found.rows[0];
      if (!card) {
        throw new EmployeeCardError(409, "EMPLOYEE_CARD_INVALID_TRANSITION", "Tidak ada kartu aktif yang dapat dilaporkan hilang.");
      }
      await client.query(
        `UPDATE employee_cards
            SET status = 'REPORTED_LOST', ended_at = now(), end_reason = 'Dilaporkan hilang oleh pegawai',
                ended_by_account_id = $2, updated_at = now()
          WHERE id = $1`,
        [card.id, principal.id],
      );
      await writeCardAudit(client, {
        eventType: "employee_card.reported_lost", employeeId, cardId: card.id, actorAccountId: principal.id,
        metadata: cardMetadata(card),
      });
      return { id: card.id, status: "REPORTED_LOST" };
    });
  });

  // ---------------------------------------------------------------- admin

  app.get("/admin/employee-cards", async (request, reply) => {
    if (!(await requirePermission(request, reply, "employee_cards.manage"))) return;
    const query = listQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_CARD_FILTER", message: "Pencarian atau filter tidak valid." });
    const values: unknown[] = [];
    const add = (value: unknown) => `$${values.push(value)}`;
    // Today's WIB date is bound only where a query uses it, so the count query never carries an
    // unused parameter.
    let todayRef: string | null = null;
    const today = () => (todayRef ??= add(wibDate(now())));
    // Population: employees HCIS manages who either work here or still hold an ACTIVE card that
    // HC must revoke.
    const where = [
      "employee.removed_at IS NULL",
      "employee.management_scope = 'MANAGED'",
      "(employee.status = 'active' OR latest.status = 'ACTIVE')",
    ];
    if (query.data.q) {
      const pattern = `%${query.data.q.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
      const placeholder = add(pattern);
      where.push(`(employee.full_name ILIKE ${placeholder} OR employee.employee_number ILIKE ${placeholder})`);
    }
    const valid = () => `(latest.status = 'ACTIVE' AND latest.valid_until >= ${today()}::date AND ${EMPLOYEE_ACTIVE_SQL})`;
    if (query.data.filter === "NO_PHOTO") where.push("photo.id IS NULL");
    if (query.data.filter === "NO_CARD") where.push("latest.id IS NULL");
    if (query.data.filter === "ACTIVE") where.push(valid());
    if (query.data.filter === "NEEDS_REISSUE") where.push(`(latest.id IS NOT NULL AND NOT ${valid()})`);
    const from = `
      FROM employees employee
      LEFT JOIN positions position ON position.id = employee.position_id
      LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
      LEFT JOIN employee_card_photos photo ON photo.employee_id = employee.id AND photo.replaced_at IS NULL
      LEFT JOIN LATERAL (
        SELECT card.* FROM employee_cards card
         WHERE card.employee_id = employee.id
         ORDER BY (card.status = 'ACTIVE') DESC, card.edition DESC
         LIMIT 1
      ) latest ON true
      WHERE ${where.join(" AND ")}`;
    const filterValues = [...values];
    const itemToday = today();
    const limit = add(query.data.pageSize);
    const offset = add(pageOffset(query.data));
    // ENG-LIST-001: filters run before LIMIT, and total counts the same filter.
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT employee.id AS "employeeId", employee.employee_number AS "employeeNumber",
                employee.full_name AS "fullName", employee.status AS "employeeStatus",
                ${POSITION_TITLE_SQL} AS "positionTitle",
                ${UNIT_NAME_SQL} AS "unitName",
                (photo.id IS NOT NULL) AS "hasPhoto", photo.created_at AS "photoUploadedAt",
                CASE WHEN latest.id IS NULL THEN NULL ELSE json_build_object(
                  'id', latest.id, 'cardNumber', latest.card_number, 'edition', latest.edition,
                  'status', latest.status, 'validUntil', to_char(latest.valid_until, 'YYYY-MM-DD'),
                  'printCount', latest.print_count,
                  'invalidReason', CASE
                    WHEN latest.status <> 'ACTIVE' THEN latest.status
                    WHEN latest.valid_until < ${itemToday}::date THEN 'EXPIRED'
                    WHEN NOT ${EMPLOYEE_ACTIVE_SQL} THEN 'EMPLOYEE_INACTIVE'
                    ELSE NULL END,
                  'dataChanged', (latest.full_name <> employee.full_name
                    OR latest.employee_number <> employee.employee_number
                    OR latest.position_title IS DISTINCT FROM ${POSITION_TITLE_SQL}
                    OR latest.unit_name IS DISTINCT FROM ${UNIT_NAME_SQL})
                ) END AS card
         ${from}
         ORDER BY employee.full_name, employee.id
         LIMIT ${limit} OFFSET ${offset}`,
        values,
      ),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total ${from}`, filterValues),
    ]);
    return send(reply, 200, { items: items.rows, pagination: pagination(query.data, count.rows[0]?.total ?? 0) });
  });

  app.get("/admin/employee-cards/employees/:employeeId", async (request, reply) => {
    if (!(await requirePermission(request, reply, "employee_cards.manage"))) return;
    const params = employeeParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_ID", message: "Pegawai tidak valid." });
    const facts = await loadCardFacts(pool, params.data.employeeId);
    if (!facts) return send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
    const today = wibDate(now());
    const [photo, cards, active] = await Promise.all([
      pool.query(
        `SELECT id, content_type AS "contentType", byte_size AS "byteSize", created_at AS "uploadedAt"
           FROM employee_card_photos WHERE employee_id = $1 AND replaced_at IS NULL`,
        [facts.id],
      ),
      // §9.1: one employee gains one card per issue, so the history is bounded by its nature.
      pool.query<CardRow>(
        `SELECT ${CARD_COLUMNS} FROM employee_cards card WHERE card.employee_id = $1 ORDER BY card.edition DESC`,
        [facts.id],
      ),
      employeeActive(pool, facts.id),
    ]);
    return send(reply, 200, {
      employee: {
        id: facts.id,
        employeeNumber: facts.employeeNumber,
        fullName: facts.fullName,
        status: facts.status,
        active,
        positionTitle: facts.positionTitle,
        unitName: facts.unitName,
      },
      photo: photo.rows[0] ?? null,
      cards: cards.rows.map((card) => ({ ...withValidity(card, active, today), dataChanged: dataChanged(card, facts) })),
    });
  });

  app.get("/admin/employee-cards/employees/:employeeId/photo", async (request, reply) => {
    if (!(await requirePermission(request, reply, "employee_cards.manage"))) return;
    const params = employeeParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_ID", message: "Pegawai tidak valid." });
    const found = await pool.query<{ contentType: string; ciphertext: string; iv: string; tag: string }>(
      `SELECT content_type AS "contentType", ciphertext, iv, auth_tag AS tag
         FROM employee_card_photos WHERE employee_id = $1 AND replaced_at IS NULL`,
      [params.data.employeeId],
    );
    const row = found.rows[0];
    if (!row) return send(reply, 404, { code: "EMPLOYEE_CARD_PHOTO_NOT_FOUND", message: "Foto belum diunggah." });
    return sendImage(reply, row.contentType, row, key);
  });

  app.put("/admin/employee-cards/employees/:employeeId/photo", { bodyLimit: IMAGE_BODY_LIMIT }, async (request, reply) => {
    const principal = await requirePermission(request, reply, "employee_cards.manage");
    if (!principal) return;
    const params = employeeParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_ID", message: "Pegawai tidak valid." });
    const body = imageBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_CARD_IMAGE", message: "Foto harus JPEG atau PNG." });
    return inTransaction(reply, 200, async (client) => {
      const employee = await client.query<{ id: string }>(
        `SELECT id FROM employees WHERE id = $1 AND removed_at IS NULL AND management_scope = 'MANAGED' FOR UPDATE`,
        [params.data.employeeId],
      );
      if (!employee.rows[0]) throw new EmployeeCardError(404, "EMPLOYEE_NOT_FOUND", "Pegawai tidak ditemukan.");
      const bytes = decodeImage(body.data.contentType, body.data.contentBase64, MAX_PHOTO_BYTES, "Foto");
      const encrypted = encryptSecret(bytes.toString("base64"), key);
      const id = randomUUID();
      // D-03: the previous photo stays stored, and issued cards keep pointing at their own.
      await client.query(
        `UPDATE employee_card_photos SET replaced_at = now() WHERE employee_id = $1 AND replaced_at IS NULL`,
        [params.data.employeeId],
      );
      await client.query(
        `INSERT INTO employee_card_photos
           (id, employee_id, content_type, byte_size, sha256, ciphertext, iv, auth_tag, uploaded_by_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id, params.data.employeeId, body.data.contentType, bytes.length,
          createHash("sha256").update(bytes).digest("hex"),
          encrypted.ciphertext, encrypted.iv, encrypted.tag, principal.id,
        ],
      );
      await writeCardAudit(client, {
        eventType: "employee_card.photo.uploaded", employeeId: params.data.employeeId, actorAccountId: principal.id,
        metadata: { photoId: id, contentType: body.data.contentType, byteSize: bytes.length },
      });
      return { id, contentType: body.data.contentType, byteSize: bytes.length };
    });
  });

  app.post("/admin/employee-cards/employees/:employeeId/cards", async (request, reply) => {
    const principal = await requirePermission(request, reply, "employee_cards.manage");
    if (!principal) return;
    const params = employeeParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_ID", message: "Pegawai tidak valid." });
    const body = issueBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_CARD_ISSUE", message: "Alasan penerbitan tidak valid." });
    return inTransaction(reply, 201, async (client) => {
      // The employee row lock serialises two HC admins issuing for the same person.
      const locked = await client.query<{ active: boolean }>(
        `SELECT ${EMPLOYEE_ACTIVE_SQL} AS active FROM employees employee WHERE employee.id = $1 FOR UPDATE`,
        [params.data.employeeId],
      );
      if (!locked.rows[0]) throw new EmployeeCardError(404, "EMPLOYEE_NOT_FOUND", "Pegawai tidak ditemukan.");
      if (!locked.rows[0].active) {
        throw new EmployeeCardError(409, "EMPLOYEE_CARD_EMPLOYEE_INACTIVE", "Kartu hanya dapat diterbitkan untuk pegawai aktif.");
      }
      const facts = await loadCardFacts(client, params.data.employeeId);
      if (!facts) throw new EmployeeCardError(404, "EMPLOYEE_NOT_FOUND", "Pegawai tidak ditemukan.");
      const photo = await client.query<{ id: string }>(
        `SELECT id FROM employee_card_photos WHERE employee_id = $1 AND replaced_at IS NULL`,
        [facts.id],
      );
      if (!photo.rows[0]) {
        throw new EmployeeCardError(409, "EMPLOYEE_CARD_PHOTO_MISSING", "Unggah pas foto pegawai sebelum menerbitkan kartu.");
      }
      const current = await settings(client);
      if (!current.signerName) {
        throw new EmployeeCardError(409, "EMPLOYEE_CARD_SIGNER_MISSING", "Isi nama penanda tangan di Pengaturan sebelum menerbitkan kartu.");
      }
      // FOR UPDATE: a revoke or a lost report on the ACTIVE card waits, so its status is never overwritten.
      const previous = await client.query<CardRow>(
        `SELECT ${CARD_COLUMNS} FROM employee_cards card WHERE card.employee_id = $1 ORDER BY card.edition DESC FOR UPDATE`,
        [facts.id],
      );
      const activeCard = previous.rows.find((card) => card.status === "ACTIVE") ?? null;
      assertIssueReason(body.data.reason, activeCard !== null, previous.rows.length > 0);
      const frozen = frozenFacts(facts);

      const issuedAt = now();
      const issuedOn = wibDate(issuedAt);
      if (activeCard) {
        await client.query(
          `UPDATE employee_cards
              SET status = 'REPLACED', ended_at = $2, end_reason = $3, ended_by_account_id = $4, updated_at = now()
            WHERE id = $1 AND status = 'ACTIVE'`,
          [activeCard.id, issuedAt, `Diganti: ${body.data.reason}`, principal.id],
        );
        await writeCardAudit(client, {
          eventType: "employee_card.replaced", employeeId: facts.id, cardId: activeCard.id, actorAccountId: principal.id,
          reason: body.data.note ?? null, metadata: cardMetadata(activeCard, { replacedBecause: body.data.reason }),
        });
      }
      const sequence = await client.query<{ value: string }>(`SELECT nextval('employee_card_number_seq')::text AS value`);
      const id = randomUUID();
      const card = {
        cardNumber: formatCardNumber(issuedOn, Number(sequence.rows[0]!.value)),
        edition: (previous.rows[0]?.edition ?? 0) + 1,
        validUntil: validUntil(issuedOn, current.validityMonths),
      };
      // D-07: a collision among 2^50 codes is practically impossible; draw again if one is taken.
      // The unique index still guards the rare race between the check and the insert.
      let verifyCode = generateVerifyCode();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const taken = await client.query("SELECT 1 FROM employee_cards WHERE verify_code = $1", [verifyCode]);
        if (!taken.rows[0]) break;
        verifyCode = generateVerifyCode();
      }
      await client.query(
        `INSERT INTO employee_cards
           (id, employee_id, card_number, edition, verify_code, status, issue_reason, issued_at, valid_until,
            photo_id, full_name, employee_number, position_title, unit_name, signer_name, signer_title,
            issued_by_account_id)
         VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          id, facts.id, card.cardNumber, card.edition, verifyCode, body.data.reason, issuedAt, card.validUntil,
          photo.rows[0].id, frozen.fullName, frozen.employeeNumber, frozen.positionTitle, frozen.unitName,
          current.signerName, current.signerTitle, principal.id,
        ],
      );
      await writeCardAudit(client, {
        eventType: "employee_card.issued", employeeId: facts.id, cardId: id, actorAccountId: principal.id,
        reason: body.data.note ?? null, metadata: cardMetadata(card, { issueReason: body.data.reason, validUntil: card.validUntil }),
      });
      return { id, ...card, status: "ACTIVE", replacedCardId: activeCard?.id ?? null };
    });
  });

  app.post("/admin/employee-cards/cards/:cardId/revoke", async (request, reply) => {
    const principal = await requirePermission(request, reply, "employee_cards.manage");
    if (!principal) return;
    const params = cardParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_CARD_ID", message: "Kartu tidak valid." });
    const body = revokeBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_CARD_REVOKE", message: "Alasan pencabutan wajib 5–300 karakter." });
    return inTransaction(reply, 200, async (client) => {
      const found = await client.query<CardRow>(
        `SELECT ${CARD_COLUMNS} FROM employee_cards card WHERE card.id = $1 FOR UPDATE`,
        [params.data.cardId],
      );
      const card = found.rows[0];
      if (!card) throw cardNotFound();
      if (card.status !== "ACTIVE" && card.status !== "REPORTED_LOST") {
        throw new EmployeeCardError(409, "EMPLOYEE_CARD_INVALID_TRANSITION", "Kartu ini sudah tidak aktif.");
      }
      // A card reported lost keeps its ended_at; revoking only records HC's decision on top of it.
      await client.query(
        `UPDATE employee_cards
            SET status = 'REVOKED', ended_at = coalesce(ended_at, now()), end_reason = $2,
                ended_by_account_id = $3, updated_at = now()
          WHERE id = $1`,
        [card.id, body.data.reason, principal.id],
      );
      await writeCardAudit(client, {
        eventType: "employee_card.revoked", employeeId: card.employeeId, cardId: card.id, actorAccountId: principal.id,
        reason: body.data.reason, metadata: cardMetadata(card, { previousStatus: card.status }),
      });
      return { id: card.id, status: "REVOKED" };
    });
  });

  app.get("/admin/employee-cards/cards/:cardId/photo", async (request, reply) => {
    if (!(await requirePermission(request, reply, "employee_cards.manage"))) return;
    const params = cardParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_CARD_ID", message: "Kartu tidak valid." });
    return sendCardPhoto(reply, params.data.cardId);
  });

  app.get("/admin/employee-cards/print", async (request, reply) => {
    if (!(await requirePermission(request, reply, "employee_cards.manage"))) return;
    const query = printQuery.safeParse(request.query);
    if (!query.success) {
      return send(reply, 400, { code: "INVALID_EMPLOYEE_CARD_PRINT", message: `Pilih 1–${MAX_PRINT_BATCH} kartu berbeda untuk dicetak.` });
    }
    const [found, current] = await Promise.all([
      // Only cards that verify today: printing an expired card, or one of a former employee, is a mistake.
      pool.query<CardRow>(
        `SELECT ${CARD_COLUMNS}
           FROM employee_cards card
           JOIN employees employee ON employee.id = card.employee_id
          WHERE card.id = ANY($1::uuid[]) AND card.status = 'ACTIVE' AND card.valid_until >= $2::date
            AND ${EMPLOYEE_ACTIVE_SQL}`,
        [query.data.cardIds, wibDate(now())],
      ),
      settings(pool),
    ]);
    // Keep the order HC chose; a card that does not verify is reported, never silently dropped.
    const byId = new Map(found.rows.map((card) => [card.id, card]));
    return send(reply, 200, {
      items: query.data.cardIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
      unavailableCardIds: query.data.cardIds.filter((id) => !byId.has(id)),
      hasSignature: current.hasSignature,
    });
  });

  // D-12: pressing Cetak records each card of the batch.
  app.post("/admin/employee-cards/print", async (request, reply) => {
    const principal = await requirePermission(request, reply, "employee_cards.manage");
    if (!principal) return;
    const body = printBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, { code: "INVALID_EMPLOYEE_CARD_PRINT", message: `Pilih 1–${MAX_PRINT_BATCH} kartu berbeda untuk dicetak.` });
    }
    return inTransaction(reply, 200, async (client) => {
      const updated = await client.query<{ id: string; employeeId: string; cardNumber: string; edition: number; printCount: number }>(
        `UPDATE employee_cards
            SET print_count = print_count + 1, last_printed_at = now(), updated_at = now()
          WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'
          RETURNING id, employee_id AS "employeeId", card_number AS "cardNumber", edition, print_count AS "printCount"`,
        [body.data.cardIds],
      );
      if (updated.rows.length !== body.data.cardIds.length) {
        throw new EmployeeCardError(409, "EMPLOYEE_CARD_INVALID_TRANSITION", "Sebagian kartu sudah tidak aktif. Muat ulang halaman cetak.");
      }
      for (const card of updated.rows) {
        await writeCardAudit(client, {
          eventType: "employee_card.printed", employeeId: card.employeeId, cardId: card.id, actorAccountId: principal.id,
          metadata: cardMetadata(card, { printCount: card.printCount, batchSize: updated.rows.length }),
        });
      }
      return { printed: updated.rows.map((card) => ({ id: card.id, printCount: card.printCount })) };
    });
  });

  app.get("/admin/employee-cards/settings", async (request, reply) => {
    if (!(await requirePermission(request, reply, "employee_cards.manage"))) return;
    return send(reply, 200, await settings(pool));
  });

  app.put("/admin/employee-cards/settings", async (request, reply) => {
    const principal = await requirePermission(request, reply, "employee_cards.manage");
    if (!principal) return;
    const body = settingsBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, { code: "INVALID_EMPLOYEE_CARD_SETTINGS", message: "Isi jabatan dan nama penanda tangan, serta masa berlaku 12–60 bulan." });
    }
    return inTransaction(reply, 200, async (client) => {
      const before = await client.query<{ signerTitle: string; signerName: string | null; validityMonths: number }>(
        `SELECT signer_title AS "signerTitle", signer_name AS "signerName", validity_months AS "validityMonths"
           FROM employee_card_settings WHERE id = 1 FOR UPDATE`,
      );
      await client.query(
        `UPDATE employee_card_settings
            SET signer_title = $1, signer_name = $2, validity_months = $3, updated_by_account_id = $4, updated_at = now()
          WHERE id = 1`,
        [body.data.signerTitle, body.data.signerName, body.data.validityMonths, principal.id],
      );
      // The signer is a public office holder printed on every card, not personal data of an employee.
      await writeCardAudit(client, {
        eventType: "employee_card.settings.updated", actorAccountId: principal.id,
        metadata: { before: before.rows[0] ?? null, after: body.data },
      });
      return settings(client);
    });
  });

  app.get("/admin/employee-cards/settings/signature", async (request, reply) => {
    if (!(await requirePermission(request, reply, "employee_cards.manage"))) return;
    return sendSignature(reply);
  });

  app.put("/admin/employee-cards/settings/signature", { bodyLimit: IMAGE_BODY_LIMIT }, async (request, reply) => {
    const principal = await requirePermission(request, reply, "employee_cards.manage");
    if (!principal) return;
    const body = signatureBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_CARD_IMAGE", message: "Tanda tangan harus PNG." });
    return inTransaction(reply, 200, async (client) => {
      const bytes = decodeImage(body.data.contentType, body.data.contentBase64, MAX_SIGNATURE_BYTES, "Tanda tangan");
      const encrypted = encryptSecret(bytes.toString("base64"), key);
      await client.query(
        `UPDATE employee_card_settings
            SET signature_content_type = $1, signature_byte_size = $2, signature_ciphertext = $3,
                signature_iv = $4, signature_auth_tag = $5, updated_by_account_id = $6, updated_at = now()
          WHERE id = 1`,
        [body.data.contentType, bytes.length, encrypted.ciphertext, encrypted.iv, encrypted.tag, principal.id],
      );
      await writeCardAudit(client, {
        eventType: "employee_card.signature.uploaded", actorAccountId: principal.id,
        metadata: { contentType: body.data.contentType, byteSize: bytes.length },
      });
      return { contentType: body.data.contentType, byteSize: bytes.length };
    });
  });

  app.get("/admin/employee-cards/audit-events", async (request, reply) => {
    if (!(await requirePermission(request, reply, "employee_cards.manage"))) return;
    const query = pageQuerySchema.extend({ employeeId: z.string().uuid().optional() }).safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_EMPLOYEE_CARD_FILTER", message: "Filter tidak valid." });
    const values: unknown[] = [];
    const where = query.data.employeeId ? `WHERE event.employee_id = $${values.push(query.data.employeeId)}` : "";
    const filterValues = [...values];
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT event.id, event.event_type AS "eventType", event.employee_id AS "employeeId",
                employee.full_name AS "employeeName", event.card_id AS "cardId",
                event.reason, event.metadata, event.occurred_at AS "occurredAt",
                coalesce(actor_employee.full_name, actor.email) AS "actorName"
           FROM employee_card_audit_events event
           LEFT JOIN employees employee ON employee.id = event.employee_id
           LEFT JOIN accounts actor ON actor.id = event.actor_account_id
           LEFT JOIN employees actor_employee ON actor_employee.id = actor.employee_id
           ${where}
          ORDER BY event.occurred_at DESC, event.id DESC
          LIMIT $${values.push(query.data.pageSize)} OFFSET $${values.push(pageOffset(query.data))}`,
        values,
      ),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM employee_card_audit_events event ${where}`, filterValues),
    ]);
    return send(reply, 200, { items: items.rows, pagination: pagination(query.data, count.rows[0]?.total ?? 0) });
  });
}
