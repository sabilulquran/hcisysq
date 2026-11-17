// TRAIN-001 R4 pure rules and the ObjectStorage contract (ADR-0002: one suite, every adapter).
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertObjectKey,
  LocalFileObjectStorage,
  MemoryObjectStorage,
  ObjectNotFoundError,
  ObjectTooLargeError,
  readRange,
  type ObjectStorage,
} from "../src/lib/object-storage.js";
import {
  creditHeartbeat,
  inspectMp4,
  MAX_RANGE_BYTES,
  moduleComplete,
  parseRange,
  quizStanding,
  validCreditHours,
  VideoInspectionError,
  videoCompleted,
} from "../src/modules/training/online-domain.js";
import { syntheticMp4 } from "./fixtures/synthetic-mp4.js";

const bytes = (text: string) => Readable.from([Buffer.from(text)]);

let directory = "";
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "hcis-object-storage-")); });
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const adapters: Array<[string, () => ObjectStorage]> = [
  ["local", () => new LocalFileObjectStorage(directory)],
  ["memory", () => new MemoryObjectStorage()],
];

describe.each(adapters)("ObjectStorage contract: %s", (_name, make) => {
  it("stores, sizes, hashes, reads ranges and deletes", async () => {
    const storage = make();
    const stored = await storage.put("training/videos/a/one.mp4", bytes("0123456789"), { maxBytes: 100 });
    expect(stored).toEqual({ byteSize: 10, sha256: "84d89877f0d4041efb6bf91a16f0248f2fd573e6af05c19f96bedb9f882f7882" });
    expect(await storage.stat("training/videos/a/one.mp4")).toEqual({ byteSize: 10 });
    expect((await readRange(storage, "training/videos/a/one.mp4", { start: 2, end: 5 })).toString()).toBe("2345");
    await storage.delete("training/videos/a/one.mp4");
    expect(await storage.stat("training/videos/a/one.mp4")).toBeNull();
    await expect(storage.read("training/videos/a/one.mp4")).rejects.toBeInstanceOf(ObjectNotFoundError);
    await storage.delete("training/videos/a/one.mp4");
  });

  it("refuses an object past the limit and keeps nothing", async () => {
    const storage = make();
    await expect(storage.put("training/videos/b/big.mp4", bytes("x".repeat(50)), { maxBytes: 10 })).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(await storage.stat("training/videos/b/big.mp4")).toBeNull();
  });

  it("never accepts a host path or traversal as a key", async () => {
    const storage = make();
    for (const key of ["../etc/passwd", "/abs/path", "training/../../x", "Training/Upper", "a//b"]) {
      await expect(storage.put(key, bytes("x"), { maxBytes: 10 })).rejects.toThrow(/Invalid object key/);
    }
  });
});

describe("TRAIN-001 R4 rules", () => {
  it("leaves no partial file behind in the local adapter", async () => {
    const local = new LocalFileObjectStorage(directory);
    await expect(local.put("training/videos/c/x.mp4", bytes("y".repeat(30)), { maxBytes: 5 })).rejects.toThrow();
    expect(await readdir(join(directory, "training", "videos", "c"))).toEqual([]);
    expect(() => assertObjectKey("training/videos/ok/1.mp4")).not.toThrow();
  });

  it("credits only contiguous real-time progress (M-10)", () => {
    // A session that started long ago: only the per-heartbeat rule applies.
    const base = { frontierSeconds: 100, lastPositionSeconds: 100, lastHeartbeatMs: 0, durationSeconds: 600, sessionBaseSeconds: 0, sessionStartedMs: -3_600_000 };
    // Ten real seconds, ten seconds watched: credited.
    expect(creditHeartbeat({ ...base, nowMs: 10_000, positionSeconds: 110 }).frontierSeconds).toBe(110);
    // Twice the speed: only real time × 1.25 + 2.
    expect(creditHeartbeat({ ...base, nowMs: 10_000, positionSeconds: 120 }).frontierSeconds).toBe(114.5);
    // A jump far ahead after a long pause gains at most the 30-second window.
    expect(creditHeartbeat({ ...base, nowMs: 600_000, positionSeconds: 500 }).frontierSeconds).toBe(139.5);
    // Not contiguous (last reported position already past the frontier): nothing.
    expect(creditHeartbeat({ ...base, lastPositionSeconds: 300, nowMs: 10_000, positionSeconds: 310 }).frontierSeconds).toBe(100);
    // Rewinding is free and never loses credit.
    expect(creditHeartbeat({ ...base, nowMs: 10_000, positionSeconds: 20 })).toEqual({ frontierSeconds: 100, lastPositionSeconds: 20 });
    // Heartbeats sent back to back cannot add up their slack: the session as a whole is capped.
    let state = { frontierSeconds: 100, lastPositionSeconds: 100 };
    for (let i = 0; i < 50; i += 1) {
      state = creditHeartbeat({ ...state, lastHeartbeatMs: 1_000, nowMs: 1_000, positionSeconds: state.frontierSeconds + 2,
        durationSeconds: 600, sessionBaseSeconds: 100, sessionStartedMs: 0 });
    }
    expect(state.frontierSeconds).toBeLessThanOrEqual(100 + 1 * 1.25 + 2);
    expect(videoCompleted(570, 600)).toBe(true);
    expect(videoCompleted(569, 600)).toBe(false);
  });

  it("parses single byte ranges, capped per response (M-09)", () => {
    expect(parseRange(undefined, 100)).toEqual({ kind: "missing" });
    expect(parseRange("bytes=0-", 100)).toEqual({ kind: "ok", start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ kind: "ok", start: 10, end: 19 });
    expect(parseRange("bytes=-10", 100)).toEqual({ kind: "ok", start: 90, end: 99 });
    expect(parseRange("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-1,5-6", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-", 50_000_000)).toEqual({ kind: "ok", start: 0, end: MAX_RANGE_BYTES - 1 });
  });

  it("reads the MP4 duration from mvhd and refuses non-MP4 or out-of-range durations (M-04)", async () => {
    const reader = (file: Buffer) => async (start: number, end: number) => file.subarray(start, end + 1);
    const v0 = syntheticMp4(125.5);
    expect(await inspectMp4(reader(v0), v0.length)).toEqual({ durationSeconds: 125.5 });
    const v1 = syntheticMp4(3600, 10, 1);
    expect(await inspectMp4(reader(v1), v1.length)).toEqual({ durationSeconds: 3600 });
    const fake = Buffer.from("%PDF-1.4 not a video at all");
    await expect(inspectMp4(reader(fake), fake.length)).rejects.toMatchObject({ code: "TRAINING_VIDEO_INVALID" });
    const short = syntheticMp4(3);
    await expect(inspectMp4(reader(short), short.length)).rejects.toBeInstanceOf(VideoInspectionError);
  });

  it("quiz standing, module completion and credit hours (M-02, M-13, M-14)", () => {
    expect(quizStanding([50, 80, 60], 70, 3)).toEqual({ best: 80, passed: true, attemptsLeft: 0 });
    expect(quizStanding([], 70, 3)).toEqual({ best: null, passed: false, attemptsLeft: 3 });
    expect(moduleComplete({ materials: 2, completedMaterials: 2, hasQuiz: true, quizPassed: false })).toBe(false);
    expect(moduleComplete({ materials: 2, completedMaterials: 2, hasQuiz: false, quizPassed: false })).toBe(true);
    expect(validCreditHours(1.25)).toBe(true);
    expect(validCreditHours(1.3)).toBe(false);
    expect(validCreditHours(0)).toBe(false);
  });
});
