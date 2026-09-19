import type { AdminPermission } from "../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { requirePrincipalFromCookie, requirePermissionsFromCookie } from "../auth/authorization.js";
import { materializeAttendanceResult } from "./engine.js";
import {
  AuthError,
  AuthService,
  type AuthPrincipal,
} from "../auth/service.js";

const isoDateSchema = z.string().refine(isIsoDate, "Tanggal tidak valid.");
const rangeQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
const employeeParamSchema = z.object({ employeeId: z.string().uuid() });
const recordParamSchema = z.object({
  employeeId: z.string().uuid(),
  attendanceDate: isoDateSchema,
});
const isoTimestampSchema = z.string().datetime({ offset: true });
const writeRecordSchema = z.object({
  checkInAt: isoTimestampSchema.nullable(),
  checkOutAt: isoTimestampSchema.nullable(),
  note: z.string().trim().max(1000).nullable(),
});

interface EmployeeRow {
  id: string;
  employeeNumber: string;
  fullName: string;
  status: "active" | "inactive" | "resigned";
  unitName: string | null;
  positionName: string | null;
}

interface AttendanceRecordRow {
  employeeId: string;
  attendanceDate: string;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  source: "manual" | "integration";
  sourceReference: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class AttendanceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AttendanceError";
  }
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function jakartaToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateDistanceInclusive(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  return Math.floor((toMs - fromMs) / 86_400_000) + 1;
}

export function resolveAttendanceRange(
  input: { from?: string | undefined; to?: string | undefined },
  today = jakartaToday(),
): { from: string; to: string } {
  const to = input.to ?? today;
  const from = input.from ?? shiftIsoDate(to, -29);

  if (!isIsoDate(from) || !isIsoDate(to)) {
    throw new AttendanceError(400, "INVALID_ATTENDANCE_RANGE", "Rentang tanggal tidak valid.");
  }
  if (from > to) {
    throw new AttendanceError(
      400,
      "INVALID_ATTENDANCE_RANGE",
      "Tanggal awal tidak boleh setelah tanggal akhir.",
    );
  }
  if (dateDistanceInclusive(from, to) > 62) {
    throw new AttendanceError(
      400,
      "ATTENDANCE_RANGE_TOO_LARGE",
      "Rentang kehadiran maksimal 62 hari.",
    );
  }

  return { from, to };
}

export function validateAttendanceTimes(input: {
  checkInAt: string | null;
  checkOutAt: string | null;
}) {
  if (!input.checkInAt && !input.checkOutAt) {
    throw new AttendanceError(
      400,
      "ATTENDANCE_TIME_REQUIRED",
      "Isi minimal jam masuk atau jam keluar.",
    );
  }

  if (input.checkInAt && input.checkOutAt) {
    const checkIn = new Date(input.checkInAt).getTime();
    const checkOut = new Date(input.checkOutAt).getTime();
    if (checkOut < checkIn) {
      throw new AttendanceError(
        400,
        "ATTENDANCE_TIME_ORDER_INVALID",
        "Jam keluar tidak boleh lebih awal dari jam masuk.",
      );
    }
  }
}

function mapRecord(row: AttendanceRecordRow) {
  return {
    employeeId: row.employeeId,
    attendanceDate: row.attendanceDate,
    checkInAt: row.checkInAt?.toISOString() ?? null,
    checkOutAt: row.checkOutAt?.toISOString() ?? null,
    source: row.source,
    sourceReference: row.sourceReference,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapEmployeeRecord(row: AttendanceRecordRow) {
  return {
    employeeId: row.employeeId,
    attendanceDate: row.attendanceDate,
    checkInAt: row.checkInAt?.toISOString() ?? null,
    checkOutAt: row.checkOutAt?.toISOString() ?? null,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadEmployeeByAccount(
  db: Pool | PoolClient,
  accountId: string,
): Promise<EmployeeRow> {
  const result = await db.query<EmployeeRow>(
    `SELECT
      e.id,
      e.employee_number AS "employeeNumber",
      e.full_name AS "fullName",
      e.status,
      u.name AS "unitName",
      p.name AS "positionName"
    FROM accounts a
    JOIN employees e ON e.id = a.employee_id
    LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
    LEFT JOIN positions p ON p.id = e.position_id
    WHERE a.id = $1
      AND a.principal_type = 'EMPLOYEE'
      AND a.status = 'active'`,
    [accountId],
  );

  const employee = result.rows[0];
  if (!employee || employee.status !== "active") {
    throw new AttendanceError(
      403,
      "EMPLOYEE_NOT_ACTIVE",
      "Akun tidak terhubung ke pegawai aktif.",
    );
  }
  return employee;
}

async function loadEmployeeById(db: Pool | PoolClient, employeeId: string): Promise<EmployeeRow> {
  const result = await db.query<EmployeeRow>(
    `SELECT
      e.id,
      e.employee_number AS "employeeNumber",
      e.full_name AS "fullName",
      e.status,
      u.name AS "unitName",
      p.name AS "positionName"
    FROM employees e
    LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
    LEFT JOIN positions p ON p.id = e.position_id
    WHERE e.id = $1`,
    [employeeId],
  );

  const employee = result.rows[0];
  if (!employee) {
    throw new AttendanceError(404, "EMPLOYEE_NOT_FOUND", "Pegawai tidak ditemukan.");
  }
  return employee;
}

async function loadRecords(
  db: Pool | PoolClient,
  employeeId: string,
  range: { from: string; to: string },
): Promise<AttendanceRecordRow[]> {
  const result = await db.query<AttendanceRecordRow>(
    `WITH canonical AS (
       SELECT DISTINCT ON (employee_id, work_date)
         employee_id,
         work_date AS attendance_date,
         first_check_in_at AS check_in_at,
         last_check_out_at AS check_out_at,
         'integration'::text AS source,
         'canonical-result:' || id::text AS source_reference,
         NULL::text AS note,
         created_at,
         created_at AS updated_at
       FROM attendance_result_versions
       WHERE employee_id = $1
         AND work_date BETWEEN $2::date AND $3::date
       ORDER BY employee_id, work_date, version DESC
     ),
     compatibility AS (
       SELECT legacy.*
       FROM attendance_daily_records legacy
       WHERE legacy.employee_id = $1
         AND legacy.attendance_date BETWEEN $2::date AND $3::date
         AND NOT EXISTS (
           SELECT 1 FROM canonical current
           WHERE current.attendance_date = legacy.attendance_date
         )
     )
     SELECT
       employee_id AS "employeeId",
       attendance_date::text AS "attendanceDate",
       check_in_at AS "checkInAt",
       check_out_at AS "checkOutAt",
       source,
       source_reference AS "sourceReference",
       note,
       created_at AS "createdAt",
       updated_at AS "updatedAt"
     FROM canonical
     UNION ALL
     SELECT
       employee_id AS "employeeId",
       attendance_date::text AS "attendanceDate",
       check_in_at AS "checkInAt",
       check_out_at AS "checkOutAt",
       source,
       source_reference AS "sourceReference",
       note,
       created_at AS "createdAt",
       updated_at AS "updatedAt"
     FROM compatibility
     ORDER BY "attendanceDate" DESC`,
    [employeeId, range.from, range.to],
  );
  return result.rows;
}

export function assertManualAttendanceMutation(record: Pick<AttendanceRecordRow, "source"> | undefined) {
  if (record?.source === "integration") {
    throw new AttendanceError(
      409,
      "INTEGRATED_ATTENDANCE_IMMUTABLE",
      "Rekaman integrasi tidak dapat diubah langsung melalui koreksi manual.",
    );
  }
}

async function authenticate(
  auth: AuthService,
  request: FastifyRequest,
  reply: FastifyReply,
  expected: "EMPLOYEE" | AdminPermission | readonly AdminPermission[],
): Promise<AuthPrincipal | null> {
  try {
    return expected === "EMPLOYEE"
      ? await requirePrincipalFromCookie(auth, request.headers.cookie, expected)
      : await requirePermissionsFromCookie(auth, request.headers.cookie, expected);
  } catch (error) {
    if (error instanceof AuthError) {
      reply.header("Cache-Control", "no-store");
      await reply.status(error.statusCode).send({ code: error.code, message: error.message });
      return null;
    }
    throw error;
  }
}

async function sendAttendanceError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof AttendanceError)) throw error;
  reply.header("Cache-Control", "no-store");
  return reply.status(error.statusCode).send({ code: error.code, message: error.message });
}

export async function registerAttendanceRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for attendance routes");
  }

  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  app.get("/attendance/me", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "EMPLOYEE");
    if (!principal) return;

    const parsed = rangeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "INVALID_ATTENDANCE_RANGE",
        message: "Rentang tanggal tidak valid.",
      });
    }

    try {
      const range = resolveAttendanceRange(parsed.data);
      const employee = await loadEmployeeByAccount(pool, principal.id);
      const records = await loadRecords(pool, employee.id, range);
      reply.header("Cache-Control", "no-store");
      return reply.send({
        referenceDate: jakartaToday(),
        range,
        employee,
        items: records.map(mapEmployeeRecord),
      });
    } catch (error) {
      return sendAttendanceError(reply, error);
    }
  });

  app.get("/admin/attendance/employees/:employeeId", async (request, reply) => {
    const principal = await authenticate(auth, request, reply, "attendance.records.manage");
    if (!principal) return;

    const params = employeeParamSchema.safeParse(request.params);
    const query = rangeQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.status(400).send({
        code: "INVALID_ATTENDANCE_REQUEST",
        message: "Pegawai atau rentang tanggal tidak valid.",
      });
    }

    try {
      const range = resolveAttendanceRange(query.data);
      const employee = await loadEmployeeById(pool, params.data.employeeId);
      const records = await loadRecords(pool, employee.id, range);
      reply.header("Cache-Control", "no-store");
      return reply.send({ range, employee, items: records.map(mapRecord) });
    } catch (error) {
      return sendAttendanceError(reply, error);
    }
  });

  app.put(
    "/admin/attendance/employees/:employeeId/:attendanceDate",
    async (request, reply) => {
      const principal = await authenticate(auth, request, reply, "attendance.records.manage");
      if (!principal) return;

      const params = recordParamSchema.safeParse(request.params);
      const body = writeRecordSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({
          code: "INVALID_ATTENDANCE_RECORD",
          message: "Rekaman kehadiran tidak valid.",
        });
      }

      try {
        validateAttendanceTimes(body.data);
        await loadEmployeeById(pool, params.data.employeeId);
        const clarificationId = randomUUID();
        const reason = body.data.note?.trim() || "Koreksi manual administrator";
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `INSERT INTO attendance_clarifications (
               id, employee_id, work_date, kind, mode, reason,
               proposed_check_in_at, proposed_check_out_at, status,
               decided_by_account_id, decision_note, decided_at
             ) VALUES (
               $1, $2, $3::date, 'other', 'correction', $4,
               $5::timestamptz, $6::timestamptz, 'approved',
               $7, 'Canonical manual correction via ATT-001 compatibility route', now()
             )`,
            [
              clarificationId, params.data.employeeId, params.data.attendanceDate, reason,
              body.data.checkInAt, body.data.checkOutAt, principal.id,
            ],
          );
          const eventPayload = JSON.stringify({ compatibilityRoute: true, reason });
          await client.query(
            `INSERT INTO attendance_clarification_events (
               id, clarification_id, actor_account_id, event_type, payload
             ) VALUES
               ($1, $3, $4, 'submitted', $5::jsonb),
               ($2, $3, $4, 'approved', $5::jsonb)`,
            [randomUUID(), randomUUID(), clarificationId, principal.id, eventPayload],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }

        const canonical = await materializeAttendanceResult(
          pool,
          params.data.employeeId,
          params.data.attendanceDate,
        );
        const now = canonical.createdAt;
        const item: AttendanceRecordRow = {
          employeeId: params.data.employeeId,
          attendanceDate: params.data.attendanceDate,
          checkInAt: canonical.firstCheckInAt,
          checkOutAt: canonical.lastCheckOutAt,
          source: "integration",
          sourceReference: `canonical-result:${canonical.id}`,
          note: null,
          createdAt: now,
          updatedAt: now,
        };
        reply.header("Cache-Control", "no-store");
        return reply.send({ item: mapRecord(item), canonical: true, clarificationId });
      } catch (error) {
        return sendAttendanceError(reply, error);
      }
    },
  );

  app.delete(
    "/admin/attendance/employees/:employeeId/:attendanceDate",
    async (request, reply) => {
      const principal = await authenticate(auth, request, reply, "attendance.records.manage");
      if (!principal) return;
      const params = recordParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          code: "INVALID_ATTENDANCE_RECORD",
          message: "Pegawai atau tanggal tidak valid.",
        });
      }
      reply.header("Cache-Control", "no-store");
      return reply.status(409).send({
        code: "CANONICAL_ATTENDANCE_IS_APPEND_ONLY",
        message: "Fakta presensi canonical tidak dihapus. Gunakan koreksi manual dengan alasan agar riwayat audit tetap utuh.",
      });
    },
  );}
