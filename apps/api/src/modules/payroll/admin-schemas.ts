// PAY-003 reference data request shapes, shared by the HTTP routes and the
// initial-load CLI (PAY-003-MIG) so a row the CLI accepts is a row the route
// would accept too.

import { z } from "zod";

import { POLICY_KEYS } from "./policy.js";

/**
 * Marks rows the PAY-003-MIG initial load wrote. Only the CLI may write it: a
 * policy version carrying it can be corrected in place while unused
 * (PAY-003-MIG section 5.4), so the HTTP route refuses a source that contains it.
 */
export const MIGRATION_MARKER = "[PAY-003-MIG]";

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal harus berformat YYYY-MM-DD");

export const policyBody = z.object({
  policyKey: z.enum([...POLICY_KEYS, "VARIANCE_THRESHOLD", "PPH21_TER"] as [string, ...string[]]),
  effectiveFrom: isoDate,
  payload: z.record(z.string(), z.unknown()),
  source: z.string().trim().min(3).max(500),
  note: z.string().trim().max(500).optional(),
  // Opening a version that reaches back into a period already calculated needs
  // to be said out loud, with a reason that goes into the note.
  backdateReason: z.string().trim().min(10).max(500).optional(),
});

export const profileBody = z.object({
  effectiveFrom: isoDate,
  backdateReason: z.string().trim().min(10).max(500).optional(),
  education: z.enum(["SD", "SMP", "SLTA", "D1_D2", "D3_D4", "S1", "S2_S3"]).nullable().optional(),
  workPattern: z.enum(["FULL", "HALF_DAY", "HALF_DAY_II"]).nullable().optional(),
  unitRef: z.string().uuid().nullable().optional(),
  functionalPositionRef: z.string().uuid().nullable().optional(),
  structuralPositionRef: z.string().uuid().nullable().optional(),
  teachingHoursPerWeek: z.number().min(0).max(168).nullable().optional(),
  spouseCount: z.number().int().min(0).max(4).optional(),
  childCount: z.number().int().min(0).max(20).optional(),
  registeredDependants: z.number().int().min(0).max(24).optional(),
  specialQualificationTarget: z.number().int().min(0).nullable().optional(),
  annualPerformanceRate: z.number().min(0).max(2).nullable().optional(),
  monthlyPerformanceRate: z.number().min(0).max(2).nullable().optional(),
  bpjsSegment: z.enum(["PPU_YAYASAN", "PBI", "MANDIRI", "BELUM_TERDAFTAR"]).optional(),
  bpjsActiveFrom: isoDate.nullable().optional(),
  bpjsExtraFamilyOverride: z.number().int().min(0).max(20).nullable().optional(),
  bpjsExtraFamilyOverrideReason: z.string().trim().max(500).nullable().optional(),
  bpjsDecisionReference: z.string().trim().max(200).nullable().optional(),
  ptkpStatus: z.string().trim().max(16).nullable().optional(),
  pjMediaRatePerContent: z.number().int().min(0).nullable().optional(),
  // The transfer list prints the bank beside the account, so the profile has
  // to be able to carry one; before this it could only ever be empty there.
  bankName: z.string().trim().max(120).nullable().optional(),
  bankAccountNumber: z.string().trim().max(64).nullable().optional(),
  bankAccountName: z.string().trim().max(200).nullable().optional(),
});

export const loanBody = z.object({
  employeeId: z.string().uuid(),
  grantedOn: isoDate,
  principal: z.number().int().positive(),
  instalment: z.number().int().positive().nullable().optional(),
  note: z.string().trim().max(500).optional(),
});
