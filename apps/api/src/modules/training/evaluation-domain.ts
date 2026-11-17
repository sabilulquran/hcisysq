// TRAIN-001 R3 rules: instruments, items, component pairs, answer validation, scoring, final
// score and status, and form aggregates. No database, no HTTP.
// Spec: docs/domain/training-evaluation.md.

export const INSTRUMENT_KINDS = ["FORM", "TEST", "RUBRIC"] as const;
export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number];
export const COMPONENT_KINDS = ["REACTION", "PRE_POST_TEST", "TEST", "RUBRIC", "FORM", "RESULT"] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];
export const RESPONDENTS = ["PARTICIPANT", "SUPERVISOR", "HC"] as const;
export type Respondent = (typeof RESPONDENTS)[number];
export const STAGES = ["SINGLE", "PRE", "POST"] as const;
export type Stage = (typeof STAGES)[number];
export type OutcomeStatus = "PASSED" | "FAILED" | "INCOMPLETE" | "NOT_GRADED";

/** E-10: the seeded standard reaction questionnaire (migration 0155). */
export const STANDARD_REACTION_INSTRUMENT_ID = "00000000-0000-4000-8000-0000000000e1";
/** E-02 DRAFT. */
export const MAX_ITEMS = 50;
export const MAX_OPTIONS = 10;
export const MAX_POINTS = 10;
/** E-18 DRAFT. */
export const MAX_ACTIVE_COMPONENTS = 20;
/** E-11 DRAFT: anonymous comments show only from this many responses. */
export const ANONYMOUS_COMMENT_THRESHOLD = 3;
/** E-07 DRAFT. */
export const DEFAULT_PASSING_SCORE = 75;

export type Item =
  | { id: string; type: "SCALE"; prompt: string; required: boolean }
  | { id: string; type: "CHOICE"; prompt: string; options: string[]; required: boolean }
  | { id: string; type: "TEXT"; prompt: string; required: boolean }
  | { id: string; type: "SINGLE"; prompt: string; options: string[]; correct: number; points: number }
  | { id: string; type: "MULTI"; prompt: string; options: string[]; correct: number[]; points: number }
  | { id: string; type: "TRUE_FALSE"; prompt: string; correct: boolean; points: number }
  | { id: string; type: "SHORT"; prompt: string; accepted: string[]; points: number }
  | { id: string; type: "CRITERION"; prompt: string; levels: string[] };
export type ItemType = Item["type"];

const ITEM_TYPES_BY_KIND: Record<InstrumentKind, readonly ItemType[]> = {
  FORM: ["SCALE", "CHOICE", "TEXT"],
  TEST: ["SINGLE", "MULTI", "TRUE_FALSE", "SHORT"],
  RUBRIC: ["CRITERION"],
};

export type EvaluationPolicyCode =
  | "INVALID_TRAINING_INSTRUMENT"
  | "INVALID_TRAINING_COMPONENT"
  | "INVALID_TRAINING_RESPONSE";

export class EvaluationPolicyError extends Error {
  constructor(readonly code: EvaluationPolicyCode, message: string) {
    super(message);
    this.name = "EvaluationPolicyError";
  }

  get statusCode(): number {
    return 400;
  }
}

const instrumentError = (message: string) => new EvaluationPolicyError("INVALID_TRAINING_INSTRUMENT", message);
const responseError = (message: string) => new EvaluationPolicyError("INVALID_TRAINING_RESPONSE", message);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number, what: string): string {
  if (typeof value !== "string") throw instrumentError(`${what} wajib diisi.`);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) throw instrumentError(`${what} 1 sampai ${max} huruf.`);
  return trimmed;
}

function options(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_OPTIONS) {
    throw instrumentError(`Pilihan jawaban 2 sampai ${MAX_OPTIONS}.`);
  }
  return value.map((option) => text(option, 200, "Pilihan jawaban"));
}

function points(value: unknown): number {
  const result = value === undefined ? 1 : value;
  if (typeof result !== "number" || !Number.isInteger(result) || result < 1 || result > MAX_POINTS) {
    throw instrumentError(`Poin soal 1 sampai ${MAX_POINTS}.`);
  }
  return result;
}

function index(value: unknown, length: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= length) {
    throw instrumentError("Kunci jawaban harus salah satu pilihan.");
  }
  return value;
}

/** §5.1: validates raw items for one instrument kind and numbers them q1..qN. */
export function normalizeItems(kind: InstrumentKind, raw: unknown): Item[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ITEMS) {
    throw instrumentError(`Instrumen berisi 1 sampai ${MAX_ITEMS} butir.`);
  }
  const allowed = ITEM_TYPES_BY_KIND[kind];
  return raw.map((entry, position): Item => {
    if (!isRecord(entry) || typeof entry.type !== "string" || !allowed.includes(entry.type as ItemType)) {
      throw instrumentError(`Butir ${position + 1}: jenis tidak cocok dengan instrumen ${kind}.`);
    }
    const id = `q${position + 1}`;
    const prompt = text(entry.prompt, 500, `Butir ${position + 1}`);
    const required = entry.required === undefined ? true : entry.required === true;
    switch (entry.type as ItemType) {
      case "SCALE":
        return { id, type: "SCALE", prompt, required };
      case "TEXT":
        return { id, type: "TEXT", prompt, required };
      case "CHOICE":
        return { id, type: "CHOICE", prompt, options: options(entry.options), required };
      case "SINGLE": {
        const list = options(entry.options);
        return { id, type: "SINGLE", prompt, options: list, correct: index(entry.correct, list.length), points: points(entry.points) };
      }
      case "MULTI": {
        const list = options(entry.options);
        if (!Array.isArray(entry.correct) || entry.correct.length < 1) throw instrumentError("Kunci jawaban wajib dipilih.");
        const correct = [...new Set(entry.correct.map((value) => index(value, list.length)))].sort((a, b) => a - b);
        if (correct.length !== entry.correct.length) throw instrumentError("Kunci jawaban tidak boleh berulang.");
        return { id, type: "MULTI", prompt, options: list, correct, points: points(entry.points) };
      }
      case "TRUE_FALSE":
        if (typeof entry.correct !== "boolean") throw instrumentError("Kunci benar/salah wajib dipilih.");
        return { id, type: "TRUE_FALSE", prompt, correct: entry.correct, points: points(entry.points) };
      case "SHORT": {
        if (!Array.isArray(entry.accepted) || entry.accepted.length < 1 || entry.accepted.length > 10) {
          throw instrumentError("Jawaban yang diterima 1 sampai 10.");
        }
        const accepted = [...new Set(entry.accepted.map((value) => normalizeShort(text(value, 200, "Jawaban yang diterima"))))];
        return { id, type: "SHORT", prompt, accepted, points: points(entry.points) };
      }
      case "CRITERION": {
        if (!Array.isArray(entry.levels) || entry.levels.length !== 4) throw instrumentError("Rubrik memerlukan tepat 4 deskriptor tingkat.");
        return { id, type: "CRITERION", prompt, levels: entry.levels.map((level) => text(level, 300, "Deskriptor tingkat")) };
      }
    }
  });
}

/** E-04: case, surrounding space and repeated inner space never decide a short answer. */
export function normalizeShort(value: string): string {
  return value.trim().toLocaleLowerCase("id-ID").replace(/\s+/g, " ");
}

/** TRAIN-R3-A: what a respondent may see; keys and accepted answers never leave the server. */
export function publicItems(items: readonly Item[]) {
  return items.map((item) => {
    if (item.type === "SINGLE" || item.type === "MULTI") {
      return { id: item.id, type: item.type, prompt: item.prompt, options: item.options, points: item.points };
    }
    if (item.type === "TRUE_FALSE" || item.type === "SHORT") {
      return { id: item.id, type: item.type, prompt: item.prompt, points: item.points };
    }
    return item;
  });
}

// ------------------------------------------------------------ components

export interface ComponentInput {
  kind: ComponentKind;
  instrumentKind: InstrumentKind;
  level?: number | null | undefined;
  respondent?: Respondent | null | undefined;
  anonymous?: boolean | null | undefined;
  weight?: number | null | undefined;
}

export interface ResolvedComponent {
  level: number;
  respondent: Respondent;
  anonymous: boolean;
  weight: number;
}

const componentError = (message: string) => new EvaluationPolicyError("INVALID_TRAINING_COMPONENT", message);

export const INSTRUMENT_FOR_COMPONENT: Record<ComponentKind, InstrumentKind> = {
  REACTION: "FORM", PRE_POST_TEST: "TEST", TEST: "TEST", RUBRIC: "RUBRIC", FORM: "FORM", RESULT: "FORM",
};

/** §5.2 / E-06: the fixed kind, level, respondent, anonymity and weight pairs. */
export function resolveComponent(input: ComponentInput): ResolvedComponent {
  const weight = input.weight ?? 0;
  if (!Number.isInteger(weight) || weight < 0 || weight > 100) throw componentError("Bobot 0 sampai 100.");
  const fixed = (level: number, respondent: Respondent, anonymous: boolean, weighted: boolean): ResolvedComponent => {
    if (!weighted && weight !== 0) throw componentError("Komponen ini tidak berbobot.");
    return { level, respondent, anonymous, weight };
  };
  switch (input.kind) {
    case "REACTION":
      return fixed(1, "PARTICIPANT", true, false);
    case "PRE_POST_TEST":
    case "TEST":
      if (input.anonymous) throw componentError("Tes tidak dapat anonim.");
      return fixed(2, "PARTICIPANT", false, true);
    case "RESULT":
      return fixed(4, "HC", false, false);
    case "RUBRIC": {
      const level = input.level ?? 2;
      const respondent = input.respondent ?? "HC";
      if (level !== 2 && level !== 3) throw componentError("Rubrik dipakai pada tingkat 2 atau 3.");
      if (respondent !== "HC" && respondent !== "SUPERVISOR") throw componentError("Rubrik diisi HC atau atasan.");
      if (input.anonymous) throw componentError("Rubrik tidak dapat anonim.");
      return fixed(level, respondent, false, level === 2);
    }
    case "FORM": {
      const level = input.level ?? 1;
      const respondent = input.respondent ?? "PARTICIPANT";
      if (![1, 2, 3].includes(level)) throw componentError("Formulir dipakai pada tingkat 1 sampai 3.");
      if (respondent !== "PARTICIPANT" && respondent !== "SUPERVISOR") throw componentError("Formulir diisi peserta atau atasan.");
      const anonymous = input.anonymous === true;
      if (anonymous && respondent !== "PARTICIPANT") throw componentError("Hanya formulir peserta yang dapat anonim.");
      return fixed(level, respondent, anonymous, false);
    }
  }
}

/** §5.3: the component is accepting answers now. */
export function componentOpen(input: {
  status: string;
  programStatus: string;
  opensAt: Date | null;
  closesAt: Date | null;
  nowMs: number;
}): boolean {
  if (input.status !== "ACTIVE" || input.programStatus === "CANCELLED") return false;
  if (input.opensAt && input.nowMs < input.opensAt.getTime()) return false;
  if (input.closesAt && input.nowMs >= input.closesAt.getTime()) return false;
  return true;
}

/**
 * E-12: pre-test until the participant has a post-test; post-test once the program's last
 * scheduled session has started, the program is closed, or it has no scheduled session.
 */
export function stageOpen(input: {
  kind: ComponentKind;
  stage: Stage;
  programStatus: string;
  lastSessionStartMs: number | null;
  hasPost: boolean;
  nowMs: number;
}): boolean {
  if (input.kind !== "PRE_POST_TEST") return input.stage === "SINGLE";
  if (input.stage === "PRE") return !input.hasPost;
  if (input.stage === "POST") {
    return input.programStatus === "COMPLETED" || input.lastSessionStartMs === null || input.nowMs >= input.lastSessionStartMs;
  }
  return false;
}

// --------------------------------------------------------------- answers

export type AnswerValue = number | boolean | string | number[];
export type Answers = Record<string, AnswerValue>;

/** §5.3: shape-checks every answer against the component's items; unknown items are refused. */
export function validateAnswers(items: readonly Item[], raw: unknown): Answers {
  if (!isRecord(raw)) throw responseError("Jawaban tidak valid.");
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const key of Object.keys(raw)) if (!byId.has(key)) throw responseError("Jawaban memuat butir yang tidak dikenal.");
  const answers: Answers = {};
  for (const item of items) {
    const value = raw[item.id];
    const empty = value === undefined || value === null || (typeof value === "string" && value.trim() === "")
      || (Array.isArray(value) && value.length === 0);
    if (empty) {
      const mandatory = item.type === "CRITERION" || ((item.type === "SCALE" || item.type === "CHOICE" || item.type === "TEXT") && item.required);
      if (mandatory) throw responseError(`Butir "${item.prompt}" wajib dijawab.`);
      continue;
    }
    const integerIn = (min: number, max: number) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
    switch (item.type) {
      case "SCALE":
        if (!integerIn(1, 5)) throw responseError("Skala 1 sampai 5.");
        answers[item.id] = value as number;
        break;
      case "CRITERION":
        if (!integerIn(1, 4)) throw responseError("Tingkat rubrik 1 sampai 4.");
        answers[item.id] = value as number;
        break;
      case "CHOICE":
      case "SINGLE":
        if (!integerIn(0, item.options.length - 1)) throw responseError("Pilihan tidak valid.");
        answers[item.id] = value as number;
        break;
      case "MULTI": {
        if (!Array.isArray(value) || value.length > item.options.length
          || !value.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry < item.options.length)
          || new Set(value).size !== value.length) {
          throw responseError("Pilihan tidak valid.");
        }
        answers[item.id] = [...(value as number[])].sort((a, b) => a - b);
        break;
      }
      case "TRUE_FALSE":
        if (typeof value !== "boolean") throw responseError("Jawaban benar/salah tidak valid.");
        answers[item.id] = value;
        break;
      case "SHORT":
      case "TEXT": {
        const max = item.type === "SHORT" ? 200 : 2000;
        if (typeof value !== "string" || value.trim().length > max) throw responseError(`Jawaban paling panjang ${max} huruf.`);
        answers[item.id] = value.trim();
        break;
      }
    }
  }
  return answers;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** E-04 / E-05: server-side test score. Unanswered questions earn nothing. */
export function scoreTest(items: readonly Item[], answers: Answers) {
  let earned = 0;
  let max = 0;
  for (const item of items) {
    if (item.type !== "SINGLE" && item.type !== "MULTI" && item.type !== "TRUE_FALSE" && item.type !== "SHORT") continue;
    max += item.points;
    const value = answers[item.id];
    if (value === undefined) continue;
    const right =
      (item.type === "SINGLE" && value === item.correct)
      || (item.type === "TRUE_FALSE" && value === item.correct)
      || (item.type === "MULTI" && Array.isArray(value) && value.length === item.correct.length
        && value.every((entry, position) => entry === item.correct[position]))
      || (item.type === "SHORT" && typeof value === "string" && item.accepted.includes(normalizeShort(value)));
    if (right) earned += item.points;
  }
  return { earned, max, score: max === 0 ? 0 : round2((earned / max) * 100) };
}

/** E-05: sum of levels over four times the number of criteria. */
export function scoreRubric(items: readonly Item[], answers: Answers) {
  const criteria = items.filter((item) => item.type === "CRITERION");
  const earned = criteria.reduce((sum, item) => sum + Number(answers[item.id] ?? 0), 0);
  const max = criteria.length * 4;
  return { earned, max, score: max === 0 ? 0 : round2((earned / max) * 100) };
}

export function scoreResponse(instrumentKind: InstrumentKind, items: readonly Item[], answers: Answers) {
  if (instrumentKind === "TEST") return scoreTest(items, answers);
  if (instrumentKind === "RUBRIC") return scoreRubric(items, answers);
  return null;
}

/** Mean of a FORM response's SCALE answers (1–5), used for supervisor forms in the level-3 column. */
export function scaleMean(items: readonly Item[], answers: Answers): number | null {
  const values = items.filter((item) => item.type === "SCALE").map((item) => answers[item.id]).filter((value) => typeof value === "number") as number[];
  return values.length === 0 ? null : round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

// --------------------------------------------------------------- outcome

export interface OutcomeComponent {
  id: string;
  kind: ComponentKind;
  level: number;
  weight: number;
  required: boolean;
}

/**
 * §6.2 / E-07 / E-08: the final score and status of one participant from level 1–2 components.
 * `done` holds the ids of components the participant has completed (post stage for pre/post);
 * `scores` the score used for weighting (post score for pre/post).
 */
export function computeOutcome(input: {
  components: readonly OutcomeComponent[];
  done: ReadonlySet<string>;
  scores: ReadonlyMap<string, number>;
  passingScore: number;
}): { finalScore: number | null; status: OutcomeStatus } {
  const counted = input.components.filter((component) => component.level <= 2);
  const missing = counted.some((component) => component.required && !input.done.has(component.id));
  const weighted = counted.filter((component) => component.weight > 0);
  const totalWeight = weighted.reduce((sum, component) => sum + component.weight, 0);
  const finalScore = totalWeight === 0
    ? null
    : round2(weighted.reduce((sum, component) => sum + component.weight * (input.scores.get(component.id) ?? 0), 0) / totalWeight);
  if (missing) return { finalScore, status: "INCOMPLETE" };
  if (finalScore === null) return { finalScore, status: "NOT_GRADED" };
  return { finalScore, status: finalScore >= input.passingScore ? "PASSED" : "FAILED" };
}

/**
 * E-11: aggregates and comments of an anonymous component show only once it no longer takes
 * answers (closed window, archived, cancelled program) and at least the threshold answered, so a
 * lone answer, or the difference between two reads while answers arrive, cannot single anyone out.
 */
export function anonymousAggregatesVisible(input: {
  responses: number;
  status: string;
  programStatus: string;
  closesAt: Date | null;
  nowMs: number;
}): boolean {
  if (input.responses < ANONYMOUS_COMMENT_THRESHOLD) return false;
  return input.status !== "ACTIVE" || input.programStatus === "CANCELLED"
    || (input.closesAt !== null && input.closesAt.getTime() <= input.nowMs);
}

/** Mean of numbers, two decimals; null for none. */
export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** §5.4: per-item aggregates of FORM responses. Text answers are only counted here. */
export function summarizeForm(items: readonly Item[], responses: readonly Answers[]) {
  return items.map((item) => {
    if (item.type === "SCALE") {
      const values = responses.map((answers) => answers[item.id]).filter((value): value is number => typeof value === "number");
      const distribution = [1, 2, 3, 4, 5].map((level) => values.filter((value) => value === level).length);
      return { id: item.id, type: item.type, prompt: item.prompt, count: values.length, average: mean(values), distribution };
    }
    if (item.type === "CHOICE") {
      const values = responses.map((answers) => answers[item.id]).filter((value): value is number => typeof value === "number");
      return {
        id: item.id, type: item.type, prompt: item.prompt, count: values.length,
        options: item.options.map((label, position) => ({ label, count: values.filter((value) => value === position).length })),
      };
    }
    if (item.type === "CRITERION") {
      const values = responses.map((answers) => answers[item.id]).filter((value): value is number => typeof value === "number");
      return { id: item.id, type: item.type, prompt: item.prompt, count: values.length, average: mean(values) };
    }
    const count = responses.filter((answers) => answers[item.id] !== undefined).length;
    return { id: item.id, type: item.type, prompt: item.prompt, count };
  });
}
