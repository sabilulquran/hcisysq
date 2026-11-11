/**
 * PAY-003-MIG: initial load of payroll reference data (policy versions,
 * compensation profiles, loans) from a file prepared outside the repository.
 *
 * Specification: docs/domain/payroll-initial-data-load.md
 *
 * The plan is built inside a READ ONLY transaction and nothing is guessed: a
 * row that cannot be matched is reported with a code and left out. Writes go
 * through the same store functions as the HTTP routes, so every row gets the
 * route's audit event. Output carries counts, codes, policy keys and the
 * operator's row identifiers only, never a name, NIP, amount or account number.
 */

import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { resolveAuthorizationContext } from "../auth/permissions.js";
import { isoDate, loanBody, MIGRATION_MARKER, policyBody, profileBody } from "./admin-schemas.js";
import {
  correctLoadedPolicyVersion,
  createLoan,
  openCompensationProfile,
  openPolicyVersion,
  PROFILE_COLUMNS,
  settledPeriodConflict,
  type CompensationProfileRow,
  type NewCompensationProfile,
} from "./admin-store.js";
import { ownEmploymentIds } from "./inputs-store.js";
import { validatePolicyPayload } from "./policy.js";
import { writeAudit } from "./store.js";

export const INITIAL_LOAD_FORMAT = "PAY-003-MIG/1";

/** Written into every policy source and loan note, so a rollback can find the rows (spec §8). */
export { MIGRATION_MARKER };

export const DEFAULT_LOAN_NOTE = `Saldo kasbon pindahan dari spreadsheet legacy ${MIGRATION_MARKER}`;

/**
 * Fixed namespaces for the uuid v5 position references (spec §4). Changing one
 * changes every reference already stored, so they never change.
 */
export const PAYROLL_REF_NAMESPACE = {
  functional: "6f1d2a43-58c0-4d7e-9a35-2b1e7c90a4f1",
  structural: "c3b8e0d5-91a7-4f26-8b4c-7d5a2e16f093",
} as const;

export type PositionKind = keyof typeof PAYROLL_REF_NAMESPACE;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 4122 name-based uuid, version 5 (SHA-1). */
export function uuidV5(name: string, namespace: string): string {
  if (!UUID.test(namespace)) throw new Error("namespace must be a uuid");
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(namespaceBytes).update(Buffer.from(name, "utf8")).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Same normalisation as the employee import uses for unit and position names. */
export function normalizeLabel(value: string): string {
  // JavaScript's trim() and \s already cover the no-break space the import replaces by hand.
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function positionRef(kind: PositionKind, label: string): string {
  return uuidV5(normalizeLabel(label), PAYROLL_REF_NAMESPACE[kind]);
}

// ---------------------------------------------------------------------------
// Input shape

// Strict, so a misspelt section ("loan" for "loans") is refused rather than
// silently loading nothing.
const fileShape = z
  .object({
    format: z.literal(INITIAL_LOAD_FORMAT),
    policies: z.array(z.record(z.string(), z.unknown())).default([]),
    profiles: z.array(z.record(z.string(), z.unknown())).default([]),
    loans: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .strict();

/** A calendar date that exists; the route's pattern alone accepts 2026-02-30. */
export function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

const realDate = isoDate.refine(isRealDate, "Tanggal tidak ada di kalender");

/** At most `digits` decimal places, so what the numeric column stores is what the file says. */
function decimals(digits: number) {
  return (value: number | null | undefined) =>
    value === null || value === undefined || Math.abs(Math.round(value * 10 ** digits) - value * 10 ** digits) < 1e-6;
}

const rowId = z.string().trim().min(1).max(64).optional();
const label = z.string().trim().min(1).max(200).nullable().optional();

// The route shapes, minus what an initial load must not do: no backdating, and
// references come in as labels the CLI resolves rather than as raw uuids.
const policyRow = policyBody
  .omit({ backdateReason: true })
  .extend({
    rowId,
    effectiveFrom: realDate,
    // Corrects, in place, a version this load opened on the same date that no
    // calculation has used yet (spec §5.4). Without it a changed row is refused.
    correctionReason: z.string().trim().min(10).max(500).optional(),
  })
  .strict();

const profileRow = profileBody
  .omit({ backdateReason: true, unitRef: true, functionalPositionRef: true, structuralPositionRef: true })
  .extend({
    rowId,
    nip: z.string().trim().min(1).max(64),
    effectiveFrom: realDate,
    bpjsActiveFrom: realDate.nullable().optional(),
    unit: label,
    functional: label,
    structural: label,
    legacyServiceStartDate: realDate.nullable().optional(),
  })
  .strict()
  // numeric(6,2) and numeric(5,4): a value with more places would be rounded by
  // PostgreSQL and then never compare equal on a re-run.
  .refine((row) => decimals(2)(row.teachingHoursPerWeek), { path: ["teachingHoursPerWeek"] })
  .refine((row) => decimals(4)(row.annualPerformanceRate) && decimals(4)(row.monthlyPerformanceRate), {
    path: ["annualPerformanceRate"],
  });

const loanRow = loanBody
  .omit({ employeeId: true })
  .extend({ rowId, nip: z.string().trim().min(1).max(64), grantedOn: realDate })
  .strict();

/**
 * Where a policy payload holds references. After resolution every key or
 * element here must be a uuid: a misspelt symbol ("Functional:" or
 * "funtional:") would otherwise stay a literal key that nothing ever matches.
 */
const REFERENCE_FIELDS: Readonly<Record<string, { keys: readonly string[]; elements: readonly string[] }>> = {
  BASIC_MULTIPLIER: { keys: ["units"], elements: ["knownUnitRefs"] },
  PERFORMANCE: { keys: ["baseByPosition"], elements: [] },
  FUNCTIONAL_ALLOWANCE: { keys: ["byPosition"], elements: ["excludedUnits", "positionsWithoutAllowance"] },
  POSITIONAL_ALLOWANCE: { keys: ["byPosition", "unitMultipliers"], elements: ["positionsWithoutAllowance"] },
};

export function referencesAreUuids(policyKey: string, payload: Record<string, unknown>): boolean {
  const fields = REFERENCE_FIELDS[policyKey];
  if (!fields) return true;
  for (const field of fields.keys) {
    const value = payload[field];
    if (value && typeof value === "object" && Object.keys(value).some((key) => !UUID.test(key))) return false;
  }
  for (const field of fields.elements) {
    const value = payload[field];
    if (Array.isArray(value) && value.some((item) => typeof item !== "string" || !UUID.test(item))) return false;
  }
  return true;
}

export type InitialLoadFile = z.infer<typeof fileShape>;

export function parseInitialLoadFile(raw: unknown): InitialLoadFile {
  const parsed = fileShape.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new Error(`Berkas masukan tidak sesuai format ${INITIAL_LOAD_FORMAT}: ${where}${issue?.message ?? "tidak valid"}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Report shape

export type ErrorCode =
  | "INVALID"
  | "DUPLICATE_ROW"
  | "EMPLOYEE_NOT_FOUND"
  | "EMPLOYMENT_MISSING"
  | "EMPLOYMENT_AMBIGUOUS"
  | "UNIT_UNKNOWN"
  | "OWN_RECORD"
  | "EXISTS_DIFFERENT"
  | "LATER_VERSION_EXISTS"
  | "SETTLED_PERIOD"
  | "CORRECTION_TARGET_MISSING"
  | "VERSION_NOT_FROM_LOAD"
  | "VERSION_IN_USE";

export type WarningCode =
  | "TMT_DIFFERS"
  | "OUT_OF_PAYROLL_SCOPE"
  | "UNIT_NOT_IN_POLICY"
  | "POSITION_NOT_IN_POLICY"
  | "SUPERSEDES_VERSION"
  | "OPEN_LOAN_EXISTS";

export type RowOutcome = "CREATE" | "CORRECT" | "UNCHANGED" | "ERROR";

type PlannedRow<T> = {
  rowId: string;
  outcome: RowOutcome;
  errors: ErrorCode[];
  warnings: WarningCode[];
  write: T | null;
};

export type SectionReport = {
  total: number;
  create: number;
  /** Policy rows that correct a loaded, unused version in place (spec §5.4). */
  correct: number;
  unchanged: number;
  error: number;
  errors: Partial<Record<ErrorCode, number>>;
  warnings: Partial<Record<WarningCode, number>>;
  /** Rows with an error or a warning, by the operator's row identifier. */
  issues: Array<{ rowId: string; outcome: RowOutcome; errors: ErrorCode[]; warnings: WarningCode[] }>;
};

export type InitialLoadReport = {
  mode: "dry-run" | "apply";
  format: string;
  startedAt: string;
  actor: { checked: boolean; problems: string[] };
  policies: SectionReport & { byKey: Record<string, RowOutcome | ErrorCode> };
  profiles: SectionReport;
  loans: SectionReport;
  written?: { policies: number; profiles: number; loans: number };
};

type PolicyWrite = {
  policyKey: string;
  effectiveFrom: string;
  payload: Record<string, unknown>;
  source: string;
  note?: string;
  /** Present when the row corrects an existing version in place. */
  correction?: { versionId: string; reason: string };
};
type ProfileWrite = NewCompensationProfile & { employmentId: string; effectiveFrom: string };
type LoanWrite = { employeeId: string; grantedOn: string; principal: number; instalment: number | null; note: string };

type Plan = {
  actorProblems: string[];
  actorChecked: boolean;
  policies: Array<PlannedRow<PolicyWrite> & { policyKey: string | null }>;
  profiles: Array<PlannedRow<ProfileWrite>>;
  loans: Array<PlannedRow<LoanWrite>>;
};

function finishRow<T>(row: PlannedRow<T>): PlannedRow<T> {
  if (row.errors.length > 0) {
    row.outcome = "ERROR";
    row.write = null;
  }
  return row;
}

function summarize<T>(rows: Array<PlannedRow<T>>): SectionReport {
  const report: SectionReport = { total: rows.length, create: 0, correct: 0, unchanged: 0, error: 0, errors: {}, warnings: {}, issues: [] };
  for (const row of rows) {
    if (row.outcome === "CREATE") report.create += 1;
    else if (row.outcome === "CORRECT") report.correct += 1;
    else if (row.outcome === "UNCHANGED") report.unchanged += 1;
    else report.error += 1;
    for (const code of row.errors) report.errors[code] = (report.errors[code] ?? 0) + 1;
    for (const code of row.warnings) report.warnings[code] = (report.warnings[code] ?? 0) + 1;
    if (row.errors.length > 0 || row.warnings.length > 0) {
      report.issues.push({ rowId: row.rowId, outcome: row.outcome, errors: row.errors, warnings: row.warnings });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Helpers

/** JSON with object keys sorted, so a jsonb round trip compares equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const SYMBOL = /^(unit|functional|structural):(.+)$/;

type Resolution = { value: unknown; unknownUnits: string[]; refLabels: Record<string, string>; collisions: number };

/**
 * Replaces `unit:<name>`, `functional:<label>` and `structural:<label>` wherever
 * they appear as an object key or an array element. A unit that is not in
 * organizational_units stays unresolved and is reported (spec §4).
 */
export function resolveSymbols(value: unknown, units: ReadonlyMap<string, string>): Resolution {
  const unknownUnits: string[] = [];
  const refLabels: Record<string, string> = {};
  let collisions = 0;

  function resolveOne(text: string): string {
    const match = SYMBOL.exec(text);
    if (!match) return text;
    const kind = match[1] as "unit" | PositionKind;
    const name = match[2]!.trim();
    if (kind === "unit") {
      const id = units.get(normalizeLabel(name));
      if (!id) {
        unknownUnits.push(name);
        return text;
      }
      refLabels[id] = `unit:${name}`;
      return id;
    }
    const id = positionRef(kind, name);
    refLabels[id] = `${kind}:${name}`;
    return id;
  }

  function walk(node: unknown): unknown {
    if (Array.isArray(node)) return node.map((item) => (typeof item === "string" ? resolveOne(item) : walk(item)));
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        const resolved = resolveOne(key);
        // Two spellings of one label land on one uuid; the second would silently
        // overwrite the first amount.
        if (Object.prototype.hasOwnProperty.call(out, resolved)) collisions += 1;
        out[resolved] = walk(item);
      }
      return out;
    }
    return node;
  }

  const resolved = walk(value);
  return { value: resolved, unknownUnits, refLabels, collisions };
}

function withMarker(text: string, max: number): string {
  if (text.includes(MIGRATION_MARKER)) return text;
  const marked = `${text} ${MIGRATION_MARKER}`;
  return marked.length <= max ? marked : `${text.slice(0, max - MIGRATION_MARKER.length - 1)} ${MIGRATION_MARKER}`;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** The fields a profile row carries, with how the database returns each one. */
type ProfileFieldKind = "text" | "int" | "num2" | "num4" | "bool";

const PROFILE_FIELDS: Array<{ key: keyof CompensationProfileRow & keyof NewCompensationProfile; kind: ProfileFieldKind }> = [
  { key: "education", kind: "text" },
  { key: "workPattern", kind: "text" },
  { key: "unitRef", kind: "text" },
  { key: "functionalPositionRef", kind: "text" },
  { key: "structuralPositionRef", kind: "text" },
  { key: "teachingHoursPerWeek", kind: "num2" },
  { key: "spouseCount", kind: "int" },
  { key: "childCount", kind: "int" },
  { key: "registeredDependants", kind: "int" },
  { key: "specialQualificationTarget", kind: "int" },
  { key: "annualPerformanceRate", kind: "num4" },
  { key: "monthlyPerformanceRate", kind: "num4" },
  { key: "bpjsSegment", kind: "text" },
  { key: "bpjsActiveFrom", kind: "text" },
  { key: "bpjsExtraFamilyOverride", kind: "int" },
  { key: "bpjsExtraFamilyOverrideReason", kind: "text" },
  { key: "bpjsDecisionReference", kind: "text" },
  { key: "ptkpStatus", kind: "text" },
  { key: "pph21ReportExcluded", kind: "bool" },
  { key: "pph21ReportExclusionReason", kind: "text" },
  { key: "pjMediaRatePerContent", kind: "int" },
  { key: "bankName", kind: "text" },
  { key: "bankAccountNumber", kind: "text" },
  { key: "bankAccountName", kind: "text" },
];

function normalizedField(value: unknown, kind: ProfileFieldKind): string | number | boolean | null {
  if (kind === "bool") return value === true;
  if (value === null || value === undefined) return null;
  if (kind === "text") return String(value);
  const number = Number(value);
  if (kind === "num2") return roundTo(number, 2);
  if (kind === "num4") return roundTo(number, 4);
  return number;
}

export function profileMatches(existing: CompensationProfileRow, desired: NewCompensationProfile): boolean {
  return PROFILE_FIELDS.every(
    ({ key, kind }) => normalizedField(existing[key], kind) === normalizedField(desired[key], kind),
  );
}

const PAYROLL_TERM_CATEGORIES = new Set(["TETAP", "PERCOBAAN", "KONTRAK", "KONTRAK_HONORER", "LEPAS"]);

const SECTION_PERMISSION = {
  policies: "payroll.policies.manage",
  profiles: "payroll.profiles.manage",
  loans: "payroll.loans.manage",
} as const;

// ---------------------------------------------------------------------------
// Planning

type EmploymentCandidate = {
  employmentId: string;
  employeeId: string;
  serviceStartDate: string | null;
  startedOn: string | null;
  endedOn: string | null;
  termCategory: string | null;
};

type ExistingPolicy = {
  id: string;
  policyKey: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  payload: unknown;
  source: string;
  /** Whether any stored calculation result rests on this version. */
  inUse: boolean;
};

type ExistingLoan = { employeeId: string; grantedOn: string; principal: string; instalment: string | null; note: string | null; closedAt: string | null };

async function buildPlan(client: PoolClient, file: InitialLoadFile, actorAccountId: string | null): Promise<Plan> {
  const plan: Plan = { actorProblems: [], actorChecked: false, policies: [], profiles: [], loans: [] };

  // Actor: the same permission each route asks for, and the same own-record rule.
  let ownEmployments = new Set<string>();
  if (actorAccountId) {
    plan.actorChecked = true;
    const account = await client.query<{ id: string; email: string; principalType: string; status: string }>(
      `SELECT id, email, principal_type AS "principalType", status FROM accounts WHERE id = $1`,
      [actorAccountId],
    );
    const row = account.rows[0];
    if (!row) {
      plan.actorProblems.push("ACTOR_NOT_FOUND");
    } else {
      if (row.status !== "active") plan.actorProblems.push("ACTOR_INACTIVE");
      const context = await resolveAuthorizationContext(client, {
        id: row.id,
        email: row.email,
        principalType: row.principalType as never,
      });
      for (const section of ["policies", "profiles", "loans"] as const) {
        if (file[section].length > 0 && !context.organizationPermissions.includes(SECTION_PERMISSION[section])) {
          plan.actorProblems.push(`ACTOR_LACKS_${SECTION_PERMISSION[section]}`);
        }
      }
      ownEmployments = await ownEmploymentIds(client as unknown as Pool, actorAccountId);
    }
  }

  const unitRows = await client.query<{ id: string; normalizedName: string }>(
    `SELECT id, normalized_name AS "normalizedName" FROM organizational_units`,
  );
  const units = new Map(unitRows.rows.map((row) => [normalizeLabel(row.normalizedName), row.id]));

  const settledCache = new Map<string, boolean>();
  async function settled(date: string): Promise<boolean> {
    if (!settledCache.has(date)) settledCache.set(date, (await settledPeriodConflict(client, date)) !== null);
    return settledCache.get(date)!;
  }

  // ---- policies
  const existingPolicies = await client.query<ExistingPolicy>(
    `SELECT v.id, v.policy_key AS "policyKey", to_char(v.effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
            to_char(v.effective_to, 'YYYY-MM-DD') AS "effectiveTo", v.payload, v.source,
            EXISTS (SELECT 1 FROM payroll_results r WHERE r.policy_version_ids ? v.id::text) AS "inUse"
     FROM payroll_policy_versions v`,
  );
  const seenPolicyKeys = new Set<string>();
  /** Resolved payloads by key, for the profile cross-check. */
  const filePolicies = new Map<string, Record<string, unknown>>();

  for (const [index, raw] of file.policies.entries()) {
    const parsed = policyRow.safeParse(raw);
    const row: PlannedRow<PolicyWrite> & { policyKey: string | null } = {
      rowId: (typeof raw.rowId === "string" && raw.rowId.trim()) || `policies[${index}]`,
      policyKey: typeof raw.policyKey === "string" ? raw.policyKey : null,
      outcome: "CREATE",
      errors: [],
      warnings: [],
      write: null,
    };
    plan.policies.push(row);
    if (!parsed.success) {
      row.errors.push("INVALID");
      finishRow(row);
      continue;
    }
    const data = parsed.data;
    row.policyKey = data.policyKey;
    if (seenPolicyKeys.has(data.policyKey)) {
      row.errors.push("DUPLICATE_ROW");
      finishRow(row);
      continue;
    }
    seenPolicyKeys.add(data.policyKey);

    const resolved = resolveSymbols(data.payload, units);
    if (resolved.unknownUnits.length > 0) row.errors.push("UNIT_UNKNOWN");
    const payload = resolved.value as Record<string, unknown>;
    if (Object.keys(resolved.refLabels).length > 0) payload.refLabels = resolved.refLabels;
    if (!validatePolicyPayload(data.policyKey, payload).ok) row.errors.push("INVALID");
    if (resolved.collisions > 0 || (resolved.unknownUnits.length === 0 && !referencesAreUuids(data.policyKey, payload))) {
      row.errors.push("INVALID");
    }
    if (await settled(data.effectiveFrom)) row.errors.push("SETTLED_PERIOD");
    filePolicies.set(data.policyKey, payload);

    const samePolicies = existingPolicies.rows.filter((item) => item.policyKey === data.policyKey);
    const identicalPolicy = samePolicies.some(
      (item) => item.effectiveFrom === data.effectiveFrom && canonicalJson(item.payload) === canonicalJson(payload),
    );
    // Already loaded exactly as the file says: a re-run is the recovery path after
    // a partial apply, so a version opened since must not turn it into a refusal.
    if (identicalPolicy) row.outcome = "UNCHANGED";
    let correction: PolicyWrite["correction"];
    for (const existing of identicalPolicy ? [] : samePolicies) {
      if (existing.effectiveFrom === data.effectiveFrom) {
        if (!data.correctionReason) row.errors.push("EXISTS_DIFFERENT");
        else if (!existing.source.includes(MIGRATION_MARKER)) row.errors.push("VERSION_NOT_FROM_LOAD");
        else if (existing.inUse) row.errors.push("VERSION_IN_USE");
        else correction = { versionId: existing.id, reason: data.correctionReason };
      } else if (existing.effectiveFrom > data.effectiveFrom) {
        row.errors.push("LATER_VERSION_EXISTS");
      } else if (existing.effectiveTo === null) {
        row.warnings.push("SUPERSEDES_VERSION");
      } else if (existing.effectiveTo >= data.effectiveFrom) {
        row.errors.push("LATER_VERSION_EXISTS");
      }
    }

    if (data.correctionReason && !identicalPolicy && !samePolicies.some((item) => item.effectiveFrom === data.effectiveFrom)) {
      row.errors.push("CORRECTION_TARGET_MISSING");
    }
    if (correction) row.outcome = "CORRECT";

    row.write =
      row.outcome === "CREATE" || row.outcome === "CORRECT"
        ? {
            policyKey: data.policyKey,
            effectiveFrom: data.effectiveFrom,
            payload,
            source: withMarker(data.source, 500),
            ...(data.note ? { note: data.note } : {}),
            ...(correction ? { correction } : {}),
          }
        : null;
    row.errors = [...new Set(row.errors)];
    finishRow(row);
  }

  /** The policy a profile will meet: the file's own row, else the version in force. */
  function policyFor(key: string, date: string): Record<string, unknown> | null {
    const fromFile = filePolicies.get(key);
    if (fromFile) return fromFile;
    const existing = existingPolicies.rows.find(
      (item) =>
        item.policyKey === key && item.effectiveFrom <= date && (item.effectiveTo === null || item.effectiveTo >= date),
    );
    return (existing?.payload as Record<string, unknown> | undefined) ?? null;
  }

  // ---- people
  const nips = [
    ...file.profiles.map((raw) => raw.nip),
    ...file.loans.map((raw) => raw.nip),
  ].filter((nip): nip is string => typeof nip === "string").map((nip) => nip.trim());
  const employeeRows = await client.query<{ id: string; employeeNumber: string }>(
    `SELECT id, employee_number AS "employeeNumber" FROM employees
     WHERE employee_number = ANY($1::text[]) AND removed_at IS NULL`,
    [nips],
  );
  const employeeByNip = new Map(employeeRows.rows.map((row) => [row.employeeNumber, row.id]));
  const employeeIds = [...employeeByNip.values()];

  // ---- profiles
  const profileDates = [
    ...new Set(
      file.profiles.map((raw) => raw.effectiveFrom).filter((date): date is string => typeof date === "string"),
    ),
  ];
  const employmentsByDate = new Map<string, EmploymentCandidate[]>();
  for (const date of profileDates) {
    // An impossible date would abort the whole plan at the ::date cast; the row
    // itself is refused as INVALID by its schema.
    if (!isRealDate(date)) continue;
    const { rows } = await client.query<EmploymentCandidate>(
      `SELECT e.id AS "employmentId", e.employee_id AS "employeeId",
              to_char(coalesce(e.service_start_on, e.started_on), 'YYYY-MM-DD') AS "serviceStartDate",
              to_char(e.started_on, 'YYYY-MM-DD') AS "startedOn",
              to_char(e.ended_on, 'YYYY-MM-DD') AS "endedOn",
              term.category AS "termCategory"
       FROM employments e
       LEFT JOIN LATERAL (
         SELECT t.category FROM employment_terms t
         WHERE t.employment_id = e.id
           AND t.voided_by_action_id IS NULL
           AND (t.effective_from IS NULL OR t.effective_from <= $2::date)
           AND (t.effective_to IS NULL OR t.effective_to >= $2::date)
         ORDER BY t.sequence DESC LIMIT 1
       ) term ON true
       WHERE e.employee_id = ANY($1::uuid[])
         AND e.voided_by_action_id IS NULL
         AND (e.started_on IS NULL OR e.started_on <= $2::date)
         AND (e.ended_on IS NULL OR e.ended_on >= $2::date)`,
      [employeeIds, date],
    );
    employmentsByDate.set(date, rows);
  }
  const allEmploymentIds = [...new Set([...employmentsByDate.values()].flat().map((row) => row.employmentId))];
  const existingProfiles = await client.query<CompensationProfileRow>(
    `SELECT ${PROFILE_COLUMNS} FROM payroll_compensation_profiles WHERE employment_id = ANY($1::uuid[])`,
    [allEmploymentIds],
  );

  const seenProfileNips = new Set<string>();
  for (const [index, raw] of file.profiles.entries()) {
    const parsed = profileRow.safeParse(raw);
    const row: PlannedRow<ProfileWrite> = {
      rowId: (typeof raw.rowId === "string" && raw.rowId.trim()) || `profiles[${index}]`,
      outcome: "CREATE",
      errors: [],
      warnings: [],
      write: null,
    };
    plan.profiles.push(row);
    if (!parsed.success) {
      row.errors.push("INVALID");
      finishRow(row);
      continue;
    }
    const data = parsed.data;
    if (seenProfileNips.has(data.nip)) {
      row.errors.push("DUPLICATE_ROW");
      finishRow(row);
      continue;
    }
    seenProfileNips.add(data.nip);

    const employeeId = employeeByNip.get(data.nip);
    if (!employeeId) {
      row.errors.push("EMPLOYEE_NOT_FOUND");
      finishRow(row);
      continue;
    }
    const candidates = (employmentsByDate.get(data.effectiveFrom) ?? []).filter((item) => item.employeeId === employeeId);
    if (candidates.length === 0) {
      row.errors.push("EMPLOYMENT_MISSING");
      finishRow(row);
      continue;
    }
    if (candidates.length > 1) {
      row.errors.push("EMPLOYMENT_AMBIGUOUS");
      finishRow(row);
      continue;
    }
    const employment = candidates[0]!;

    let unitRef: string | null = null;
    if (data.unit) {
      unitRef = units.get(normalizeLabel(data.unit)) ?? null;
      if (!unitRef) row.errors.push("UNIT_UNKNOWN");
    }
    const desired: ProfileWrite = {
      employmentId: employment.employmentId,
      effectiveFrom: data.effectiveFrom,
      education: data.education ?? null,
      workPattern: data.workPattern ?? null,
      unitRef,
      functionalPositionRef: data.functional ? positionRef("functional", data.functional) : null,
      structuralPositionRef: data.structural ? positionRef("structural", data.structural) : null,
      teachingHoursPerWeek: data.teachingHoursPerWeek ?? null,
      spouseCount: data.spouseCount ?? 0,
      childCount: data.childCount ?? 0,
      registeredDependants: data.registeredDependants ?? 0,
      specialQualificationTarget: data.specialQualificationTarget ?? null,
      annualPerformanceRate: data.annualPerformanceRate ?? null,
      monthlyPerformanceRate: data.monthlyPerformanceRate ?? null,
      bpjsSegment: data.bpjsSegment ?? "BELUM_TERDAFTAR",
      bpjsActiveFrom: data.bpjsActiveFrom ?? null,
      bpjsExtraFamilyOverride: data.bpjsExtraFamilyOverride ?? null,
      bpjsExtraFamilyOverrideReason: data.bpjsExtraFamilyOverrideReason ?? null,
      bpjsDecisionReference: data.bpjsDecisionReference ?? null,
      ptkpStatus: data.ptkpStatus ?? null,
      pph21ReportExcluded: data.pph21ReportExcluded ?? false,
      pph21ReportExclusionReason: data.pph21ReportExcluded ? (data.pph21ReportExclusionReason ?? null) : null,
      pjMediaRatePerContent: data.pjMediaRatePerContent ?? null,
      bankName: data.bankName ?? null,
      bankAccountNumber: data.bankAccountNumber ?? null,
      bankAccountName: data.bankAccountName ?? null,
    };

    // The route's own shape once the references are uuids, and the two rules the
    // database adds that the route turns into a 400.
    const routeBody: Record<string, unknown> = { ...desired };
    delete routeBody.employmentId;
    if (!profileBody.safeParse(routeBody).success) row.errors.push("INVALID");
    if (desired.bpjsActiveFrom !== null && desired.bpjsSegment === "BELUM_TERDAFTAR") row.errors.push("INVALID");
    if (
      desired.bpjsExtraFamilyOverride !== null &&
      (desired.bpjsExtraFamilyOverrideReason ?? "").trim().length === 0
    ) {
      row.errors.push("INVALID");
    }
    // The database refuses an exclusion from the PPh21 report without a reason
    // (migration 0142); say so in the plan rather than fail half way through --apply.
    if (desired.pph21ReportExcluded && (desired.pph21ReportExclusionReason ?? "").trim().length === 0) {
      row.errors.push("INVALID");
    }
    if (ownEmployments.has(employment.employmentId)) row.errors.push("OWN_RECORD");
    if (await settled(data.effectiveFrom)) row.errors.push("SETTLED_PERIOD");

    const sameProfiles = existingProfiles.rows.filter((item) => item.employmentId === employment.employmentId);
    const identicalProfile = sameProfiles.some(
      (item) => item.effectiveFrom === data.effectiveFrom && profileMatches(item, desired),
    );
    if (identicalProfile) row.outcome = "UNCHANGED";
    for (const existing of identicalProfile ? [] : sameProfiles) {
      if (existing.effectiveFrom === data.effectiveFrom) {
        row.errors.push("EXISTS_DIFFERENT");
      } else if (existing.effectiveFrom > data.effectiveFrom) {
        row.errors.push("LATER_VERSION_EXISTS");
      } else if (existing.effectiveTo === null) {
        row.warnings.push("SUPERSEDES_VERSION");
      } else if (existing.effectiveTo >= data.effectiveFrom) {
        row.errors.push("LATER_VERSION_EXISTS");
      }
    }

    // Warnings: the row is written, but someone has to look before a period runs.
    if (data.legacyServiceStartDate && employment.serviceStartDate !== data.legacyServiceStartDate) {
      row.warnings.push("TMT_DIFFERS");
    }
    if (!employment.termCategory || !PAYROLL_TERM_CATEGORIES.has(employment.termCategory)) {
      row.warnings.push("OUT_OF_PAYROLL_SCOPE");
    }
    const basic = policyFor("BASIC_MULTIPLIER", data.effectiveFrom);
    if (unitRef && basic && Array.isArray(basic.knownUnitRefs) && !basic.knownUnitRefs.includes(unitRef)) {
      row.warnings.push("UNIT_NOT_IN_POLICY");
    }
    for (const [ref, key] of [
      [desired.functionalPositionRef, "FUNCTIONAL_ALLOWANCE"],
      [desired.structuralPositionRef, "POSITIONAL_ALLOWANCE"],
    ] as const) {
      if (!ref) continue;
      const policy = policyFor(key, data.effectiveFrom);
      if (!policy) continue;
      const priced = Object.keys((policy.byPosition as Record<string, unknown> | undefined) ?? {});
      const unpriced = (policy.positionsWithoutAllowance as unknown[] | undefined) ?? [];
      if (!priced.includes(ref) && !unpriced.includes(ref)) row.warnings.push("POSITION_NOT_IN_POLICY");
    }

    row.errors = [...new Set(row.errors)];
    row.warnings = [...new Set(row.warnings)];
    row.write = row.outcome === "CREATE" ? desired : null;
    finishRow(row);
  }

  // ---- loans
  const existingLoans = await client.query<ExistingLoan>(
    `SELECT employee_id AS "employeeId", to_char(granted_on, 'YYYY-MM-DD') AS "grantedOn",
            principal::text AS principal, instalment::text AS instalment, note, closed_at AS "closedAt"
     FROM payroll_loans WHERE employee_id = ANY($1::uuid[])`,
    [employeeIds],
  );
  const seenLoanNips = new Set<string>();
  for (const [index, raw] of file.loans.entries()) {
    const parsed = loanRow.safeParse(raw);
    const row: PlannedRow<LoanWrite> = {
      rowId: (typeof raw.rowId === "string" && raw.rowId.trim()) || `loans[${index}]`,
      outcome: "CREATE",
      errors: [],
      warnings: [],
      write: null,
    };
    plan.loans.push(row);
    if (!parsed.success) {
      row.errors.push("INVALID");
      finishRow(row);
      continue;
    }
    const data = parsed.data;
    if (seenLoanNips.has(data.nip)) {
      row.errors.push("DUPLICATE_ROW");
      finishRow(row);
      continue;
    }
    seenLoanNips.add(data.nip);
    const employeeId = employeeByNip.get(data.nip);
    if (!employeeId) {
      row.errors.push("EMPLOYEE_NOT_FOUND");
      finishRow(row);
      continue;
    }
    const note = withMarker(data.note ?? DEFAULT_LOAN_NOTE, 500);
    const desired: LoanWrite = {
      employeeId,
      grantedOn: data.grantedOn,
      principal: data.principal,
      instalment: data.instalment ?? null,
      note,
    };
    if (!loanBody.safeParse({ ...desired, instalment: desired.instalment }).success) row.errors.push("INVALID");

    // One migrated balance per employee: any loan carrying the marker is this
    // row, whatever its date or note now says, so changing the DRAFT date and
    // re-running can never open a second debt (spec §5.2).
    for (const existing of existingLoans.rows.filter((item) => item.employeeId === employeeId)) {
      if ((existing.note ?? "").includes(MIGRATION_MARKER)) {
        const same =
          existing.grantedOn === desired.grantedOn &&
          existing.note === note &&
          Number(existing.principal) === desired.principal &&
          (existing.instalment === null ? null : Number(existing.instalment)) === desired.instalment;
        if (same) row.outcome = "UNCHANGED";
        else row.errors.push("EXISTS_DIFFERENT");
      } else if (existing.closedAt === null) {
        row.warnings.push("OPEN_LOAN_EXISTS");
      }
    }
    row.errors = [...new Set(row.errors)];
    row.warnings = [...new Set(row.warnings)];
    row.write = row.outcome === "CREATE" ? desired : null;
    finishRow(row);
  }

  return plan;
}

function report(plan: Plan, mode: "dry-run" | "apply", startedAt: string): InitialLoadReport {
  const byKey: Record<string, RowOutcome | ErrorCode> = {};
  for (const row of plan.policies) {
    // A repeated key is counted as DUPLICATE_ROW; the first row says what happens to the key.
    if (!row.policyKey || row.policyKey in byKey) continue;
    byKey[row.policyKey] =row.outcome === "ERROR" ? row.errors[0]! : row.outcome;
  }
  return {
    mode,
    format: INITIAL_LOAD_FORMAT,
    startedAt,
    actor: { checked: plan.actorChecked, problems: plan.actorProblems },
    policies: { ...summarize(plan.policies), byKey },
    profiles: summarize(plan.profiles),
    loans: summarize(plan.loans),
  };
}

export function planHasErrors(plan: Pick<InitialLoadReport, "actor" | "policies" | "profiles" | "loans">): boolean {
  return (
    plan.actor.problems.length > 0 ||
    plan.policies.error > 0 ||
    plan.profiles.error > 0 ||
    plan.loans.error > 0
  );
}

async function planReadOnly(pool: Pool, file: InitialLoadFile, actorAccountId: string | null): Promise<Plan> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      return await buildPlan(client, file, actorAccountId);
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
}

export class InitialLoadRefused extends Error {
  constructor(
    message: string,
    readonly report: InitialLoadReport,
  ) {
    super(message);
    this.name = "InitialLoadRefused";
  }
}

/** Raised when apply stops after some rows were written; carries what was written. */
export class InitialLoadPartial extends Error {
  readonly errorCode: string;
  constructor(
    readonly report: InitialLoadReport,
    cause: unknown,
  ) {
    super("Pemuatan berhenti di tengah; sebagian baris sudah tertulis. Jalankan ulang berkas yang sama untuk melanjutkan.");
    this.name = "InitialLoadPartial";
    // A database error's detail can quote the whole row, bank account included,
    // so only the SQLSTATE travels on (spec §5.3).
    this.errorCode = (cause as { code?: string }).code ?? "UNKNOWN";
  }
}

async function recordRun(pool: Pool, actorAccountId: string, action: string, payload: Record<string, unknown>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await writeAudit(client, { actorAccountId, action, periodId: null, payload });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const LOCK_KEY = "payroll-initial-load";

/**
 * Dry-run by default. With apply, refuses when the plan carries any error or
 * actor problem, then writes only the rows planned as CREATE.
 */
export async function runInitialLoad(
  pool: Pool,
  options: { file: InitialLoadFile; apply: boolean; actorAccountId: string | null; sourceName: string },
): Promise<InitialLoadReport> {
  const startedAt = new Date().toISOString();
  if (!options.apply) {
    return report(await planReadOnly(pool, options.file, options.actorAccountId), "dry-run", startedAt);
  }
  if (!options.actorAccountId) {
    throw new Error("--apply membutuhkan --actor-account <uuid akun HCIS>.");
  }
  const actorAccountId = options.actorAccountId;

  // One run at a time: a second operator would plan against rows the first is
  // about to write and both would report CREATE.
  const lockClient = await pool.connect();
  try {
    const { rows } = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [LOCK_KEY],
    );
    if (!rows[0]?.locked) throw new Error("Pemuatan awal payroll lain sedang berjalan.");
    try {
      const plan = await planReadOnly(pool, options.file, actorAccountId);
      const planned = report(plan, "apply", startedAt);
      if (planHasErrors(planned)) {
        throw new InitialLoadRefused("Rencana memuat galat; tidak ada data yang ditulis.", planned);
      }

      // The start is on record before the first row is written, so a run that
      // stops half way can still be found and rolled back (spec §8).
      await recordRun(pool, actorAccountId, "payroll.initial_load.started", {
        started_at: startedAt,
        source_file: options.sourceName,
      });

      const written = { policies: 0, profiles: 0, loans: 0 };
      try {
        for (const row of plan.policies) {
          if (!row.write) continue;
          const { correction, ...version } = row.write;
          if (correction) {
            await correctLoadedPolicyVersion(pool, { ...version, ...correction }, actorAccountId);
          } else {
            await openPolicyVersion(pool, version, actorAccountId);
          }
          written.policies += 1;
        }
        for (const row of plan.profiles) {
          if (!row.write) continue;
          await openCompensationProfile(pool, row.write, actorAccountId);
          written.profiles += 1;
        }
        for (const row of plan.loans) {
          if (!row.write) continue;
          await createLoan(pool, row.write, actorAccountId);
          written.loans += 1;
        }
      } catch (error) {
        // Each row commits on its own, so what was written stays written. A re-run
        // of the same file finds those rows UNCHANGED and writes the rest.
        const partial = { ...planned, written };
        await recordRun(pool, actorAccountId, "payroll.initial_load.failed", {
          started_at: startedAt,
          source_file: options.sourceName,
          policies_written: written.policies,
          profiles_written: written.profiles,
          loans_written: written.loans,
          error_code: (error as { code?: string }).code ?? "UNKNOWN",
        }).catch(() => undefined);
        throw new InitialLoadPartial(partial, error);
      }

      await recordRun(pool, actorAccountId, "payroll.initial_load.applied", {
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        source_file: options.sourceName,
        policies_written: written.policies,
        profiles_written: written.profiles,
        loans_written: written.loans,
      });

      return { ...planned, written };
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]);
    }
  } finally {
    lockClient.release();
  }
}
