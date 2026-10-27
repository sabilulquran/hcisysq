// Paket 2 P2-2: pendidikan dan keahlian pegawai (spec
// docs/domain/employment-administration-package2.md §4.1, §4.2, §5, §7.1,
// §7.5). Membaca memerlukan employees.read.all, menulis employees.manage —
// tidak ada izin baru pada paket ini (§5.1).
//
// Aturan ada di ./domain/employee-profile.ts; berkas ini mengautentikasi,
// memvalidasi bentuk permintaan, menulis dalam satu transaksi, dan mencatat
// audit tanpa data pribadi (§6).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import {
  COMPLETION_STATUSES,
  EDUCATION_LEVELS,
  PROFICIENCY_LEVELS,
  SKILL_CATEGORIES,
  SKILL_KINDS,
  changedFields,
  highestEducationLevel,
  isCertificateExpired,
  validateEducation,
  validateSkill,
} from "./domain/employee-profile.js";
import {
  audit,
  getEducation,
  getSkill,
  insertEducation,
  insertSkill,
  listEducation,
  listExpiringCertificates,
  listSkills,
  lockProfileRecord,
  setVerification,
  updateEducation,
  updateSkill,
  voidRecord,
  type ProfileTable,
} from "./infrastructure/postgres-employee-profile-store.js";

const employeeParams = z.object({ employeeId: z.string().uuid() });
const recordParams = z.object({ recordId: z.string().uuid() });

const educationBody = z.object({
  level: z.enum(EDUCATION_LEVELS),
  institutionName: z.string().trim().min(1).max(200),
  major: z.string().trim().max(200).nullish(),
  startedYear: z.coerce.number().int().nullish(),
  completedYear: z.coerce.number().int().nullish(),
  completionStatus: z.enum(COMPLETION_STATUSES),
  degreeTitle: z.string().trim().max(100).nullish(),
  certificateNumber: z.string().trim().max(120).nullish(),
  archiveReference: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(2000).nullish(),
}).strict();

const skillBody = z.object({
  kind: z.enum(SKILL_KINDS),
  name: z.string().trim().min(1).max(200),
  category: z.enum(SKILL_CATEGORIES),
  proficiency: z.enum(PROFICIENCY_LEVELS).nullish(),
  issuer: z.string().trim().max(200).nullish(),
  certificateNumber: z.string().trim().max(120).nullish(),
  issuedOn: z.string().nullish(),
  expiresOn: z.string().nullish(),
  archiveReference: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(2000).nullish(),
}).strict();

const verificationBody = z.object({
  verified: z.boolean(),
  reason: z.string().trim().max(500).nullish(),
});

const voidBody = z.object({ reason: z.string().trim().min(5).max(500) });

const expiringQuery = z.object({
  withinDays: z.coerce.number().int().min(1).max(365).default(60),
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

export async function registerEmployeeProfileRoutes(app: FastifyInstance, pool: Pool, config: ApiConfig) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for employee profile routes");
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

  /** A record removed from the master is read-only history (EMP-001). */
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

  // ------------------------------------------------------------ pendidikan

  app.get("/admin/employees/:employeeId/education", async (request, reply) => {
    if (!(await authenticate(request, reply, "employees.read.all"))) return;
    const params = employeeParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "Pegawai tidak valid.");
    if (!(await requireEmployee(reply, params.data.employeeId))) return;
    const rows = await listEducation(pool, params.data.employeeId);
    return send(reply, 200, {
      rows,
      // §5.6: diturunkan di sini, tidak pernah diketik operator.
      highestLevel: highestEducationLevel(
        rows.map((row) => ({
          level: row.level,
          completionStatus: row.completionStatus,
          verificationStatus: row.verificationStatus,
          voided: row.voidedAt !== null,
        })),
      ),
    });
  });

  app.post("/admin/employees/:employeeId/education", async (request, reply) => {
    const principal = await authenticate(request, reply, "employees.manage");
    if (!principal) return;
    const params = employeeParams.safeParse(request.params);
    const body = educationBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);
    if (!(await requireEmployee(reply, params.data.employeeId))) return;

    const validation = validateEducation(body.data, Number(jakartaToday().slice(0, 4)));
    if (!validation.ok) return send(reply, 400, { ...validation.failure });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const id = await insertEducation(client, params.data.employeeId, validation.value, principal.id);
      await audit(client, {
        actorAccountId: principal.id,
        action: "employee.education.recorded",
        entityType: "employee_education",
        entityId: id,
        employeeId: params.data.employeeId,
        payload: { level: validation.value.level, completionStatus: validation.value.completionStatus },
      });
      await client.query("COMMIT");
      return send(reply, 201, await getEducation(pool, id));
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  });

  app.patch("/admin/education-records/:recordId", async (request, reply) => {
    const principal = await authenticate(request, reply, "employees.manage");
    if (!principal) return;
    const params = recordParams.safeParse(request.params);
    const body = educationBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);

    const validation = validateEducation(body.data, Number(jakartaToday().slice(0, 4)));
    if (!validation.ok) return send(reply, 400, { ...validation.failure });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await lockProfileRecord(client, "employee_education", params.data.recordId);
      if (await refuseMissingOrVoided(client, reply, locked)) return;
      const before = await getEducation(client, params.data.recordId);
      await updateEducation(client, params.data.recordId, validation.value);
      await audit(client, {
        actorAccountId: principal.id,
        action: "employee.education.updated",
        entityType: "employee_education",
        entityId: params.data.recordId,
        employeeId: locked!.employeeId,
        payload: { changedFields: before ? changedFields(before, validation.value) : [] },
      });
      await client.query("COMMIT");
      return send(reply, 200, await getEducation(pool, params.data.recordId));
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------- keahlian

  app.get("/admin/employees/:employeeId/skills", async (request, reply) => {
    if (!(await authenticate(request, reply, "employees.read.all"))) return;
    const params = employeeParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "Pegawai tidak valid.");
    if (!(await requireEmployee(reply, params.data.employeeId))) return;
    const today = jakartaToday();
    const rows = await listSkills(pool, params.data.employeeId);
    return send(reply, 200, {
      // §5.3: yang kedaluwarsa ditandai, bukan diubah atau dihapus.
      rows: rows.map((row) => ({ ...row, expired: isCertificateExpired(row.expiresOn, today) })),
      date: today,
    });
  });

  app.post("/admin/employees/:employeeId/skills", async (request, reply) => {
    const principal = await authenticate(request, reply, "employees.manage");
    if (!principal) return;
    const params = employeeParams.safeParse(request.params);
    const body = skillBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);
    if (!(await requireEmployee(reply, params.data.employeeId))) return;

    const validation = validateSkill(body.data);
    if (!validation.ok) return send(reply, 400, { ...validation.failure });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const id = await insertSkill(client, params.data.employeeId, validation.value, principal.id);
      await audit(client, {
        actorAccountId: principal.id,
        action: "employee.skill.recorded",
        entityType: "employee_skills",
        entityId: id,
        employeeId: params.data.employeeId,
        payload: { kind: validation.value.kind, category: validation.value.category, expiresOn: validation.value.expiresOn },
      });
      await client.query("COMMIT");
      return send(reply, 201, await getSkill(pool, id));
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  });

  app.patch("/admin/skill-records/:recordId", async (request, reply) => {
    const principal = await authenticate(request, reply, "employees.manage");
    if (!principal) return;
    const params = recordParams.safeParse(request.params);
    const body = skillBody.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply);

    const validation = validateSkill(body.data);
    if (!validation.ok) return send(reply, 400, { ...validation.failure });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await lockProfileRecord(client, "employee_skills", params.data.recordId);
      if (await refuseMissingOrVoided(client, reply, locked)) return;
      const before = await getSkill(client, params.data.recordId);
      await updateSkill(client, params.data.recordId, validation.value);
      await audit(client, {
        actorAccountId: principal.id,
        action: "employee.skill.updated",
        entityType: "employee_skills",
        entityId: params.data.recordId,
        employeeId: locked!.employeeId,
        payload: { changedFields: before ? changedFields(before, validation.value) : [] },
      });
      await client.query("COMMIT");
      return send(reply, 200, await getSkill(pool, params.data.recordId));
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  });

  // ------------------------------------------- verifikasi dan pembatalan

  async function rollback(client: { query: (sql: string) => Promise<unknown> }) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Sebuah ROLLBACK yang gagal tidak boleh menutupi error penyebabnya.
    }
  }

  /**
   * True ketika permintaan sudah dijawab dan pemanggil harus berhenti. Sengaja
   * bukan reply yang dikembalikan: FastifyReply adalah thenable, sehingga
   * `await` atasnya menghasilkan undefined dan handler akan jalan terus lalu
   * tetap menulis sesudah membalas 404/409.
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
    // A record identified by its own id still belongs to an employee, and a
    // record of an employee removed from the master is read-only history
    // (EMP-001) — the same answer its list already gives.
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

  // The table follows the registered prefix. Reading it out of request.url
  // would read the query string too, so ".../void?x=/education-records/" could
  // pick the wrong table.
  const RECORD_ROUTES: Array<{ prefix: string; table: ProfileTable }> = [
    { prefix: "/admin/education-records", table: "employee_education" },
    { prefix: "/admin/skill-records", table: "employee_skills" },
  ];

  for (const { prefix, table } of RECORD_ROUTES) {
    app.post(`${prefix}/:recordId/verification`, async (request, reply) => {
      const principal = await authenticate(request, reply, "employees.manage");
      if (!principal) return;
      const params = recordParams.safeParse(request.params);
      const body = verificationBody.safeParse(request.body);
      if (!params.success || !body.success) return invalid(reply);
      const reason = body.data.reason?.trim() ?? "";
      if (!body.data.verified && reason.length < 5) {
        return invalid(reply, "Pencabutan verifikasi wajib disertai alasan.");
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await lockProfileRecord(client, table, params.data.recordId);
        if (await refuseMissingOrVoided(client, reply, locked)) return;
        await setVerification(client, table, params.data.recordId, body.data.verified, reason || null, principal.id);
        await audit(client, {
          actorAccountId: principal.id,
          action: table === "employee_education"
            ? (body.data.verified ? "employee.education.verified" : "employee.education.unverified")
            : (body.data.verified ? "employee.skill.verified" : "employee.skill.unverified"),
          entityType: table,
          entityId: params.data.recordId,
          employeeId: locked!.employeeId,
          payload: { verified: body.data.verified, reasonLength: reason.length },
        });
        await client.query("COMMIT");
        const row = table === "employee_education"
          ? await getEducation(pool, params.data.recordId)
          : await getSkill(pool, params.data.recordId);
        return send(reply, 200, row);
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    });

    app.post(`${prefix}/:recordId/void`, async (request, reply) => {
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
        const locked = await lockProfileRecord(client, table, params.data.recordId);
        if (await refuseMissingOrVoided(client, reply, locked)) return;
        await voidRecord(client, table, params.data.recordId, body.data.reason);
        await audit(client, {
          actorAccountId: principal.id,
          action: table === "employee_education" ? "employee.education.voided" : "employee.skill.voided",
          entityType: table,
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

  // ------------------------------------------ sertifikat yang akan berakhir

  app.get("/admin/employees/certificates/expiring", async (request, reply) => {
    if (!(await authenticate(request, reply, "employees.read.all"))) return;
    const query = expiringQuery.safeParse(request.query);
    if (!query.success) return invalid(reply, "Parameter tidak valid.");
    const today = jakartaToday();
    const result = await listExpiringCertificates(pool, {
      today,
      withinDays: query.data.withinDays,
      unitId: query.data.unitId ?? null,
      page: query.data.page,
      pageSize: query.data.pageSize,
    });
    return send(reply, 200, {
      date: today,
      withinDays: query.data.withinDays,
      page: query.data.page,
      pageSize: query.data.pageSize,
      total: result.total,
      rows: result.rows.map((row) => ({ ...row, expired: row.daysLeft < 0 })),
    });
  });
}
