import { z } from "zod";

/**
 * A `YYYY-MM-DD` string that is also a real calendar date.
 *
 * The leave routes used to check the shape only, so `2026-02-30` passed validation and reached
 * PostgreSQL as `$1::date`, which raises 22008 — an unmapped error that answered `500`. Refusing
 * it here turns it into each route's ordinary `400` for an invalid body (OPS-PILOT-TT-001,
 * 2026-11-26).
 */
export const isoCalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, "Tanggal tidak ada pada kalender.");
