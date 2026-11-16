// TRAIN-001 R3 client: instruments, evaluation plan, answering and recap. The API scores tests
// and owns every rule (who may answer, windows, pass status); this module shapes requests and
// labels states. Spec: docs/domain/training-evaluation.md.

import { trainingGet as get, trainingQuery as query, trainingSend as send, type Paged } from "@/lib/training";

export type InstrumentKind = "FORM" | "TEST" | "RUBRIC";
export type ComponentKind = "REACTION" | "PRE_POST_TEST" | "TEST" | "RUBRIC" | "FORM" | "RESULT";
export type Respondent = "PARTICIPANT" | "SUPERVISOR" | "HC";
export type Stage = "SINGLE" | "PRE" | "POST";
export type OutcomeStatus = "PASSED" | "FAILED" | "INCOMPLETE" | "NOT_GRADED";
export type ItemType = "SCALE" | "CHOICE" | "TEXT" | "SINGLE" | "MULTI" | "TRUE_FALSE" | "SHORT" | "CRITERION";

/** An item as HC edits it (with keys) or as a respondent sees it (keys never sent). */
export interface Item {
  id?: string;
  type: ItemType;
  prompt: string;
  required?: boolean;
  options?: string[];
  correct?: number | number[] | boolean;
  accepted?: string[];
  points?: number;
  levels?: string[];
}

export type AnswerValue = number | boolean | string | number[];
export type Answers = Record<string, AnswerValue>;

export interface InstrumentSummary {
  id: string;
  kind: InstrumentKind;
  title: string;
  description: string | null;
  isSystem: boolean;
  status: "ACTIVE" | "ARCHIVED";
  itemCount: number;
  usedBy: number;
}

export interface Instrument extends Omit<InstrumentSummary, "itemCount" | "usedBy"> {
  items: Item[];
}

export interface Component {
  id: string;
  kind: ComponentKind;
  level: number;
  respondent: Respondent;
  title: string;
  instrumentId: string;
  instrumentKind: InstrumentKind;
  items: Item[];
  anonymous: boolean;
  weight: number;
  required: boolean;
  opensAt: string | null;
  closesAt: string | null;
  status: "ACTIVE" | "ARCHIVED";
  archiveReason: string | null;
  responseCount: number;
  unassignedCount: number;
}

export interface Task {
  componentId: string;
  title: string;
  kind: ComponentKind;
  level: number;
  anonymous: boolean;
  stage: Stage;
  programId: string;
  programTitle: string;
  subjectEmployeeId: string | null;
  subjectName: string | null;
  as: "PARTICIPANT" | "SUPERVISOR";
  closesAt: string | null;
}

export interface EvaluationForm {
  component: { id: string; title: string; kind: ComponentKind; level: number; instrumentKind: InstrumentKind; anonymous: boolean; respondent: Respondent; closesAt: string | null };
  program: { id: string; title: string };
  stage: Stage;
  subject: { id: string; fullName: string } | null;
  items: Item[];
}

export interface Submitted {
  id?: string;
  anonymous: boolean;
  score: number | null;
  pointsEarned?: number | null;
  pointsMax?: number | null;
}

export interface Outcome {
  programId?: string;
  title?: string;
  status: OutcomeStatus;
  participantStatus?: string;
  employeeId?: string;
  fullName?: string;
  employeeNumber?: string;
  pre: number | null;
  post: number | null;
  gain: number | null;
  scores: Record<string, number | null>;
  finalScore: number | null;
  applicationScore: number | null;
  applicationRating: number | null;
}

export interface ItemSummary {
  id: string;
  type: ItemType;
  prompt: string;
  count: number;
  average?: number | null;
  distribution?: number[];
  options?: Array<{ label: string; count: number }>;
}

export interface ComponentSummary {
  id: string;
  kind: ComponentKind;
  level: number;
  respondent: Respondent;
  title: string;
  anonymous: boolean;
  weight: number;
  expected: number;
  submitted: number;
  submittedPre?: number;
  averagePre?: number | null;
  averagePost?: number | null;
  averageGain?: number | null;
  pairs?: number;
  averageScore?: number | null;
  items?: ItemSummary[];
}

export interface AssessorRow {
  subjectEmployeeId: string;
  subjectName: string;
  subjectNumber: string;
  assessorEmployeeId: string | null;
  assessorName: string | null;
  source: "DIRECT_MANAGER" | "GOVERNANCE_APPROVER" | "UNRESOLVED" | "HC_ASSIGNED";
  answered: boolean;
}

// ---------------------------------------------------------------- employee

export const getMyEvaluationTasks = (page = 1) => get<Paged<Task>>(`/training/me/evaluation/tasks${query({ page })}`);
export const getMyEvaluationForm = (componentId: string, stage: Stage, subjectEmployeeId?: string | null) =>
  get<EvaluationForm>(`/training/me/evaluation/components/${componentId}/form${query({ stage, subjectEmployeeId })}`);
export const submitMyEvaluation = (componentId: string, input: { stage: Stage; subjectEmployeeId?: string | null; answers: Answers }) =>
  send<Submitted>("POST", `/training/me/evaluation/components/${componentId}/responses`, input);
export const getMyEvaluationResults = (page = 1) => get<Paged<Outcome>>(`/training/me/evaluation/results${query({ page })}`);

// ---------------------------------------------------------------- HC

export const getInstruments = (filter: { page?: number; kind?: InstrumentKind | ""; status?: "ACTIVE" | "ARCHIVED" | ""; q?: string }) =>
  get<Paged<InstrumentSummary>>(`/admin/training/instruments${query({ page: filter.page ?? 1, kind: filter.kind, status: filter.status, q: filter.q })}`);
export const getInstrument = (id: string) => get<Instrument>(`/admin/training/instruments/${id}`);
export const createInstrument = (input: { kind: InstrumentKind; title: string; description: string | null; items: Item[] }) =>
  send<{ id: string }>("POST", "/admin/training/instruments", input);
export const updateInstrument = (id: string, input: { title?: string; description?: string | null; items?: Item[] }) =>
  send<{ id: string }>("PATCH", `/admin/training/instruments/${id}`, input);
export const archiveInstrument = (id: string) => send("POST", `/admin/training/instruments/${id}/archive`);
export const setPassingScore = (programId: string, passingScore: number) =>
  send("PATCH", `/admin/training/programs/${programId}/evaluation`, { passingScore });
export const getComponents = (programId: string) =>
  get<{ passingScore: number; items: Component[] }>(`/admin/training/programs/${programId}/evaluation/components`);
export const createComponent = (programId: string, input: {
  kind: ComponentKind; instrumentId: string; title?: string; level?: number | null; respondent?: Respondent | null;
  anonymous?: boolean | null; weight?: number | null; required?: boolean; opensAt?: string | null; closesAt?: string | null;
}) => send<{ id: string }>("POST", `/admin/training/programs/${programId}/evaluation/components`, input);
export const updateComponent = (id: string, input: { title?: string; weight?: number; required?: boolean; opensAt?: string | null; closesAt?: string | null }) =>
  send("PATCH", `/admin/training/evaluation/components/${id}`, input);
export const archiveComponent = (id: string, reason: string) => send("POST", `/admin/training/evaluation/components/${id}/archive`, { reason });
export const getAssessors = (componentId: string, page = 1) =>
  get<Paged<AssessorRow> & { respondent: Respondent }>(`/admin/training/evaluation/components/${componentId}/assessors${query({ page })}`);
export const assignAssessor = (componentId: string, subjectEmployeeId: string, assessorEmployeeId: string) =>
  send("PUT", `/admin/training/evaluation/components/${componentId}/assessors`, { entries: [{ subjectEmployeeId, assessorEmployeeId }] });
export const getHcEvaluationForm = (componentId: string, stage: Stage, subjectEmployeeId?: string | null) =>
  get<EvaluationForm>(`/admin/training/evaluation/components/${componentId}/form${query({ stage, subjectEmployeeId })}`);
export const submitHcEvaluation = (componentId: string, input: { stage: Stage; subjectEmployeeId?: string | null; answers: Answers }) =>
  send<Submitted>("POST", `/admin/training/evaluation/components/${componentId}/responses`, input);
export const getComments = (componentId: string, page = 1) =>
  get<Paged<{ itemId: string; text: string; subjectName: string | null; submittedOn: string }> & { hidden: boolean; threshold?: number }>(
    `/admin/training/evaluation/components/${componentId}/comments${query({ page })}`,
  );
export const getEvaluationSummary = (programId: string) =>
  get<{ passingScore: number; participantCount: number; components: ComponentSummary[] }>(`/admin/training/programs/${programId}/evaluation/summary`);
export const getEvaluationResults = (programId: string, page = 1) =>
  get<Paged<Outcome>>(`/admin/training/programs/${programId}/evaluation/results${query({ page })}`);
export const getEmployeeEvaluation = (employeeId: string, page = 1) =>
  get<Paged<Outcome> & { employee: { id: string; fullName: string; employeeNumber: string } }>(
    `/admin/training/employees/${employeeId}/evaluation${query({ page })}`,
  );

// ---------------------------------------------------------------- labels

export const INSTRUMENT_KIND_LABELS: Record<InstrumentKind, string> = { FORM: "Formulir", TEST: "Tes", RUBRIC: "Rubrik" };

export const COMPONENT_KIND_LABELS: Record<ComponentKind, string> = {
  REACTION: "Reaksi peserta (anonim)",
  PRE_POST_TEST: "Pre-test dan post-test",
  TEST: "Tes",
  RUBRIC: "Rubrik penilaian",
  FORM: "Formulir",
  RESULT: "Indikator hasil",
};

export const LEVEL_LABELS: Record<number, string> = { 1: "Tingkat 1 · Reaksi", 2: "Tingkat 2 · Pembelajaran", 3: "Tingkat 3 · Penerapan", 4: "Tingkat 4 · Hasil" };

export const RESPONDENT_LABELS: Record<Respondent, string> = { PARTICIPANT: "Peserta", SUPERVISOR: "Atasan peserta", HC: "Human Capital" };

export const STAGE_LABELS: Record<Stage, string> = { SINGLE: "", PRE: "Pre-test", POST: "Post-test" };

export const OUTCOME_LABELS: Record<OutcomeStatus, string> = {
  PASSED: "Lulus", FAILED: "Tidak lulus", INCOMPLETE: "Belum lengkap", NOT_GRADED: "Tanpa nilai",
};

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  SCALE: "Skala 1–5", CHOICE: "Pilihan", TEXT: "Isian teks", SINGLE: "Pilihan ganda", MULTI: "Pilihan ganda kompleks",
  TRUE_FALSE: "Benar/salah", SHORT: "Isian singkat", CRITERION: "Kriteria rubrik",
};

export const ITEM_TYPES_FOR: Record<InstrumentKind, ItemType[]> = {
  FORM: ["SCALE", "CHOICE", "TEXT"],
  TEST: ["SINGLE", "MULTI", "TRUE_FALSE", "SHORT"],
  RUBRIC: ["CRITERION"],
};

/** The instrument kind a component needs (§5.2); the API checks it again. */
export const INSTRUMENT_FOR_COMPONENT: Record<ComponentKind, InstrumentKind> = {
  REACTION: "FORM", PRE_POST_TEST: "TEST", TEST: "TEST", RUBRIC: "RUBRIC", FORM: "FORM", RESULT: "FORM",
};

export const SCALE_LABELS = ["Sangat tidak setuju", "Tidak setuju", "Ragu-ragu", "Setuju", "Sangat setuju"];

export function formatScore(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(value);
}

/** One line naming a task: what, for which program, and for whom when assessing someone else. */
export function describeTask(task: Task) {
  const stage = STAGE_LABELS[task.stage];
  const what = stage ? `${stage} · ${task.title}` : task.title;
  return task.as === "SUPERVISOR" ? `${what} — menilai ${task.subjectName ?? "peserta"}` : what;
}

/** Fresh item of a type, for the instrument builder. */
export function blankItem(type: ItemType): Item {
  switch (type) {
    case "SCALE":
    case "TEXT":
      return { type, prompt: "", required: true };
    case "CHOICE":
      return { type, prompt: "", required: true, options: ["", ""] };
    case "SINGLE":
      return { type, prompt: "", options: ["", ""], correct: 0, points: 1 };
    case "MULTI":
      return { type, prompt: "", options: ["", ""], correct: [0], points: 1 };
    case "TRUE_FALSE":
      return { type, prompt: "", correct: true, points: 1 };
    case "SHORT":
      return { type, prompt: "", accepted: [""], points: 1 };
    case "CRITERION":
      return { type, prompt: "", levels: ["Kurang", "Cukup", "Baik", "Sangat baik"] };
  }
}

/** Items the respondent must answer before the form can be sent (the API checks again). */
export function missingRequired(items: readonly Item[], answers: Answers): Item[] {
  return items.filter((item) => {
    const mandatory = item.type === "CRITERION" || ((item.type === "SCALE" || item.type === "CHOICE" || item.type === "TEXT") && item.required !== false);
    if (!mandatory) return false;
    const value = answers[item.id ?? ""];
    return value === undefined || (typeof value === "string" && value.trim() === "");
  });
}

const fromLines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);

/** Trims the builder's free text into the shape the API validates. */
export function cleanItems(items: Item[]): Item[] {
  return items.map((item) => ({
    ...item,
    prompt: item.prompt.trim(),
    ...(item.options ? { options: fromLines(item.options.join("\n")) } : {}),
    ...(item.accepted ? { accepted: fromLines(item.accepted.join("\n")) } : {}),
  }));
}

/** One line of numbers per component, exported for markup tests. */
export function summaryLine(summary: ComponentSummary | undefined) {
  if (!summary) return "";
  if (summary.kind === "PRE_POST_TEST") {
    return `Pre ${summary.submittedPre ?? 0}/${summary.expected} · rata-rata ${formatScore(summary.averagePre)} · Post ${summary.submitted}/${summary.expected} · rata-rata ${formatScore(summary.averagePost)} · peningkatan ${formatScore(summary.averageGain)}`;
  }
  const base = `Terisi ${summary.submitted}/${summary.expected}`;
  if (summary.averageScore !== null && summary.averageScore !== undefined) return `${base} · rata-rata ${formatScore(summary.averageScore)}`;
  const scales = (summary.items ?? []).filter((item) => item.type === "SCALE" && item.average !== null && item.average !== undefined);
  if (scales.length > 0) return `${base} · skala rata-rata ${formatScore(scales.reduce((sum, item) => sum + (item.average ?? 0), 0) / scales.length)}/5`;
  return base;
}
