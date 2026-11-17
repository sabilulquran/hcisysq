// TRAIN-001 R4 client: online modules, watch sessions and quizzes. The API decides every rule
// (who may watch, how much progress counts, when a module is complete); the player only reports.
// Spec: docs/domain/training-online-modules.md.

import { TrainingApiError, trainingGet as get, trainingQuery as query, trainingSend as send, type Paged } from "@/lib/training";
import type { Answers, Item } from "@/lib/trainingEvaluation";

export interface AdminMaterial {
  id: string;
  position: number;
  kind: "VIDEO" | "TEXT";
  title: string;
  hasVideo: boolean;
  byteSize: number | null;
  durationSeconds: number | null;
  bodyLength: number | null;
}

export interface AdminModule {
  id: string;
  position: number;
  title: string;
  description: string | null;
  creditHours: number;
  quizInstrumentId: string | null;
  quizItemCount: number;
  quizPassingScore: number;
  quizMaxAttempts: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  archiveReason: string | null;
  publishedAt: string | null;
  materials: AdminMaterial[];
}

export interface MyMaterial {
  id: string;
  kind: "VIDEO" | "TEXT";
  title: string;
  body: string | null;
  durationSeconds: number | null;
  creditedSeconds: number;
  completed: boolean;
}

export interface MyModule {
  id: string;
  title: string;
  description: string | null;
  creditHours: number;
  materials: MyMaterial[];
  quiz: { best: number | null; passed: boolean; attemptsLeft: number; passingScore: number; unlocked: boolean } | null;
  completed: boolean;
}

export interface StorageInfo {
  enabled: boolean;
  videoMaxBytes: number;
  quotaBytes: number;
  usedBytes: number;
}

export interface ProgressRow {
  employeeId: string;
  fullName: string;
  employeeNumber: string;
  participantStatus: string;
  materialCount: number;
  completedMaterials: number;
  passedQuizzes: number;
}

// ---------------------------------------------------------------- HC

export const getStorageInfo = () => get<StorageInfo>("/admin/training/online/storage");
export const getModules = (programId: string) => get<{ items: AdminModule[] }>(`/admin/training/programs/${programId}/modules`);
export const createModule = (programId: string, input: { title: string; description: string | null; creditHours: number }) =>
  send<{ id: string }>("POST", `/admin/training/programs/${programId}/modules`, input);
export const updateModule = (id: string, input: { quizInstrumentId?: string | null; quizPassingScore?: number; creditHours?: number }) =>
  send("PATCH", `/admin/training/modules/${id}`, input);
export const publishModule = (id: string) => send("POST", `/admin/training/modules/${id}/publish`);
export const archiveModule = (id: string, reason: string) => send("POST", `/admin/training/modules/${id}/archive`, { reason });
export const createMaterial = (moduleId: string, input: { kind: "VIDEO" | "TEXT"; title: string; body?: string }) =>
  send<{ id: string }>("POST", `/admin/training/modules/${moduleId}/materials`, input);
export const removeMaterial = (id: string) => send("POST", `/admin/training/materials/${id}/remove`);
export const getOnlineProgress = (programId: string, page = 1) =>
  get<Paged<ProgressRow>>(`/admin/training/programs/${programId}/online-progress${query({ page })}`);
export const completeMaterialFor = (materialId: string, employeeId: string, reason: string) =>
  send("POST", `/admin/training/materials/${materialId}/progress/${employeeId}/complete`, { reason });
export const adminPreviewUrl = (materialId: string) => `/api/admin/training/materials/${materialId}/stream`;

/** The MP4 is sent as the raw request body; the API streams it into storage. */
export async function uploadVideo(materialId: string, file: File) {
  if (file.type && file.type !== "video/mp4") throw new Error("Unggah video MP4.");
  const response = await fetch(`/api/admin/training/materials/${materialId}/video`, {
    method: "PUT", credentials: "include", headers: { Accept: "application/json", "Content-Type": "video/mp4" }, body: file,
  });
  const body = await response.json().catch(() => null) as { code?: string; message?: string; durationSeconds?: number } | null;
  if (!response.ok) throw new TrainingApiError(response.status, body?.code ?? "TRAINING_FAILED", body?.message ?? "Video tidak dapat diunggah.");
  return body as { durationSeconds: number; byteSize: number };
}

// ---------------------------------------------------------------- employee

export const getMyModules = (programId: string) => get<{ items: MyModule[] }>(`/training/me/programs/${programId}/modules`);
export const startPlayback = (materialId: string) =>
  send<{ playbackId: string; durationSeconds: number; creditedSeconds: number; completed: boolean; streamUrl: string }>(
    "POST", `/training/me/materials/${materialId}/playbacks`,
  );
export const heartbeat = (playbackId: string, position: number) =>
  send<{ creditedSeconds: number; completed: boolean; programCompleted: boolean }>("POST", `/training/me/playbacks/${playbackId}/heartbeat`, { position });
export const confirmReading = (materialId: string) =>
  send<{ completed: boolean; programCompleted: boolean }>("POST", `/training/me/materials/${materialId}/read`);
export const getQuiz = (moduleId: string) =>
  get<{ moduleId: string; title: string; best: number | null; passed: boolean; attemptsLeft: number; passingScore: number; items: Item[] }>(
    `/training/me/modules/${moduleId}/quiz`,
  );
export const submitQuiz = (moduleId: string, answers: Answers) =>
  send<{ score: number; passed: boolean; best: number; attemptsLeft: number; programCompleted: boolean }>(
    "POST", `/training/me/modules/${moduleId}/quiz/attempts`, { answers },
  );

// ---------------------------------------------------------------- player rules (comfort only; the server decides)

/** Seconds of the video the viewer may reach: the credited frontier plus a little slack. */
export function reachableSeconds(creditedSeconds: number) {
  return creditedSeconds + 2;
}

export function formatDuration(seconds: number | null | undefined) {
  if (!seconds) return "-";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

export function formatBytes(bytes: number | null | undefined) {
  if (!bytes) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}

export function progressPercent(creditedSeconds: number, durationSeconds: number | null) {
  return durationSeconds ? Math.min(100, Math.floor((creditedSeconds / durationSeconds) * 100)) : 0;
}
