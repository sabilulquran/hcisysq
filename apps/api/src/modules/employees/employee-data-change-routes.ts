// Paket 2 P2-4: usulan perubahan data pegawai (EMP-003 §4.5, §7.3, §7.4).
//
// Pegawai mengusulkan perubahan atas datanya sendiri; satu petugas HC
// memutuskan. Tidak ada approval berjenjang pada paket ini (§4.5 DRAFT).
//
// Tiga hal yang dijaga berkas ini:
//
//   1. Pegawai hanya pernah menyentuh usulannya sendiri. Semua rute pegawai
//      menurunkan employee_id dari sesi, tidak pernah dari permintaan, jadi
//      tidak ada jalan untuk membaca atau membatalkan usulan orang lain.
//   2. Isi usulan divalidasi dua kali, saat diajukan dan lagi saat diterima
//      (§4.5). Aturan dapat berubah di antara keduanya, dan usulan yang sudah
//      menginap tidak boleh lolos hanya karena dulu sah.
//   3. Menerima usulan menulis perubahannya dalam transaksi yang sama dengan
//      keputusannya. Bila penulisan gagal — misalnya alamat yang diusulkan
//      bertabrakan dengan periode yang sudah ada — keputusannya ikut batal,
//      sehingga tidak pernah ada usulan "DITERIMA" yang tidak berbekas.
//
// Audit memuat bagian data, nama field, dan panjang alasan. Tidak pernah isi
// usulannya (§6).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import {
  DATA_CHANGE_TARGETS,
  closingDateFor,
  proposedFields,
  validateDataChange,
  type DataChangeValues,
} from "./domain/employee-profile.js";
import {
  audit,
  closeAddress,
  decideDataChangeRequest,
  getDataChangeRequest,
  insertAddress,
  insertDataChangeRequest,
  insertEducation,
  insertFamilyMember,
  insertSkill,
  listDataChangeRequests,
  listOwnDataChangeRequests,
  lockDataChangeRequest,
  lockOpenAddress,
  updateEmployeeContact,
} from "./infrastructure/postgres-employee-profile-store.js";

const requestParams = z.object({ requestId: z.string().uuid() });

const submitBody = z.object({
  target: z.enum(DATA_CHANGE_TARGETS),
  payload: z.record(z.unknown()),
}).strict();

const rejectBody = z.object({ reason: z.string().trim().min(5).max(500) });
const acceptBody = z.object({ note: z.string().trim().max(500).nullish() }).optional();

const worklistQuery = z.object({
  state: z.enum(["DIAJUKAN", "DITERIMA", "DITOLAK", "DIBATALKAN"]).default("DIAJUKAN"),
  unitId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

function jakartaToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now);
}

/**
 * A refusal from the database, turned into the code the spec names for the
 * rule that was broken (§9). One code for all of them would tell HC only that
 * something collided, not what.
 */
const CONSTRAINT_CONFLICTS: Record<string, { code: string; message: string }> = {
  employee_family_single_spouse_excl: {
    code: "FAMILY_SPOUSE_OVERLAP",
    message: "Sudah ada pasangan yang tercatat pada periode tersebut.",
  },
  employee_family_emergency_priority_excl: {
    code: "EMERGENCY_PRIORITY_TAKEN",
    message: "Urutan kontak darurat ini sudah dipakai.",
  },
  employee_addresses_single_current_excl: {
    code: "ADDRESS_PERIOD_OVERLAP",
    message: "Sudah ada alamat jenis ini pada periode tersebut.",
  },
};

const GENERIC_CONFLICT = {
  code: "DATA_CHANGE_CONFLICT",
  message: "Usulan ini bertabrakan dengan data yang sudah ada, jadi belum dapat diterima.",
};

function writeConflict(error: unknown): { code: string; message: string } | null {
  if (typeof error !== "object" || error === null) return null;
  const { code, constraint } = error as { code?: string; constraint?: string };
  if (code === "ADDRESS_PERIOD_IMPOSSIBLE") {
    return {
      code: "ADDRESS_PERIOD_OVERLAP",
      message: "Alamat yang berlaku mulai pada atau setelah tanggal usulan, jadi tidak dapat ditutup lebih dulu.",
    };
  }
  // 23P01 is an exclusion, 23514 a CHECK the domain rules are meant to mirror.
  // Both mean the proposal cannot be written, and both are the employee's
  // data colliding with itself — never a server fault to report as 500.
  if (code !== "23P01" && code !== "23514") return null;
  return (constraint ? CONSTRAINT_CONFLICTS[constraint] : undefined) ?? GENERIC_CONFLICT;
}

/**
 * Writes an accepted proposal. Runs on the same client as the decision, so a
 * refusal from the database undoes both.
 */
async function applyDataChange(
  client: PoolClient,
  employeeId: string,
  change: DataChangeValues,
  actorAccountId: string,
): Promise<{ entityType: string; entityId: string | null }> {
  switch (change.target) {
    case "ALAMAT": {
      const open = await lockOpenAddress(client, employeeId, change.values.kind);
      if (open) {
        const closing = closingDateFor(open, change.values.validFrom);
        if (closing.kind === "impossible") {
          throw Object.assign(new Error("address period cannot be closed"), { code: "ADDRESS_PERIOD_IMPOSSIBLE" });
        }
        if (closing.kind === "close") await closeAddress(client, open.id, closing.on);
      }
      return { entityType: "employee_addresses", entityId: await insertAddress(client, employeeId, change.values, actorAccountId) };
    }
    case "KONTAK":
      await updateEmployeeContact(client, employeeId, change.values);
      return { entityType: "employees", entityId: employeeId };
    case "KELUARGA":
      return {
        entityType: "employee_family_members",
        entityId: await insertFamilyMember(client, employeeId, change.values, actorAccountId),
      };
    case "PENDIDIKAN":
      return {
        entityType: "employee_education",
        entityId: await insertEducation(client, employeeId, change.values, actorAccountId),
      };
    case "KEAHLIAN":
      return {
        entityType: "employee_skills",
        entityId: await insertSkill(client, employeeId, change.values, actorAccountId),
      };
  }
}

export async function registerEmployeeDataChangeRoutes(app: FastifyInstance, pool: Pool, config: ApiConfig) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for data change routes");
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  /** The acting employee, derived from the session — never from the request. */
  async function employeeOfSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ principal: AuthPrincipal; employeeId: string } | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    const linked = await pool.query<{ employeeId: string }>(
      `SELECT employee_id AS "employeeId" FROM accounts
       WHERE id = $1 AND principal_type = 'EMPLOYEE' AND employee_id IS NOT NULL`,
      [session.principal.id],
    );
    const employeeId = linked.rows[0]?.employeeId;
    if (!employeeId) {
      await send(reply, 403, { code: "EMPLOYEE_ACCOUNT_REQUIRED", message: "Akun ini tidak terhubung ke data pegawai." });
      return null;
    }
    return { principal: session.principal, employeeId };
  }

  async function authenticateHc(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: "employees.read.all" | "employees.manage",
  ): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    const context = await auth.getAuthorizationContext(session.principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, { code: "FORBIDDEN", message: "Akun ini tidak memiliki izin yang diperlukan." });
      return null;
    }
    return session.principal;
  }

  async function rollback(client: { query: (sql: string) => Promise<unknown> }) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // A failed ROLLBACK must not hide the error that caused it.
    }
  }

  // ------------------------------------------------------- pegawai (§7.3)

  app.get("/employees/me/data-changes", async (request, reply) => {
    const me = await employeeOfSession(request, reply);
    if (!me) return;
    return send(reply, 200, { rows: await listOwnDataChangeRequests(pool, me.employeeId) });
  });

  app.post("/employees/me/data-changes", async (request, reply) => {
    const me = await employeeOfSession(request, reply);
    if (!me) return;
    const body = submitBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, { code: "EMPLOYEE_RECORD_INVALID", message: "Usulan tidak valid." });
    }
    const validation = validateDataChange(body.data.target, body.data.payload, Number(jakartaToday().slice(0, 4)));
    if (!validation.ok) return send(reply, 400, { ...validation.failure });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const id = await insertDataChangeRequest(client, {
        employeeId: me.employeeId,
        submittedByAccountId: me.principal.id,
        target: body.data.target,
        payload: validation.value.values as unknown as Record<string, unknown>,
      });
      await audit(client, {
        actorAccountId: me.principal.id,
        action: "employee.data_change.submitted",
        entityType: "employee_data_change_requests",
        entityId: id,
        employeeId: me.employeeId,
        payload: { target: body.data.target, fields: proposedFields(validation.value) },
      });
      const submitted = await getDataChangeRequest(client, id);
      await client.query("COMMIT");
      return send(reply, 201, submitted);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/employees/me/data-changes/:requestId/cancel", async (request, reply) => {
    const me = await employeeOfSession(request, reply);
    if (!me) return;
    const params = requestParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "EMPLOYEE_RECORD_INVALID", message: "Usulan tidak valid." });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await lockDataChangeRequest(client, params.data.requestId);
      // Someone else's proposal answers exactly as a missing one does, so the
      // endpoint never confirms that a request id exists.
      if (!locked || locked.employeeId !== me.employeeId) {
        await rollback(client);
        return send(reply, 404, { code: "DATA_CHANGE_NOT_FOUND", message: "Usulan tidak ditemukan." });
      }
      if (locked.state !== "DIAJUKAN") {
        await rollback(client);
        return send(reply, 409, { code: "DATA_CHANGE_NOT_PENDING", message: "Usulan ini sudah diputuskan." });
      }
      // A withdrawal is the proposer's own, so it names no decider (§4.5).
      await decideDataChangeRequest(client, params.data.requestId, {
        state: "DIBATALKAN",
        decidedByAccountId: null,
        decisionNote: null,
      });
      await audit(client, {
        actorAccountId: me.principal.id,
        action: "employee.data_change.cancelled",
        entityType: "employee_data_change_requests",
        entityId: params.data.requestId,
        employeeId: me.employeeId,
        payload: { target: locked.target },
      });
      const cancelled = await getDataChangeRequest(client, params.data.requestId);
      await client.query("COMMIT");
      return send(reply, 200, cancelled);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  });

  // ------------------------------------------------------------- HC (§7.4)

  app.get("/admin/employees/data-changes", async (request, reply) => {
    if (!(await authenticateHc(request, reply, "employees.read.all"))) return;
    const query = worklistQuery.safeParse(request.query);
    if (!query.success) {
      return send(reply, 400, { code: "EMPLOYEE_RECORD_INVALID", message: "Parameter tidak valid." });
    }
    const result = await listDataChangeRequests(pool, {
      state: query.data.state,
      unitId: query.data.unitId ?? null,
      page: query.data.page,
      pageSize: query.data.pageSize,
    });
    return send(reply, 200, {
      state: query.data.state,
      page: query.data.page,
      pageSize: query.data.pageSize,
      total: result.total,
      rows: result.rows,
    });
  });

  for (const outcome of ["accept", "reject"] as const) {
    app.post(`/admin/data-change-requests/:requestId/${outcome}`, async (request, reply) => {
      const principal = await authenticateHc(request, reply, "employees.manage");
      if (!principal) return;
      const params = requestParams.safeParse(request.params);
      if (!params.success) return send(reply, 400, { code: "EMPLOYEE_RECORD_INVALID", message: "Usulan tidak valid." });

      let note: string | null = null;
      if (outcome === "reject") {
        const body = rejectBody.safeParse(request.body);
        if (!body.success) {
          return send(reply, 400, { code: "DATA_CHANGE_REASON_REQUIRED", message: "Penolakan wajib disertai alasan." });
        }
        note = body.data.reason;
      } else {
        const body = acceptBody.safeParse(request.body);
        if (!body.success) return send(reply, 400, { code: "EMPLOYEE_RECORD_INVALID", message: "Catatan tidak valid." });
        note = body.data?.note?.trim() || null;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await lockDataChangeRequest(client, params.data.requestId);
        if (!locked) {
          await rollback(client);
          return send(reply, 404, { code: "DATA_CHANGE_NOT_FOUND", message: "Usulan tidak ditemukan." });
        }
        if (locked.state !== "DIAJUKAN") {
          await rollback(client);
          return send(reply, 409, { code: "DATA_CHANGE_NOT_PENDING", message: "Usulan ini sudah diputuskan." });
        }
        if (locked.employeeRemoved) {
          await rollback(client);
          return send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
        }

        let applied: { entityType: string; entityId: string | null } | null = null;
        let appliedFields: string[] | null = null;
        if (outcome === "accept") {
          // Validated again: the rules, and the year, may have moved since the
          // employee proposed this (§4.5).
          const validation = validateDataChange(locked.target, locked.payload, Number(jakartaToday().slice(0, 4)));
          if (!validation.ok) {
            await rollback(client);
            return send(reply, 409, {
              code: "DATA_CHANGE_NO_LONGER_VALID",
              message: `Usulan ini tidak lagi memenuhi aturan: ${validation.failure.message}`,
              field: validation.failure.field,
            });
          }
          appliedFields = proposedFields(validation.value);
          applied = await applyDataChange(client, locked.employeeId, validation.value, principal.id);
        }

        await decideDataChangeRequest(client, params.data.requestId, {
          state: outcome === "accept" ? "DITERIMA" : "DITOLAK",
          decidedByAccountId: principal.id,
          decisionNote: note,
        });
        await audit(client, {
          actorAccountId: principal.id,
          action: outcome === "accept" ? "employee.data_change.accepted" : "employee.data_change.rejected",
          entityType: "employee_data_change_requests",
          entityId: params.data.requestId,
          employeeId: locked.employeeId,
          payload: {
            target: locked.target,
            // §6 asks for the field names a decision touched, not their values.
            ...(appliedFields ? { fields: appliedFields } : {}),
            ...(applied ? { appliedTo: applied.entityType, appliedId: applied.entityId } : {}),
            ...(note ? { noteLength: note.length } : {}),
          },
        });
        // Read before COMMIT, on the same client: reading afterwards on the
        // pool meant a failed second connection threw after the decision was
        // already committed, answering 500 for work that had succeeded.
        const decided = await getDataChangeRequest(client, params.data.requestId);
        await client.query("COMMIT");
        return send(reply, 200, decided);
      } catch (error) {
        await rollback(client);
        const conflict = writeConflict(error);
        if (conflict) return send(reply, 409, conflict);
        throw error;
      } finally {
        client.release();
      }
    });
  }
}
