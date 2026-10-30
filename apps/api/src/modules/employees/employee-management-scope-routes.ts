// EMP-005 S2B: menandai dan melepas tanda "di luar pengelolaan HCIS"
// (spec docs/domain/employment-administration-package1.md §8.7, §13.9).
//
// Hanya HC yang menandai, selalu dengan alasan, dan tidak pernah otomatis:
// impor hanya menandai calonnya untuk dikonfirmasi HC, karena menandai sebuah
// baris berarti mengeluarkannya dari setiap daftar, hitungan, dan kelayakan
// proses — keputusan yang terlalu besar untuk disimpulkan dari satu sel di
// berkas sumber.
//
// Membuka tanda juga wajib beralasan dan ikut tercatat, supaya baris yang
// pernah salah ditandai dapat dijelaskan.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import { MANAGEMENT_SCOPE_REASONS, MANAGEMENT_SCOPES, type ManagementScope } from "./management-scope.js";

const employeeParams = z.object({ employeeId: z.string().uuid() });

const scopeBody = z.object({
  managementScope: z.enum(MANAGEMENT_SCOPES),
  reason: z.enum(MANAGEMENT_SCOPE_REASONS).nullish(),
  note: z.string().trim().min(5).max(500),
}).strict();

interface ScopeRow {
  id: string;
  employeeNumber: string;
  fullName: string;
  managementScope: ManagementScope;
  managementScopeReason: string | null;
  managementScopeNote: string | null;
  managementScopeMarkedAt: Date | null;
}

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

const SCOPE_COLUMNS = `
  id, employee_number AS "employeeNumber", full_name AS "fullName",
  management_scope AS "managementScope", management_scope_reason AS "managementScopeReason",
  management_scope_note AS "managementScopeNote", management_scope_marked_at AS "managementScopeMarkedAt"`;

export async function registerEmployeeManagementScopeRoutes(app: FastifyInstance, pool: Pool, config: ApiConfig) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for management scope routes");
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    const context = await auth.getAuthorizationContext(session.principal);
    if (!context.organizationPermissions.includes("employees.manage")) {
      await send(reply, 403, { code: "FORBIDDEN", message: "Akun ini tidak memiliki izin yang diperlukan." });
      return null;
    }
    return session.principal;
  }

  app.put("/admin/employees/:employeeId/management-scope", async (request, reply) => {
    const principal = await authenticate(request, reply);
    if (!principal) return;
    const params = employeeParams.safeParse(request.params);
    const body = scopeBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return send(reply, 400, {
        code: "INVALID_MANAGEMENT_SCOPE",
        message: "Penandaan wajib menyebut lingkup, alasan, dan catatan minimal 5 huruf.",
      });
    }
    // The reason is what the mark means; without it nobody can later say why
    // the record left HCIS management. Unmarking has no reason code by
    // definition, and sending one is refused rather than quietly dropped —
    // a caller that sends it believes something that is not true.
    if (body.data.managementScope === "OUTSIDE_HCIS" && !body.data.reason) {
      return send(reply, 400, {
        code: "INVALID_MANAGEMENT_SCOPE",
        message: "Penandaan di luar pengelolaan HCIS wajib menyebut alasan BUMY atau PENGURUS_YAYASAN.",
      });
    }
    if (body.data.managementScope === "MANAGED" && body.data.reason) {
      return send(reply, 400, {
        code: "INVALID_MANAGEMENT_SCOPE",
        message: "Membuka tanda tidak menyebut alasan BUMY atau PENGURUS_YAYASAN; tulis alasannya di catatan.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<ScopeRow>(
        `SELECT ${SCOPE_COLUMNS} FROM employees WHERE id = $1 AND removed_at IS NULL FOR UPDATE`,
        [params.data.employeeId],
      );
      const before = locked.rows[0];
      if (!before) {
        await client.query("ROLLBACK");
        return send(reply, 404, { code: "EMPLOYEE_NOT_FOUND", message: "Pegawai tidak ditemukan." });
      }
      // Only a request that changes nothing at all is refused. Correcting a
      // wrong reason, or adding to the note, must not force an unmark and a
      // re-mark — that would throw away when the record was first marked and
      // by whom.
      const unchanged = before.managementScope === body.data.managementScope
        && before.managementScopeReason === (body.data.reason ?? null)
        && before.managementScopeNote === body.data.note;
      if (unchanged) {
        await client.query("ROLLBACK");
        return send(reply, 409, {
          code: "MANAGEMENT_SCOPE_UNCHANGED",
          message: "Lingkup pengelolaan data ini sudah seperti yang diminta.",
        });
      }

      const marking = body.data.managementScope === "OUTSIDE_HCIS";
      const stillMarked = marking && before.managementScope === "OUTSIDE_HCIS";
      await client.query(
        `UPDATE employees
         SET management_scope = $2,
             management_scope_reason = $3,
             -- The note is the last thing said about this record's scope,
             -- whichever way it moved. It survives an unmark because the
             -- audit carries only its length, so the row is the one place
             -- the justification can live (§8.7).
             management_scope_note = $4,
             -- When it was first marked is kept across a correction; only a
             -- fresh mark sets it.
             management_scope_marked_at = CASE
               WHEN $2 <> 'OUTSIDE_HCIS' THEN NULL
               WHEN $6::boolean THEN management_scope_marked_at
               ELSE now() END,
             management_scope_marked_by_account_id = CASE
               WHEN $2 <> 'OUTSIDE_HCIS' THEN NULL
               WHEN $6::boolean THEN management_scope_marked_by_account_id
               ELSE $5::uuid END,
             updated_at = now()
         WHERE id = $1`,
        [
          params.data.employeeId,
          body.data.managementScope,
          marking ? body.data.reason : null,
          body.data.note,
          principal.id,
          stillMarked,
        ],
      );
      // The note says why in the officer's own words, so it belongs to the
      // record; the audit event carries its length only, like every other
      // free text in this package.
      await client.query(
        `INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload)
         VALUES ($1, $2, 'employee.management_scope.changed', 'employee', $3, $4::jsonb)`,
        [
          randomUUID(),
          principal.id,
          params.data.employeeId,
          JSON.stringify({
            from: before.managementScope,
            to: body.data.managementScope,
            fromReason: before.managementScopeReason,
            reason: marking ? body.data.reason : null,
            noteLength: body.data.note.length,
          }),
        ],
      );
      await client.query("COMMIT");

      const after = await pool.query<ScopeRow>(`SELECT ${SCOPE_COLUMNS} FROM employees WHERE id = $1`, [
        params.data.employeeId,
      ]);
      const row = after.rows[0]!;
      return send(reply, 200, {
        ...row,
        managementScopeMarkedAt: row.managementScopeMarkedAt?.toISOString() ?? null,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A failed ROLLBACK must not hide the error that caused it.
      }
      throw error;
    } finally {
      client.release();
    }
  });
}
