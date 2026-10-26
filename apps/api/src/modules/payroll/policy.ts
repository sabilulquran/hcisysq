/**
 * PAY-003 policy resolution: versioned policy rows into the PayrollPolicy the
 * engine takes. No statutory value is written here; every rate, floor, ceiling
 * and table comes from the rows, so a regulation change adds a version rather
 * than a release (specification section 10 item 9).
 */

import { z } from "zod";

import type { EducationLevel, PayrollPolicy } from "./engine.js";

export const POLICY_KEYS = [
  "SALARY_SCALE",
  "BASIC_MULTIPLIER",
  "TEACHING_HOURS",
  "PERFORMANCE",
  "FAMILY",
  "FUNCTIONAL_ALLOWANCE",
  "POSITIONAL_ALLOWANCE",
  "OVERTIME",
  "BPJS_KESEHATAN",
  "CONTRACT_RATES",
  "EARLY_SERVICE",
  "VARIANCE_THRESHOLD",
] as const;

export type PolicyKey = (typeof POLICY_KEYS)[number];

export type PolicyVersionRow = {
  id: string;
  policyKey: string;
  payload: unknown;
};

const rupiah = z.number().int();
const rate = z.number().min(0);
const amountByRef = z.record(z.string(), rupiah);

const EDUCATION_LEVELS = ["SD", "SMP", "SLTA", "D1_D2", "D3_D4", "S1", "S2_S3"] as const;

const PAYLOAD_SCHEMAS = {
  SALARY_SCALE: z.object({
    scale: z.record(z.enum(EDUCATION_LEVELS), z.array(rupiah).min(1)),
  }),
  BASIC_MULTIPLIER: z.object({
    units: z.record(z.string(), z.number().positive()),
    knownUnitRefs: z.array(z.string()),
    workPatterns: z.record(z.string(), z.number().positive()),
  }),
  TEACHING_HOURS: z.object({
    monthlyHourLimit: z.number().positive(),
    overRatePerHour: rupiah,
    shortRatePerHour: rupiah,
    weeksPerMonth: z.number().positive(),
  }),
  PERFORMANCE: z.object({
    defaultBase: rupiah,
    baseByPosition: amountByRef,
    annualShare: rate,
    monthlyShare: rate,
    unratedBelowOneYear: z.object({ annualRate: rate, monthlyRate: rate }),
  }),
  FAMILY: z.object({ spouseRate: rate, childRate: rate }),
  FUNCTIONAL_ALLOWANCE: z.object({
    byPosition: amountByRef,
    concurrentStructuralFactor: rate,
    excludedUnits: z.array(z.string()),
    positionsWithoutAllowance: z.array(z.string()),
  }),
  POSITIONAL_ALLOWANCE: z.object({
    byPosition: amountByRef,
    unitMultipliers: z.record(z.string(), z.number().positive()),
    positionsWithoutAllowance: z.array(z.string()),
  }),
  OVERTIME: z.object({ monthlyHourDivisor: z.number().positive() }),
  BPJS_KESEHATAN: z.object({
    contributionRate: rate,
    extraFamilyRate: rate,
    floor: rupiah,
    ceiling: rupiah,
    coveredChildren: z.number().int().min(0),
    fixedAllowanceComponents: z.array(z.string()),
  }),
  CONTRACT_RATES: z.object({ transportPerAttendance: rupiah, teachingFeePerHour: rupiah }),
  EARLY_SERVICE: z.object({ months: z.number().int().min(0), netRate: rate }),
  VARIANCE_THRESHOLD: z.object({ relative: rate, absolute: rupiah, manualInput: rupiah }),
} as const;

export type PolicyResolution =
  | { ok: true; policy: PayrollPolicy; versionIds: string[]; variance: { relative: number; absolute: number; manualInput: number } }
  | { ok: false; problems: PolicyProblem[] };

export type PolicyProblem = {
  policyKey: string;
  code: "MISSING" | "DUPLICATE" | "INVALID";
  message: string;
};

/**
 * Builds the policy for one pay date. Callers pass the rows already filtered to
 * the versions effective on that date; this function only checks that each key
 * appears exactly once and that its payload has the shape the engine needs.
 */
export function resolvePolicy(rows: readonly PolicyVersionRow[]): PolicyResolution {
  const problems: PolicyProblem[] = [];
  const byKey = new Map<string, PolicyVersionRow[]>();
  for (const row of rows) {
    byKey.set(row.policyKey, [...(byKey.get(row.policyKey) ?? []), row]);
  }

  const parsed: Partial<Record<PolicyKey, unknown>> = {};
  const versionIds: string[] = [];

  for (const key of POLICY_KEYS) {
    const found = byKey.get(key) ?? [];
    if (found.length === 0) {
      problems.push({
        policyKey: key,
        code: "MISSING",
        message: `Kebijakan ${key} tidak tersedia untuk tanggal periode ini.`,
      });
      continue;
    }
    if (found.length > 1) {
      // The database already forbids overlapping versions; this catches a caller
      // that passed rows from more than one date.
      problems.push({
        policyKey: key,
        code: "DUPLICATE",
        message: `Lebih dari satu versi kebijakan ${key} berlaku pada tanggal periode ini.`,
      });
      continue;
    }
    const result = PAYLOAD_SCHEMAS[key].safeParse(found[0]!.payload);
    if (!result.success) {
      problems.push({
        policyKey: key,
        code: "INVALID",
        message: `Isi kebijakan ${key} tidak sesuai bentuk yang dibutuhkan: ${result.error.issues[0]?.message ?? "tidak valid"}.`,
      });
      continue;
    }
    parsed[key] = result.data;
    versionIds.push(found[0]!.id);
  }

  if (problems.length > 0) return { ok: false, problems };

  const scale = parsed.SALARY_SCALE as z.infer<typeof PAYLOAD_SCHEMAS.SALARY_SCALE>;
  const multiplier = parsed.BASIC_MULTIPLIER as z.infer<typeof PAYLOAD_SCHEMAS.BASIC_MULTIPLIER>;
  const teaching = parsed.TEACHING_HOURS as z.infer<typeof PAYLOAD_SCHEMAS.TEACHING_HOURS>;
  const performance = parsed.PERFORMANCE as z.infer<typeof PAYLOAD_SCHEMAS.PERFORMANCE>;
  const family = parsed.FAMILY as z.infer<typeof PAYLOAD_SCHEMAS.FAMILY>;
  const functional = parsed.FUNCTIONAL_ALLOWANCE as z.infer<typeof PAYLOAD_SCHEMAS.FUNCTIONAL_ALLOWANCE>;
  const positional = parsed.POSITIONAL_ALLOWANCE as z.infer<typeof PAYLOAD_SCHEMAS.POSITIONAL_ALLOWANCE>;
  const overtime = parsed.OVERTIME as z.infer<typeof PAYLOAD_SCHEMAS.OVERTIME>;
  const bpjs = parsed.BPJS_KESEHATAN as z.infer<typeof PAYLOAD_SCHEMAS.BPJS_KESEHATAN>;
  const contract = parsed.CONTRACT_RATES as z.infer<typeof PAYLOAD_SCHEMAS.CONTRACT_RATES>;
  const earlyService = parsed.EARLY_SERVICE as z.infer<typeof PAYLOAD_SCHEMAS.EARLY_SERVICE>;
  const variance = parsed.VARIANCE_THRESHOLD as z.infer<typeof PAYLOAD_SCHEMAS.VARIANCE_THRESHOLD>;

  const policy: PayrollPolicy = {
    salaryScale: scale.scale as Partial<Record<EducationLevel, readonly number[]>>,
    unitBasicMultipliers: multiplier.units,
    knownUnitRefs: multiplier.knownUnitRefs,
    workPatternBasicMultipliers: multiplier.workPatterns,
    teaching,
    performance,
    family,
    functionalAllowance: functional,
    positionalAllowance: positional,
    overtime,
    bpjsKesehatan: {
      ...bpjs,
      fixedAllowanceComponents: bpjs.fixedAllowanceComponents as PayrollPolicy["bpjsKesehatan"]["fixedAllowanceComponents"],
    },
    contract,
    earlyService,
  };

  return { ok: true, policy, versionIds, variance };
}
