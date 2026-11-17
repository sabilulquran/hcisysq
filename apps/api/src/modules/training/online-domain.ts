// TRAIN-001 R4 rules: server-side watch credit, completion, byte ranges, MP4 inspection and
// quiz attempts. No database, no HTTP, no storage adapter.
// Spec: docs/domain/training-online-modules.md.

export const MATERIAL_KINDS = ["VIDEO", "TEXT"] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];
export const MODULE_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type ModuleStatus = (typeof MODULE_STATUSES)[number];

/** M-02 DRAFT. */
export const MAX_MODULES_PER_PROGRAM = 20;
export const MAX_MATERIALS_PER_MODULE = 20;
export const MAX_TEXT_LENGTH = 20_000;
/** M-04 DRAFT defaults; the environment may lower or raise them. */
export const DEFAULT_VIDEO_MAX_BYTES = 300 * 1024 * 1024;
export const DEFAULT_MEDIA_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
export const MIN_VIDEO_SECONDS = 10;
export const MAX_VIDEO_SECONDS = 4 * 3600;
/** M-08 DRAFT: a watch session without a heartbeat for this long has ended. */
export const PLAYBACK_IDLE_MS = 30 * 60_000;
/** M-09 DRAFT: one streamed response carries at most this many bytes. */
export const MAX_RANGE_BYTES = 4 * 1024 * 1024;
/** M-10 DRAFT. */
export const CREDIT_RATE = 1.25;
export const CREDIT_SLACK_SECONDS = 2;
export const MAX_CREDIT_WINDOW_SECONDS = 30;
/** M-11 DRAFT (discovery §12 no. 8). */
export const COMPLETION_SHARE = 0.95;
/** M-13 DRAFT. */
export const DEFAULT_QUIZ_PASSING_SCORE = 70;
export const DEFAULT_QUIZ_MAX_ATTEMPTS = 3;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * M-10: credit only progress that continues from the credited frontier and is no faster than real
 * time (with a small tolerance). A position ahead of the frontier earns credit only when the
 * previous position was at the frontier; skipping ahead or playing faster earns nothing.
 */
export function creditHeartbeat(input: {
  frontierSeconds: number;
  lastPositionSeconds: number;
  lastHeartbeatMs: number;
  nowMs: number;
  positionSeconds: number;
  durationSeconds: number;
  /** Credit when the watch session started, and when it started: the session as a whole never
   * credits faster than real time, so heartbeats sent back to back cannot add up their slack. */
  sessionBaseSeconds: number;
  sessionStartedMs: number;
}): { frontierSeconds: number; lastPositionSeconds: number } {
  const position = Math.max(0, Math.min(input.positionSeconds, input.durationSeconds));
  const elapsed = Math.max(0, Math.min((input.nowMs - input.lastHeartbeatMs) / 1000, MAX_CREDIT_WINDOW_SECONDS));
  let frontier = input.frontierSeconds;
  const contiguous = input.lastPositionSeconds <= frontier + CREDIT_SLACK_SECONDS;
  if (position > frontier && contiguous) {
    const reachable = input.lastPositionSeconds + elapsed * CREDIT_RATE + CREDIT_SLACK_SECONDS;
    const sessionCap = input.sessionBaseSeconds
      + Math.max(0, (input.nowMs - input.sessionStartedMs) / 1000) * CREDIT_RATE + CREDIT_SLACK_SECONDS;
    frontier = Math.max(frontier, Math.min(position, reachable, sessionCap, input.durationSeconds));
  }
  return { frontierSeconds: round3(frontier), lastPositionSeconds: round3(position) };
}

/** M-11. */
export function videoCompleted(frontierSeconds: number, durationSeconds: number) {
  return durationSeconds > 0 && frontierSeconds >= durationSeconds * COMPLETION_SHARE;
}

export type RangeResult = { kind: "ok"; start: number; end: number } | { kind: "missing" } | { kind: "unsatisfiable" };

/** M-09: one `bytes=start-end` range (no multi-range), capped at MAX_RANGE_BYTES. */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: "missing" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "") || size === 0) return { kind: "unsatisfiable" };
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return { kind: "unsatisfiable" };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || start >= size || end < start) return { kind: "unsatisfiable" };
  return { kind: "ok", start, end: Math.min(end, start + MAX_RANGE_BYTES - 1) };
}

export class VideoInspectionError extends Error {
  constructor(readonly code: "TRAINING_VIDEO_INVALID" | "TRAINING_VIDEO_DURATION", message: string) {
    super(message);
    this.name = "VideoInspectionError";
  }
}

type ReadAt = (start: number, end: number) => Promise<Buffer>;

async function boxAt(read: ReadAt, offset: number, limit: number) {
  if (offset + 8 > limit) return null;
  const header = await read(offset, Math.min(offset + 15, limit - 1));
  if (header.length < 8) return null;
  let size = header.readUInt32BE(0);
  const type = header.subarray(4, 8).toString("latin1");
  let headerSize = 8;
  if (size === 1) {
    if (header.length < 16) return null;
    size = Number(header.readBigUInt64BE(8));
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < headerSize || offset + size > limit) return null;
  return { type, offset, size, headerSize };
}

/**
 * M-04: an MP4 starts with `ftyp`; its duration is `mvhd.duration / mvhd.timescale` inside `moov`.
 * Only box headers and the `mvhd` payload are read, so the file is never loaded whole.
 */
export async function inspectMp4(read: ReadAt, byteSize: number): Promise<{ durationSeconds: number }> {
  const invalid = () => new VideoInspectionError("TRAINING_VIDEO_INVALID", "Berkas bukan video MP4 yang valid.");
  const first = await boxAt(read, 0, byteSize);
  if (!first || first.type !== "ftyp") throw invalid();
  let offset = 0;
  let moov: Awaited<ReturnType<typeof boxAt>> = null;
  for (let guard = 0; guard < 64 && offset < byteSize; guard += 1) {
    const box = await boxAt(read, offset, byteSize);
    if (!box) break;
    if (box.type === "moov") { moov = box; break; }
    offset += box.size;
  }
  if (!moov) throw invalid();
  let child = moov.offset + moov.headerSize;
  const end = moov.offset + moov.size;
  for (let guard = 0; guard < 64 && child < end; guard += 1) {
    const box = await boxAt(read, child, end);
    if (!box) break;
    if (box.type === "mvhd") {
      const body = await read(box.offset + box.headerSize, Math.min(box.offset + box.headerSize + 31, end - 1));
      const version = body[0];
      let timescale: number;
      let duration: number;
      if (version === 1 && body.length >= 32) {
        timescale = body.readUInt32BE(20);
        duration = Number(body.readBigUInt64BE(24));
      } else if (version === 0 && body.length >= 20) {
        timescale = body.readUInt32BE(12);
        duration = body.readUInt32BE(16);
      } else {
        throw invalid();
      }
      if (timescale === 0) throw invalid();
      const durationSeconds = Math.round((duration / timescale) * 1000) / 1000;
      if (durationSeconds < MIN_VIDEO_SECONDS || durationSeconds > MAX_VIDEO_SECONDS) {
        throw new VideoInspectionError("TRAINING_VIDEO_DURATION", "Durasi video 10 detik sampai 4 jam.");
      }
      return { durationSeconds };
    }
    child += box.size;
  }
  throw invalid();
}

/** M-02: credit hours 0.25–40 in quarters. */
export function validCreditHours(value: number) {
  return value >= 0.25 && value <= 40 && Number.isInteger(value * 4);
}

/** M-13: the highest score counts; passed once any attempt reaches the passing score. */
export function quizStanding(scores: readonly number[], passingScore: number, maxAttempts: number) {
  const best = scores.length === 0 ? null : Math.max(...scores);
  return {
    best,
    passed: best !== null && best >= passingScore,
    attemptsLeft: Math.max(0, maxAttempts - scores.length),
  };
}

/** M-14: a module is complete when every material is and its quiz (if any) has been passed. */
export function moduleComplete(input: { materials: number; completedMaterials: number; hasQuiz: boolean; quizPassed: boolean }) {
  return input.materials > 0 && input.completedMaterials >= input.materials && (!input.hasQuiz || input.quizPassed);
}
