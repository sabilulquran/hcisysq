// Paket 2 P2-3: keluarga, tanggungan, kontak darurat (EMP-009), dan alamat
// ber-riwayat (EMP-003) — spec docs/domain/employment-administration-package2.md
// §4.3, §4.4, §5, §7.2. Izinnya sama dengan P2-2: membaca
// `employees.read.all`, menulis `employees.manage`; paket ini tidak menambah
// izin baru (§5.1).
//
// Dua hal yang khas di berkas ini:
//
//   1. Nomor identitas anggota keluarga tidak pernah diterima. Skema request
//      bersifat `.strict()`, jadi `identityNumber` ditolak sebagai permintaan
//      tidak valid, bukan diam-diam diabaikan (§8). Basis data menjaga hal
//      yang sama dengan CHECK.
//   2. Pindah rumah bukan penyuntingan: alamat lama ditutup sehari sebelum
//      yang baru berlaku, dalam transaksi yang sama, pada baris yang sudah
//      dikunci. Exclusion constraint basis data adalah jaring terakhirnya,
//      dan pelanggarannya dijawab 409, bukan 500.
//
// Audit tidak pernah memuat nama anggota keluarga, nomor telepon, atau baris
// alamat — hanya hubungan, jenis, tanggal, nama field, dan panjang alasan
// (§6).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import {
  ADDRESS_KINDS,
  ADDRESS_SOURCES,
  FAMILY_RELATIONS,
  GENDERS,
  changedFields,
  closingDateFor,
  validateAddress,
  validateFamilyMember,
} from "./domain/employee-profile.js";
import {
  audit,
  closeAddress,
  getAddress,
  getFamilyMember,
  insertAddress,
  insertFamilyMember,
  listAddresses,
  listFamilyMembers,
  lockOpenAddress,
  lockProfileRecord,
  updateAddress,
  updateFamilyMember,
  voidRecord,
  type VoidableTable,
} from "./infrastructure/postgres-employee-profile-store.js";

const employeeParams = z.object({ employeeId: z.string().uuid() });
const recordParams = z.object({ recordId: z.string().uuid() });

const familyBody = z.object({
  relation: z.enum(FAMILY_RELATIONS),
  fullName: z.string().trim().min(1).max(200),
  birthDate: z.string().nullish(),
  gender: z.enum(GENDERS).nullish(),
  isDependent: z.boolean().optional(),
  dependentOrder: z.coerce.number().int().nullish(),
  isEmergencyContact: z.boolean().optional(),
  emergencyPhone: z.string().trim().max(40).nullish(),
  emergencyPriority: z.coerce.number().int().nullish(),
  validFrom: z.string(),
  validTo: z.string().nullish(),
  notes: z.string().trim().max(2000).nullish(),
}).strict();

const addressBody = z.object({
  kind: z.enum(ADDRESS_KINDS),
  addressLine: z.string().trim().min(1).max(500),
  village: z.string().trim().max(120).nullish(),
  district: z.string().trim().max(120).nullish(),
  city: z.string().trim().min(1).max(120),
  province: z.string().trim().max(120).nullish(),
  postalCode: z.string().trim().max(10).nullish(),
  validFrom: z.string(),
  validTo: z.string().nullish(),
  source: z.enum(ADDRESS_SOURCES).optional(),
  notes: z.string().trim().max(2000).nullish(),
}).strict();

const voidBody = z.object({ reason: z.string().trim().min(5).max(500) });

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

/** PostgreSQL exclusion violation: two records claim the same period. */
function isPeriodConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23P01";
}

export async function registerEmployeeRelationsRoutes(app: FastifyInstance, pool: Pool, config: ApiConfig) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for employee relations routes");
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  async function authenticate(
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

  async function requireEmployee(reply: FastifyReply, employeeId: string): Promise<boolean> {
    const employee = await pool.query("SELECT id FROM employees WHERE id = $1 AND removed_at IS NULL", [employeeId]);
    if (!employee.rows[0]) {
      await send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
      return false;
    }
    return true;
  }

  function invalid(reply: FastifyReply, message = "Data catatan tidak valid.") {
    return send(reply, 400, { code: "EMPLOYEE_RECORD_INVALID", message });
  }

  async function rollback(client: { query: (sql: string) => Promise<unknown> }) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // A failed ROLLBACK must not hide the error that caused it.
    }
  }

  /**
   * True when the request has been answered and the caller must stop. A
   * boolean, not the reply: a FastifyReply is thenable, so awaiting one yields
   * undefined and the caller would fall through and write after refusing.
   */
  async function refuseMissingOrVoided(
    client: { query: (sql: string) => Promise<unknown> },
    reply: FastifyReply,
    locked: { employeeId: string; voidedAt: Date | null; employeeRemoved: boolean } | null,
  ): Promise<boolean> {
    if (!locked) {
      await rollback(client);
      await send(reply, 404, { code: "EMPLOYEE_RECORD_NOT_FOUND", message: "Catatan tidak ditemukan." });
      return true;
    }
    // A route reached by record id never names the employee, and a record of
    // someone removed from the master is read-only history (EMP-001) — the
    // same answer its own list gives.
    if (locked.employeeRemoved) {
      await rollback(client);
      await send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
      return true;
    }
    if (locked.voidedAt !== null) {
      await rollback(client);
      await send(reply, 409, { code: "EMPLOYEE_RECORD_VOIDED", message: "Catatan ini sudah dibatalkan." });
      return true;
    }
    return false;
  }

  // --------------------------------------------------------------- keluarga

  app.get("/admin/employees/:employeeId/family", async (request, reply) => {
    if (!(await authenticate(request, reply, "employees.read.all"))) return;
    const params = employeeParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "Pegawai tidak valid.");
    if (!(await requireEmployee(reply, params.data.employeeId))) return;
    const rows = await listFamilyMembers(pool, params.data.employeeId);
    return send(reply, 200, {
      rows,
      dependents: rows.filter((row) => row.isDependent).length,
      emergencyContacts: rows.filter((row) => row.isEmergencyContact).length,
    });
  });

  app.post("/admin/employees/:employeeId/family", async (request, reply) => {
    const principal = await authenticate(request, reply, "employees.manage");
    if (!principal) return;
    const params = employeeParams.safeParse(request.params);
    const body = familyBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);
    if (!(await requireEmployee(reply, params.data.employeeId))) return;

    const validation = validateFamilyMember(body.data);
    if (!validation.ok) return send(reply, 400, { ...validation.failure });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const id = await insertFamilyMember(client, params.data.employeeId, validation.value, principal.id);
      await audit(client, {
        actorAccountId: principal.id,
        action: "employee.family.recorded",
        entityType: "employee_family_members",
        entityId: id,
        employeeId: params.data.employeeId,
        payload: {
          relation: validation.value.relation,
          isDependent: validation.value.isDependent,
          isEmergencyContact: validation.value.isEmergencyContact,
          validFrom: validation.value.validFrom,
        },
      });
      await client.query("COMMIT");
      return send(reply, 201, await getFamilyMember(pool, id));
    } catch (error) {
      await rollback(client);
      if (isPeriodConflict(error)) {
        return send(reply, 409, {
          code: "FAMILY_PERIOD_CONFLICT",
          message: "Sudah ada pasangan atau urutan kontak darurat yang berlaku pada periode itu.",
        });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.patch("/admin/family-records/:recordId", async (request, reply) => {
    const principal = await authenticate(request, reply, "employees.manage");
    if (!principal) return;
    const params = recordParams.safeParse(request.params);
    const body = familyBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);

    const validation = validateFamilyMember(body.data);
    if (!validation.ok) return send(reply, 400, { ...validation.failure });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await lockProfileRecord(client, "employee_family_members", params.data.recordId);
      if (await refuseMissingOrVoided(client, reply, locked)) return;
      const before = await getFamilyMember(client, params.data.recordId);
      await updateFamilyMember(client, params.data.recordId, validation.value);
      await audit(client, {
        actorAccountId: principal.id,
        action: "employee.family.updated",
        entityType: "employee_family_members",
        entityId: params.data.recordId,
        employeeId: locked!.employeeId,
        payload: { changedFields: before ? changedFields(before, validation.value) : [] },
      });
      await client.query("COMMIT");
      return send(reply, 200, await getFamilyMember(pool, params.data.recordId));
    } catch (error) {
      await rollback(client);
      if (isPeriodConflict(error)) {
        return send(reply, 409, {
          code: "FAMILY_PERIOD_CONFLICT",
          message: "Sudah ada pasangan atau urutan kontak darurat yang berlaku pada periode itu.",
        });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  // ----------------------------------------------------------------- alamat

  app.get("/admin/employees/:employeeId/addresses", async (request, reply) => {
    if (!(await authenticate(request, reply, "employees.read.all"))) return;
    const params = employeeParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "Pegawai tidak valid.");
    if (!(await requireEmployee(reply, params.data.employeeId))) return;
    const rows = await listAddresses(pool, params.data.employeeId);
    return send(reply, 200, {
      rows,
      // Which address is in force now, per kind, derived rather than flagged.
      current: {
        DOMISILI: rows.find((row) => row.kind === "DOMISILI" && row.validTo === null)?.id ?? null,
        KTP: rows.find((row) => row.kind === "KTP" && row.validTo === null)?.id ?? null,
      },
    });
  });

  app.post("/admin/employees/:employeeId/addresses", async (request, reply) => {
    const principal = await authenticate(request, reply, "employees.manage");
    if (!principal) return;
    const params = employeeParams.safeParse(request.params);
    const body = addressBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);
    if (!(await requireEmployee(reply, params.data.employeeId))) return;

    const validation = validateAddress(body.data);
    if (!validation.ok) return send(reply, 400, { ...validation.failure });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Moving house closes the open address of the same kind, inside this
      // transaction and on the locked row.
      const open = await lockOpenAddress(client, params.data.employeeId, validation.value.kind);
      let closedId: string | null = null;
      if (open) {
        const closing = closingDateFor(open, validation.value.validFrom);
        if (closing.kind === "impossible") {
          await rollback(client);
          return send(reply, 409, {
            code: "ADDRESS_PERIOD_CONFLICT",
            message: "Alamat yang berlaku mulai pada atau setelah tanggal ini, jadi tidak dapat ditutup lebih dulu.",
          });
        }
        if (closing.kind === "close") {
          await closeAddress(client, open.id, closing.on);
          closedId = open.id;
        }
      }
      const id = await insertAddress(client, params.data.employeeId, validation.value, principal.id);
      await audit(client, {
        actorAccountId: principal.id,
        action: "employee.address.recorded",
        entityType: "employee_addresses",
        entityId: id,
        employeeId: params.data.employeeId,
        payload: {
          kind: validation.value.kind,
          validFrom: validation.value.validFrom,
          source: validation.value.source,
          closedAddressId: closedId,
        },
      });
      await client.query("COMMIT");
      return send(reply, 201, { ...(await getAddress(pool, id)), closedAddressId: closedId });
    } catch (error) {
      await rollback(client);
      if (isPeriodConflict(error)) {
        return send(reply, 409, {
          code: "ADDRESS_PERIOD_CONFLICT",
          message: "Sudah ada alamat jenis ini yang berlaku pada periode tersebut.",
        });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.patch("/admin/address-records/:recordId", async (request, reply) => {
    const principal = await authenticate(request, reply, "employees.manage");
    if (!principal) return;
    const params = recordParams.safeParse(request.params);
    const body = addressBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);

    const validation = validateAddress(body.data);
    if (!validation.ok) return send(reply, 400, { ...validation.failure });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await lockProfileRecord(client, "employee_addresses", params.data.recordId);
      if (await refuseMissingOrVoided(client, reply, locked)) return;
      const before = await getAddress(client, params.data.recordId);
      await updateAddress(client, params.data.recordId, validation.value);
      await audit(client, {
        actorAccountId: principal.id,
        action: "employee.address.updated",
        entityType: "employee_addresses",
        entityId: params.data.recordId,
        employeeId: locked!.employeeId,
        payload: { changedFields: before ? changedFields(before, validation.value) : [] },
      });
      await client.query("COMMIT");
      return send(reply, 200, await getAddress(pool, params.data.recordId));
    } catch (error) {
      await rollback(client);
      if (isPeriodConflict(error)) {
        return send(reply, 409, {
          code: "ADDRESS_PERIOD_CONFLICT",
          message: "Sudah ada alamat jenis ini yang berlaku pada periode tersebut.",
        });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  // ------------------------------------------------------------ pembatalan

  const VOID_ROUTES: Array<{ prefix: string; table: VoidableTable; action: string }> = [
    { prefix: "/admin/family-records", table: "employee_family_members", action: "employee.family.voided" },
    { prefix: "/admin/address-records", table: "employee_addresses", action: "employee.address.voided" },
  ];

  for (const route of VOID_ROUTES) {
    app.post(`${route.prefix}/:recordId/void`, async (request, reply) => {
      const principal = await authenticate(request, reply, "employees.manage");
      if (!principal) return;
      const params = recordParams.safeParse(request.params);
      const body = voidBody.safeParse(request.body);
      if (!params.success || !body.success) {
        return invalid(reply, "Pembatalan catatan wajib disertai alasan.");
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await lockProfileRecord(client, route.table, params.data.recordId);
        if (await refuseMissingOrVoided(client, reply, locked)) return;
        await voidRecord(client, route.table, params.data.recordId, body.data.reason);
        await audit(client, {
          actorAccountId: principal.id,
          action: route.action,
          entityType: route.table,
          entityId: params.data.recordId,
          employeeId: locked!.employeeId,
          payload: { reasonLength: body.data.reason.length },
        });
        await client.query("COMMIT");
        return send(reply, 200, { id: params.data.recordId, voided: true });
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    });
  }
}
