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
] as const;

/**
 * The review threshold is guidance for a human, not a statutory rule, so its
 * absence must not refuse a calculation the way a missing BPJS policy does
 * (specification section 10 item 6).
 */
export const OPTIONAL_POLICY_KEYS = ["VARIANCE_THRESHOLD", "PERFORMANCE_PERCENT"] as const;

export const DEFAULT_VARIANCE_THRESHOLD = { relative: 0.1, absolute: 50_000, manualInput: 1_000_000 };

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

export const TER_CATEGORIES = ["A", "B", "C"] as const;
export type TerCategory = (typeof TER_CATEGORIES)[number];

/** The bukti potong object code for the monthly PPh21 of a permanent employee. */
export const PPH21_OBJECT_CODE = "21-100-01";

/**
 * A PTKP status as written in a profile ("TK/0", "k / 1") compared as one value:
 * no spaces, upper case. The mapping in PPH21_TER is matched the same way.
 */
export function normalizePtkpStatus(status: string): string {
  return status.replace(/\s+/g, "").toUpperCase();
}

/**
 * One TER table: brackets by monthly gross, ascending, the last one open-ended.
 * No value lives here; the brackets are the policy row the process owner loads
 * from the PP 58/2023 attachment (specification section 10 item 9).
 */
const terTable = z
  .array(z.object({ upTo: z.number().int().nonnegative().nullable(), rate: z.number().min(0).max(1) }))
  .min(1)
  .superRefine((brackets, ctx) => {
    brackets.forEach((bracket, index) => {
      const last = index === brackets.length - 1;
      if (last && bracket.upTo !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "upTo"],
          message: "lapisan terakhir harus upTo null (tanpa batas atas)",
        });
      }
      if (!last && bracket.upTo === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "upTo"],
          message: "hanya lapisan terakhir yang boleh tanpa batas atas",
        });
      }
      const previous = index > 0 ? brackets[index - 1]!.upTo : null;
      if (previous !== null && bracket.upTo !== null && bracket.upTo <= previous) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "upTo"],
          message: "batas lapisan harus naik berurutan",
        });
      }
    });
  });

/**
 * PERF-001 to PAY-003 (performance-review.md section 11): predicate to
 * performance percentage. The version is also the switch. With no version
 * effective on the pay date, or with `enabled: false`, payroll reads the
 * compensation profile exactly as before; nothing is guessed.
 */
const PERFORMANCE_PERCENT_SCHEMA = z
  .object({
    enabled: z.boolean(),
    // Optional while switched off, so HC can close the link with a minimal
    // `{ enabled: false }` version; required and non-empty while on.
    byPredicate: z
      .record(
        z.string().regex(/^[A-Z][A-Z0-9_]{0,15}$/, "kode predikat tidak valid"),
        z
          .number()
          .min(0)
          .max(2)
          // Same precision as the profile column, numeric(5, 4).
          .refine((value) => Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-6, "persentase paling banyak empat desimal"),
      )
      .optional(),
  })
  .refine((policy) => !policy.enabled || Object.keys(policy.byPredicate ?? {}).length > 0, {
    path: ["byPredicate"],
    message: "pemetaan predikat tidak boleh kosong selama sambungan menyala",
  });

export type PerformancePercentPolicy = z.infer<typeof PERFORMANCE_PERCENT_SCHEMA>;

const PPH21_TER_SCHEMA = z.object({
  // The legal reference the table was copied from, kept inside the payload so
  // the report can name it beside every figure it prints.
  source: z.string().trim().min(3).max(500),
  objectCode: z.literal(PPH21_OBJECT_CODE),
  ptkpCategory: z
    .record(z.string().trim().min(1).max(16), z.enum(TER_CATEGORIES))
    .refine((mapping) => Object.keys(mapping).length > 0, "pemetaan status PTKP tidak boleh kosong")
    .refine(
      (mapping) => new Set(Object.keys(mapping).map(normalizePtkpStatus)).size === Object.keys(mapping).length,
      "status PTKP tercantum lebih dari sekali",
    ),
  categories: z.object({ A: terTable, B: terTable, C: terTable }),
});

export type Pph21TerPolicy = z.infer<typeof PPH21_TER_SCHEMA>;

/** Reads a stored PPH21_TER payload, or says why it cannot be used. */
export function parsePph21TerPolicy(
  payload: unknown,
): { ok: true; policy: Pph21TerPolicy } | { ok: false; message: string } {
  const result = PPH21_TER_SCHEMA.safeParse(payload);
  if (result.success) return { ok: true, policy: result.data };
  const issue = result.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return { ok: false, message: `${where}${issue?.message ?? "bentuk kebijakan tidak sesuai"}` };
}

/**
 * Lines of the bukti potong 1721-A1 that earnings are summed into (PER-2/PJ/2024
 * layout, specification section 7.4). Insurance premiums and benefits in kind
 * are on the form but v1 pays neither (DRAFT).
 */
export const A1_LINE_KEYS = [
  "salary",
  "taxAllowance",
  "otherAllowances",
  "honorarium",
  "insurancePremium",
  "inKind",
  "bonusThr",
] as const;
export type A1LineKey = (typeof A1_LINE_KEYS)[number];

/**
 * The annual Pasal 17 calculation of the final masa pajak (PP 58/2023, PMK
 * 168/2023; specification section 7.4). Like PPH21_TER, no statutory value is
 * written in code: PTKP, biaya jabatan, the Pasal 17 layers and the rounding
 * unit are the policy row the process owner loads and verifies.
 */
const PPH21_ANNUAL_SCHEMA = z.object({
  source: z.string().trim().min(3).max(500),
  ptkp: z.object({
    taxpayer: rupiah.nonnegative(),
    married: rupiah.nonnegative(),
    perDependent: rupiah.nonnegative(),
    maxDependents: z.number().int().min(0).max(10),
  }),
  positionCost: z.object({
    rate: z.number().min(0).max(1),
    monthlyCap: rupiah.nonnegative(),
    annualCap: rupiah.nonnegative(),
  }),
  brackets: terTable,
  /** PKP is rounded down to a whole multiple of this (Rp1.000 under the law). */
  pkpRoundingUnit: z.number().int().min(1),
  /** DEDUCTION components that are the employee's own pension / JHT contribution. */
  pensionContributionComponents: z.array(z.string().trim().min(1)).default([]),
  /** Overrides of the default A1 line per EARNING component (pph21-annual.ts). */
  lineByComponent: z.record(z.string().trim().min(1), z.enum(A1_LINE_KEYS)).default({}),
  /** The pemotong printed on the 1721-A1; its NPWP is the yayasan's, not personal data. */
  withholder: z
    .object({ name: z.string().trim().min(1).max(200), taxNumber: z.string().trim().max(30).nullable().default(null) })
    .default({ name: "Yayasan Sabilul Qur'an", taxNumber: null }),
});

export type Pph21AnnualPolicy = z.infer<typeof PPH21_ANNUAL_SCHEMA>;

/** Bukti potong object code for pegawai tidak tetap (PMK 168/2023). */
export const PPH21_NON_PERMANENT_OBJECT_CODE = "21-100-03";

/**
 * PPh21 switches (specification section 7.5, decisions P6 and P10). Both are off
 * by default, and a missing row means off: the yayasan does not bear the tax and
 * honorer/lepas stay on monthly TER under 21-100-01, which is what v1 did before.
 * The daily TER table is policy like every other table, never code.
 */
const PPH21_SETTINGS_SCHEMA = z
  .object({
    source: z.string().trim().min(3).max(500),
    /** P6: the yayasan bears PPh21, written as a PPH21_EMPLOYER line on each result. */
    employerBorne: z.boolean().default(false),
    /** P10: KONTRAK_HONORER and LEPAS are taxed with daily TER under 21-100-03. */
    nonPermanentDailyTer: z.boolean().default(false),
    daily: z
      .object({
        objectCode: z.literal(PPH21_NON_PERMANENT_OBJECT_CODE),
        /** Layers by average gross per attendance day, ascending, the last open-ended. */
        brackets: terTable,
        /**
         * Above this average daily gross the law leaves daily TER (Pasal 17 on 50%
         * of gross); v1 does not compute that and flags the row instead (DRAFT).
         */
        dailyCeiling: z.number().int().positive().nullable().default(null),
      })
      .nullable()
      .default(null),
  })
  .superRefine((settings, ctx) => {
    if (settings.nonPermanentDailyTer && settings.daily === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["daily"],
        message: "tabel TER harian wajib diisi bila nonPermanentDailyTer aktif",
      });
    }
  });

export type Pph21Settings = z.infer<typeof PPH21_SETTINGS_SCHEMA>;

/** Off/off: the behaviour without a PPH21_SETTINGS row. */
export const DEFAULT_PPH21_SETTINGS: Pph21Settings = {
  source: "bawaan",
  employerBorne: false,
  nonPermanentDailyTer: false,
  daily: null,
};

export function parsePph21Settings(
  payload: unknown,
): { ok: true; settings: Pph21Settings } | { ok: false; message: string } {
  const result = PPH21_SETTINGS_SCHEMA.safeParse(payload);
  if (result.success) return { ok: true, settings: result.data };
  const issue = result.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return { ok: false, message: `${where}${issue?.message ?? "bentuk kebijakan tidak sesuai"}` };
}

/** Reads a stored PPH21_ANNUAL payload, or says why it cannot be used. */
export function parsePph21AnnualPolicy(
  payload: unknown,
): { ok: true; policy: Pph21AnnualPolicy } | { ok: false; message: string } {
  const result = PPH21_ANNUAL_SCHEMA.safeParse(payload);
  if (result.success) return { ok: true, policy: result.data };
  const issue = result.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return { ok: false, message: `${where}${issue?.message ?? "bentuk kebijakan tidak sesuai"}` };
}

const PAYLOAD_SCHEMAS = {
  SALARY_SCALE: z.object({
    // The legacy scale is chained percentage rises, so its entries are not whole
    // rupiah, and BASIC rounds up only after the unit or work-pattern multiplier.
    // Rounding the table first would move a Half Day salary by a rupiah against
    // the spreadsheet; BASIC itself is still a whole rupiah (PAY-003-MIG §3.4).
    scale: z.record(z.enum(EDUCATION_LEVELS), z.array(z.number().finite().nonnegative()).min(1)),
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
  PERFORMANCE_PERCENT: PERFORMANCE_PERCENT_SCHEMA,
  // Not read by the engine: the PPh21 report reads it (reports.ts, pph21.ts).
  PPH21_TER: PPH21_TER_SCHEMA,
  // Read by the annual calculation and the 1721-A1 (pph21-annual.ts).
  PPH21_ANNUAL: PPH21_ANNUAL_SCHEMA,
  // Read by the PPh21 report, the annual calculation and the calculation (section 7.5).
  PPH21_SETTINGS: PPH21_SETTINGS_SCHEMA,
} as const;

/**
 * Checks one policy payload against the shape the engine needs. The write path
 * calls this so a typo comes back as a refused request, rather than as a period
 * that cannot be calculated at all weeks later.
 */
export function validatePolicyPayload(
  policyKey: string,
  payload: unknown,
): { ok: true } | { ok: false; message: string } {
  const schema = (PAYLOAD_SCHEMAS as Record<string, { safeParse: (value: unknown) => { success: boolean; error?: { issues: Array<{ path: Array<string | number>; message: string }> } } }>)[policyKey];
  // Every accepted key has a schema, PPH21_TER included; an unknown key is the
  // route's enum to refuse, not this function's.
  if (!schema) return { ok: true };
  const result = schema.safeParse(payload);
  if (result.success) return { ok: true };
  const issue = result.error?.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return { ok: false, message: `${where}${issue?.message ?? "bentuk kebijakan tidak sesuai"}` };
}

export type PolicyResolution =
  | {
      ok: true;
      policy: PayrollPolicy;
      versionIds: string[];
      variance: { relative: number; absolute: number; manualInput: number };
      /**
       * The predicate mapping when the link to PERF-001 is switched on for this
       * pay date, otherwise null. A version with `enabled: false` reads as null
       * and is not added to versionIds, so a switched-off period stores exactly
       * what it stored before the link existed.
       */
      performancePercent: { versionId: string; byPredicate: Readonly<Record<string, number>> } | null;
    }
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
  const varianceRow = (byKey.get("VARIANCE_THRESHOLD") ?? [])[0];
  const varianceParsed = varianceRow
    ? PAYLOAD_SCHEMAS.VARIANCE_THRESHOLD.safeParse(varianceRow.payload)
    : null;
  const variance = varianceParsed?.success ? varianceParsed.data : DEFAULT_VARIANCE_THRESHOLD;
  if (varianceRow && varianceParsed?.success) versionIds.push(varianceRow.id);

  // Unlike the review threshold, a malformed mapping fails closed: falling back
  // to the profile would quietly pay the old figure while HC believes the link
  // is on. The write path already refuses such a payload, so this only catches
  // a row written around it.
  let performancePercent: Extract<PolicyResolution, { ok: true }>["performancePercent"] = null;
  const performanceRows = byKey.get("PERFORMANCE_PERCENT") ?? [];
  if (performanceRows.length > 1) {
    return {
      ok: false,
      problems: [
        {
          policyKey: "PERFORMANCE_PERCENT",
          code: "DUPLICATE",
          message: "Lebih dari satu versi kebijakan PERFORMANCE_PERCENT berlaku pada tanggal periode ini.",
        },
      ],
    };
  }
  const performanceRow = performanceRows[0];
  if (performanceRow) {
    const performanceParsed = PERFORMANCE_PERCENT_SCHEMA.safeParse(performanceRow.payload);
    if (!performanceParsed.success) {
      return {
        ok: false,
        problems: [
          {
            policyKey: "PERFORMANCE_PERCENT",
            code: "INVALID",
            message: `Isi kebijakan PERFORMANCE_PERCENT tidak sesuai bentuk yang dibutuhkan: ${performanceParsed.error.issues[0]?.message ?? "tidak valid"}.`,
          },
        ],
      };
    }
    if (performanceParsed.data.enabled) {
      performancePercent = { versionId: performanceRow.id, byPredicate: performanceParsed.data.byPredicate ?? {} };
      versionIds.push(performanceRow.id);
    }
  }

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

  return { ok: true, policy, versionIds, variance, performancePercent };
}
