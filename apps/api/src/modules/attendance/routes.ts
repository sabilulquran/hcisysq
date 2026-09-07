import type { AdminPermission } from "../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { requirePrincipalFromCookie, requirePermissionsFromCookie } from "../auth/authorization.js";
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
    `SELECT
      employee_id AS "employeeId",
      attendance_date::text AS "attendanceDate",
      check_in_at AS "checkInAt",
      check_out_at AS "checkOutAt",
      source,
      source_reference AS "sourceReference",
      note,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM attendance_daily_records
    WHERE employee_id = $1
      AND attendance_date BETWEEN $2::date AND $3::date
    ORDER BY attendance_date DESC`,
    [employeeId, range.from, range.to],
  );
  return result.rows;
}

function snapshotRecord(row: AttendanceRecordRow | undefined) {
  return row ? mapRecord(row) : null;
}

async function lockAttendanceKey(
  client: PoolClient,
  employeeId: string,
  attendanceDate: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`attendance:${employeeId}:${attendanceDate}`],
  );
}

async function loadRecordForUpdate(
  client: PoolClient,
  employeeId: string,
  attendanceDate: string,
): Promise<AttendanceRecordRow | undefined> {
  const result = await client.query<AttendanceRecordRow>(
    `SELECT
      employee_id AS "employeeId",
      attendance_date::text AS "attendanceDate",
      check_in_at AS "checkInAt",
      check_out_at AS "checkOutAt",
      source,
      source_reference AS "sourceReference",
      note,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM attendance_daily_records
    WHERE employee_id = $1 AND attendance_date = $2::date
    FOR UPDATE`,
    [employeeId, attendanceDate],
  );
  return result.rows[0];
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

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockAttendanceKey(client, params.data.employeeId, params.data.attendanceDate);
          const before = await loadRecordForUpdate(
            client,
            params.data.employeeId,
            params.data.attendanceDate,
          );
          assertManualAttendanceMutation(before);

          const result = await client.query<AttendanceRecordRow>(
            `INSERT INTO attendance_daily_records (
              employee_id,
              attendance_date,
              check_in_at,
              check_out_at,
              source,
              source_reference,
              note,
              created_by_account_id,
              updated_by_account_id
            ) VALUES ($1, $2::date, $3::timestamptz, $4::timestamptz, 'manual', NULL, $5, $6, $6)
            ON CONFLICT (employee_id, attendance_date) DO UPDATE SET
              check_in_at = EXCLUDED.check_in_at,
              check_out_at = EXCLUDED.check_out_at,
              note = EXCLUDED.note,
              updated_by_account_id = EXCLUDED.updated_by_account_id,
              updated_at = now()
            RETURNING
              employee_id AS "employeeId",
              attendance_date::text AS "attendanceDate",
              check_in_at AS "checkInAt",
              check_out_at AS "checkOutAt",
              source,
              source_reference AS "sourceReference",
              note,
              created_at AS "createdAt",
              updated_at AS "updatedAt"`,
            [
              params.data.employeeId,
              params.data.attendanceDate,
              body.data.checkInAt,
              body.data.checkOutAt,
              body.data.note,
              principal.id,
            ],
          );
          const after = result.rows[0];
          if (!after) throw new Error("Attendance upsert did not return a record");

          await client.query(
            `INSERT INTO attendance_daily_audit_events (
              id,
              employee_id,
              attendance_date,
              actor_account_id,
              action,
              before_record,
              after_record
            ) VALUES ($1, $2, $3::date, $4, $5, $6::jsonb, $7::jsonb)`,
            [
              randomUUID(),
              params.data.employeeId,
              params.data.attendanceDate,
              principal.id,
              before ? "updated" : "created",
              before ? JSON.stringify(snapshotRecord(before)) : null,
              JSON.stringify(snapshotRecord(after)),
            ],
          );
          await client.query("COMMIT");
          reply.header("Cache-Control", "no-store");
          return reply.send({ item: mapRecord(after) });
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
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

      try {
        await loadEmployeeById(pool, params.data.employeeId);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockAttendanceKey(client, params.data.employeeId, params.data.attendanceDate);
          const before = await loadRecordForUpdate(
            client,
            params.data.employeeId,
            params.data.attendanceDate,
          );
          if (!before) {
            throw new AttendanceError(
              404,
              "ATTENDANCE_RECORD_NOT_FOUND",
              "Rekaman kehadiran tidak ditemukan.",
            );
          }
          assertManualAttendanceMutation(before);

          await client.query(
            `DELETE FROM attendance_daily_records
             WHERE employee_id = $1 AND attendance_date = $2::date`,
            [params.data.employeeId, params.data.attendanceDate],
          );
          await client.query(
            `INSERT INTO attendance_daily_audit_events (
              id,
              employee_id,
              attendance_date,
              actor_account_id,
              action,
              before_record,
              after_record
            ) VALUES ($1, $2, $3::date, $4, 'deleted', $5::jsonb, NULL)`,
            [
              randomUUID(),
              params.data.employeeId,
              params.data.attendanceDate,
              principal.id,
              JSON.stringify(snapshotRecord(before)),
            ],
          );
          await client.query("COMMIT");
          reply.header("Cache-Control", "no-store");
          return reply.status(204).send();
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        return sendAttendanceError(reply, error);
      }
    },
  );
}
