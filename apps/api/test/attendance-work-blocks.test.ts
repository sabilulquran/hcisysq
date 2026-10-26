import { describe, expect, it } from "vitest";

import { normalActual } from "../src/modules/attendance/calculation-rows.js";
import { blockIndexFor, evaluateBlocks, type ResolvedSchedule } from "../src/modules/attendance/engine.js";
import { scheduleBlocksError } from "../src/modules/attendance/workforce-routes.js";

// ATT-013 work blocks (docs/domain/attendance-work-blocks.md). Synthetic times, Asia/Jakarta.

const at = (time: string) => new Date(`2026-10-20T${time}:00+07:00`);
const blocks = [
  { sequence: 1, startAt: at("04:00"), endAt: at("08:30") },
  { sequence: 2, startAt: at("14:30"), endAt: at("19:30") },
];
const schedule: ResolvedSchedule = {
  state: "scheduled", scheduleTemplateId: "t", scheduleVersionId: "v", rosterId: null,
  scheduledStartAt: blocks[0]!.startAt, scheduledEndAt: blocks[1]!.endAt,
  lateGraceMinutes: 1, earlyLeaveToleranceMinutes: 0, workLocation: null, blocks,
};
let id = 0;
const punch = (time: string) => ({ id: `e${++id}`, eventKind: "punch" as const, occurredAt: at(time) });
const evaluate = (events: ReturnType<typeof punch>[], now = at("23:00")) => evaluateBlocks({
  schedule, events, corrections: [], lateJustified: false, earlyLeaveJustified: false, outsideGeofenceJustified: false,
  overtimeMinutes: 0, now,
});

describe("ATT-013 B-4: which block a scan belongs to", () => {
  it("splits the gap at its midpoint (11:30)", () => {
    expect(blockIndexFor(blocks, at("11:29"))).toBe(0);
    expect(blockIndexFor(blocks, at("11:30"))).toBe(1);
    expect(blockIndexFor(blocks, at("03:00"))).toBe(0);
    expect(blockIndexFor(blocks, at("21:00"))).toBe(1);
  });
});

describe("ATT-013 B-5/B-7: the day from its blocks", () => {
  it("is Hadir when every block is attended, with work summed and no break for the gap", () => {
    const { computation, blocks: parts } = evaluate([punch("03:58"), punch("08:31"), punch("14:29"), punch("19:31")]);
    expect(computation.status).toBe("present");
    expect(parts.map((part) => part.status)).toEqual(["present", "present"]);
    expect(computation.workedMinutes).toBe(273 + 302);
    expect(computation.breakMinutes).toBe(0);
    expect(computation.firstCheckInAt).toEqual(at("03:58"));
    expect(computation.lastCheckOutAt).toEqual(at("19:31"));
  });

  it("is Tidak lengkap when one block was skipped, not Hadir with early leave", () => {
    const { computation, blocks: parts } = evaluate([punch("03:58"), punch("08:31")]);
    expect(parts.map((part) => part.status)).toEqual(["present", "absent"]);
    expect(computation.status).toBe("incomplete");
    expect(computation.earlyLeaveMinutes).toBe(0);
  });

  it("is Terlambat when a block starts late, summing the late minutes of each block", () => {
    const { computation } = evaluate([punch("04:05"), punch("08:31"), punch("14:40"), punch("19:31")]);
    expect(computation.status).toBe("late");
    expect(computation.lateMinutes).toBe(4 + 9);
  });

  it("is Tidak hadir when no block was attended, and waits for a later block during the day", () => {
    expect(evaluate([]).computation.status).toBe("absent");
    expect(evaluate([punch("03:58"), punch("08:31")], at("12:00")).computation.status).toBe("present");
  });
});

describe("ATT-013 §3: block validation", () => {
  const first = { startTime: "04:00", endTime: "08:30", endDayOffset: 0 };
  it("accepts ordered blocks and refuses overlap, reversed times and midnight", () => {
    expect(scheduleBlocksError(first, [{ startTime: "14:30", endTime: "19:30" }])).toBeNull();
    expect(scheduleBlocksError(first, [{ startTime: "08:00", endTime: "10:00" }])).toMatch(/berurutan/);
    expect(scheduleBlocksError(first, [{ startTime: "15:00", endTime: "14:00" }])).toMatch(/selesai setelah mulai/);
    expect(scheduleBlocksError({ startTime: "22:00", endTime: "06:00", endDayOffset: 1 }, [{ startTime: "07:00", endTime: "08:00" }])).toMatch(/tengah malam/);
    expect(scheduleBlocksError(first, [])).toBeNull();
  });
});

describe("ATT-013 B-6: Normal/Riil", () => {
  it("counts the share of blocks attended on a multi-block day", () => {
    expect(normalActual("incomplete", { count: 2, attended: 1 })).toEqual({ normal: 1, actual: 0.5 });
    expect(normalActual("present", { count: 3, attended: 3 })).toEqual({ normal: 1, actual: 1 });
    expect(normalActual("absent", { count: 2, attended: 0 })).toEqual({ normal: 1, actual: 0 });
    expect(normalActual("incomplete", { count: 0, attended: 0 })).toEqual({ normal: 1, actual: null });
    expect(normalActual("leave", { count: 2, attended: 0 })).toEqual({ normal: 1, actual: null });
  });
});
