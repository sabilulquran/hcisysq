// HELP-001 pure rules. No database, no HTTP.
// Spec: docs/domain/help-center.md.

import { z } from "zod";

/** D-01: fixed topic list, in reading order. Kept in step with the CHECK in 0130_help_center.sql. */
export const HELP_TOPICS = [
  "GENERAL", "ATTENDANCE", "OVERTIME", "LEAVE", "PAYSLIP", "TRIPS", "CALENDAR",
  "TRAINING", "LOANS", "ASSETS", "DOCUMENTS", "PERFORMANCE", "APPROVALS",
] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

export const HELP_KINDS = ["FAQ", "GUIDE"] as const;
export type HelpKind = (typeof HELP_KINDS)[number];

export const HELP_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type HelpStatus = (typeof HELP_STATUSES)[number];

export const HELP_CONTACT_CHANNELS = ["WHATSAPP", "PHONE", "EMAIL", "OFFICE"] as const;
export type HelpContactChannel = (typeof HELP_CONTACT_CHANNELS)[number];

/** D-09: a bounded list (ENG-LIST-001 §4). */
export const HELP_CONTACT_LIMIT = 20;

export class HelpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

// D-05: plain text. The body keeps its line breaks; only the outer whitespace is trimmed.
export const articleInput = z.object({
  kind: z.enum(HELP_KINDS),
  topic: z.enum(HELP_TOPICS),
  title: z.string().trim().min(5).max(200),
  body: z.string().trim().min(20).max(8000),
  sortOrder: z.number().int().min(0).max(9999).default(100),
});
export const articleEdit = articleInput.extend({
  version: z.number().int().min(1),
  changeNote: z.string().trim().max(300).optional(),
});

const phoneLike = z.string().trim().regex(/^\+?[0-9][0-9 -]{4,18}[0-9]$/);
export const contactInput = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("WHATSAPP"), value: phoneLike }),
  z.object({ channel: z.literal("PHONE"), value: phoneLike }),
  z.object({ channel: z.literal("EMAIL"), value: z.string().trim().email().max(200) }),
  z.object({ channel: z.literal("OFFICE"), value: z.string().trim().min(2).max(200) }),
]).and(z.object({
  label: z.string().trim().min(2).max(100),
  note: z.string().trim().max(200).optional(),
  sortOrder: z.number().int().min(0).max(9999).default(100),
  active: z.boolean().default(true),
}));
export type ContactInput = z.infer<typeof contactInput>;

/** D-02 and §5.1: which transitions each action allows. */
export function assertEditable(status: HelpStatus) {
  if (status === "ARCHIVED") {
    throw new HelpError(409, "HELP_ARTICLE_ARCHIVED", "Artikel arsip harus dipulihkan dulu sebelum diedit.");
  }
}

export function assertPublishable(status: HelpStatus) {
  if (status !== "DRAFT") {
    throw new HelpError(409, "HELP_ARTICLE_NOT_PUBLISHABLE", "Hanya artikel draf yang dapat diterbitkan.");
  }
}

export function assertArchivable(status: HelpStatus) {
  if (status === "ARCHIVED") {
    throw new HelpError(409, "HELP_ARTICLE_ALREADY_ARCHIVED", "Artikel sudah diarsipkan.");
  }
}

export function assertRestorable(status: HelpStatus) {
  if (status !== "ARCHIVED") {
    throw new HelpError(409, "HELP_ARTICLE_NOT_ARCHIVED", "Hanya artikel arsip yang dapat dipulihkan.");
  }
}

/** D-04: a write carries the version it read. */
export function assertFreshVersion(current: number, expected: number) {
  if (current !== expected) {
    throw new HelpError(409, "HELP_ARTICLE_STALE", "Artikel sudah diubah orang lain. Muat ulang lalu ulangi perubahan Anda.");
  }
}

export const MAX_SEARCH_WORDS = 8;

/**
 * D-06: split a query into at most eight words and turn each into an ILIKE pattern that treats
 * `%`, `_` and the escape character itself literally.
 */
export function searchPatterns(query: string | undefined): string[] {
  if (!query) return [];
  return query.trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_WORDS)
    .map((word) => `%${word.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
}

export interface SearchClause {
  where: string[];
  /** Sum of title hits for ordering (D-06); empty when there is no search. */
  titleRank: string;
  values: unknown[];
}

/**
 * Builds the word filter for `alias`, numbering placeholders from `firstIndex`. Every word must
 * appear in the title or the body; the rank counts title hits.
 */
export function searchClause(alias: string, patterns: string[], firstIndex: number): SearchClause {
  if (!patterns.length) return { where: [], titleRank: "", values: [] };
  const where: string[] = [];
  const rank: string[] = [];
  patterns.forEach((_, offset) => {
    const placeholder = `$${firstIndex + offset}`;
    where.push(`(${alias}.title ILIKE ${placeholder} ESCAPE '\\' OR ${alias}.body ILIKE ${placeholder} ESCAPE '\\')`);
    rank.push(`(${alias}.title ILIKE ${placeholder} ESCAPE '\\')::int`);
  });
  return { where, titleRank: rank.join(" + "), values: patterns };
}
