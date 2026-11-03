// ORG-012 pure rules. No database, no HTTP.
// Spec: docs/domain/committees.md.

import { z } from "zod";

/** D-01: kept in step with the CHECK in 0134_committees.sql. */
export const COMMITTEE_CATEGORIES = ["ADMISSION", "EXAM", "GRADUATION", "RAMADAN", "EVENT", "OTHER"] as const;
export type CommitteeCategory = (typeof COMMITTEE_CATEGORIES)[number];

/** D-05: in the order the decree lists them. */
export const COMMITTEE_ROLES = ["CHAIR", "VICE_CHAIR", "SECRETARY", "TREASURER", "SECTION_COORDINATOR", "MEMBER"] as const;
export type CommitteeRole = (typeof COMMITTEE_ROLES)[number];
/** D-13: the core officers counted separately in the participation recap. */
export const CORE_ROLES: readonly CommitteeRole[] = ["CHAIR", "VICE_CHAIR", "SECRETARY", "TREASURER"];

export const COMMITTEE_STATUSES = ["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"] as const;
export type CommitteeStatus = (typeof COMMITTEE_STATUSES)[number];

/** D-06 DRAFT. */
export const MAX_ACTIVE_MEMBERS = 300;
/** D-07 DRAFT. */
export const MIN_MEMBERS_TO_ACTIVATE = 2;
/** D-04 DRAFT: inclusive days, so end - start <= 365. */
export const MAX_PERIOD_DAYS = 366;

/** D-08: the decree shares the DOC-001 register and its counters. */
export const COMMITTEE_DOCUMENT_CODE = "COMMITTEE_DECREE";
export const COMMITTEE_NUMBER_CODE = "SKP";

export class CommitteeError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Postgres refuses NUL in text; refusing it here keeps that a 400 instead of a 500. */
export const text = () => z.string().refine((value) => !value.includes("\u0000")).pipe(z.string().trim());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
// An empty optional field from a form means "none".
const optionalText = (max: number, min = 1) => z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  text().pipe(z.string().min(min).max(max)).nullable().optional(),
);

export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const periodRefinement = (value: { startOn: string; endOn: string }, context: z.RefinementCtx) => {
  const days = daysBetween(value.startOn, value.endOn);
  if (days < 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["endOn"], message: "Tanggal selesai sebelum tanggal mulai." });
  if (days >= MAX_PERIOD_DAYS) context.addIssue({ code: z.ZodIssueCode.custom, path: ["endOn"], message: "Periode paling lama 366 hari." });
};

const committeeFields = z.object({
  name: text().pipe(z.string().min(3).max(200)),
  category: z.enum(COMMITTEE_CATEGORIES),
  description: optionalText(2000),
  organizer: optionalText(200, 2),
  startOn: isoDate,
  endOn: isoDate,
});
export const committeeInput = committeeFields.superRefine(periodRefinement);
export const committeeEdit = committeeFields.extend({ version: z.number().int().min(1) }).superRefine(periodRefinement);
export type CommitteeInput = z.infer<typeof committeeInput>;

const memberFields = z.object({
  role: z.enum(COMMITTEE_ROLES),
  section: optionalText(100, 2),
  version: z.number().int().min(1),
});
const sectionRefinement = (value: { role: CommitteeRole; section?: string | null | undefined }, context: z.RefinementCtx) => {
  if (value.role === "SECTION_COORDINATOR" && !value.section) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["section"], message: "Koordinator seksi wajib mengisi nama seksi." });
  }
};
export const memberAdd = memberFields.extend({ employeeId: z.string().uuid() }).superRefine(sectionRefinement);
export const memberEdit = memberFields.superRefine(sectionRefinement);
export const memberEnd = z.object({
  version: z.number().int().min(1),
  reason: optionalText(300),
});

export const activateInput = z.object({
  version: z.number().int().min(1),
  decree: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("ISSUE") }),
    z.object({ mode: z.literal("EXTERNAL"), number: text().pipe(z.string().min(3).max(100)), date: isoDate }),
  ]),
});
export const versionInput = z.object({ version: z.number().int().min(1) });
export const cancelInput = z.object({
  version: z.number().int().min(1),
  reason: text().pipe(z.string().min(10).max(500)),
});

/** D-19. */
export function assertFreshVersion(current: number, expected: number) {
  if (current !== expected) {
    throw new CommitteeError(409, "COMMITTEE_STALE", "Kepanitiaan sudah diubah orang lain. Muat ulang lalu ulangi perubahan Anda.");
  }
}

/** §5.1: COMPLETED and CANCELLED are final. */
export function assertOpen(status: CommitteeStatus) {
  if (status === "COMPLETED" || status === "CANCELLED") {
    throw new CommitteeError(409, "COMMITTEE_CLOSED", "Kepanitiaan sudah selesai atau dibatalkan dan tidak dapat diubah.");
  }
}

export function assertStatus(status: CommitteeStatus, allowed: CommitteeStatus, message: string) {
  assertOpen(status);
  if (status !== allowed) throw new CommitteeError(409, "COMMITTEE_STATE", message);
}

/** D-10: after activation the decree fixes name, category and start date. */
export function lockedFieldChanges(
  status: CommitteeStatus,
  current: { name: string; category: string; startOn: string },
  next: { name: string; category: string; startOn: string },
): string[] {
  if (status === "DRAFT") return [];
  return (["name", "category", "startOn"] as const).filter((field) => current[field] !== next[field]);
}

export interface ReadinessMember {
  role: CommitteeRole;
  employeeActive: boolean;
}

/** D-07: the reasons a draft cannot be activated yet; empty means ready. */
export function activationProblems(members: ReadinessMember[]): string[] {
  const problems: string[] = [];
  const chairs = members.filter((member) => member.role === "CHAIR").length;
  if (chairs !== 1) problems.push("Tetapkan tepat satu Ketua panitia.");
  if (members.length < MIN_MEMBERS_TO_ACTIVATE) problems.push(`Panitia paling sedikit ${MIN_MEMBERS_TO_ACTIVATE} orang.`);
  if (members.some((member) => !member.employeeActive)) problems.push("Ada anggota yang bukan lagi pegawai aktif; akhiri tugasnya dulu.");
  return problems;
}

/** D-11: a member added after activation joins today, kept inside the committee period so a
 * past committee recorded late still counts in its own year (D-04, D-13). */
export function joinDate(status: CommitteeStatus, startOn: string, endOn: string, today: string) {
  if (status === "DRAFT" || today < startOn) return startOn;
  return today > endOn ? endOn : today;
}

/** D-11/D-12: an open membership closes today (or at the committee end), never before it began. */
export function leaveDate(joinedOn: string, today: string, endOn?: string) {
  const candidate = endOn && endOn < today ? endOn : today;
  return candidate < joinedOn ? joinedOn : candidate;
}

/** D-13: the calendar year as an inclusive date range. */
export function yearRange(year: number) {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

export const ROLE_LABELS: Record<CommitteeRole, string> = {
  CHAIR: "Ketua",
  VICE_CHAIR: "Wakil Ketua",
  SECRETARY: "Sekretaris",
  TREASURER: "Bendahara",
  SECTION_COORDINATOR: "Koordinator Seksi",
  MEMBER: "Anggota",
};

/** Postgres ILIKE pattern that treats `%`, `_` and the escape character literally. */
export function likePattern(query: string) {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
