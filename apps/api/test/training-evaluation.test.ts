// TRAIN-001 R3 pure rules: items, component pairs, answers, scoring, outcome.
import { describe, expect, it } from "vitest";

import {
  computeOutcome,
  EvaluationPolicyError,
  normalizeItems,
  publicItems,
  resolveComponent,
  scoreRubric,
  scoreTest,
  stageOpen,
  summarizeForm,
  validateAnswers,
} from "../src/modules/training/evaluation-domain.js";

describe("TRAIN-001 R3 evaluation rules", () => {
  const test = normalizeItems("TEST", [
    { type: "SINGLE", prompt: "A", options: ["x", "y"], correct: 0, points: 3 },
    { type: "MULTI", prompt: "B", options: ["x", "y", "z"], correct: [2, 0] },
    { type: "TRUE_FALSE", prompt: "C", correct: false },
    { type: "SHORT", prompt: "D", accepted: ["  Tajwid  Dasar "] },
  ]);

  it("numbers items and normalizes keys; respondents never see keys (E-02, TRAIN-R3-A)", () => {
    expect(test.map((item) => item.id)).toEqual(["q1", "q2", "q3", "q4"]);
    expect(test[1]).toMatchObject({ correct: [0, 2], points: 1 });
    expect(test[3]).toMatchObject({ accepted: ["tajwid dasar"] });
    const visible = JSON.stringify(publicItems(test));
    expect(visible).not.toContain("correct");
    expect(visible).not.toContain("accepted");
  });

  it("refuses items of the wrong kind and malformed keys", () => {
    expect(() => normalizeItems("FORM", [{ type: "SINGLE", prompt: "x", options: ["a", "b"], correct: 0 }])).toThrow(EvaluationPolicyError);
    expect(() => normalizeItems("TEST", [{ type: "SINGLE", prompt: "x", options: ["a", "b"], correct: 2 }])).toThrow(/Kunci/);
    expect(() => normalizeItems("RUBRIC", [{ type: "CRITERION", prompt: "x", levels: ["a", "b", "c"] }])).toThrow(/4 deskriptor/);
    expect(() => normalizeItems("TEST", [{ type: "SINGLE", prompt: "x", options: ["a", "b"], correct: 0, points: 11 }])).toThrow(/Poin/);
    expect(() => normalizeItems("FORM", [])).toThrow();
  });

  it("scores tests all-or-nothing on MULTI, normalized SHORT, unanswered as zero (E-04/E-05)", () => {
    const answers = validateAnswers(test, { q1: 0, q2: [2, 0], q4: "tajwid   DASAR" });
    expect(scoreTest(test, answers)).toEqual({ earned: 5, max: 6, score: 83.33 });
    expect(scoreTest(test, validateAnswers(test, { q2: [0] })).score).toBe(0);
    expect(() => validateAnswers(test, { q9: 1 })).toThrow(/tidak dikenal/);
    expect(() => validateAnswers(test, { q2: [0, 0] })).toThrow();
  });

  it("scores rubrics linearly and requires every criterion", () => {
    const rubric = normalizeItems("RUBRIC", [
      { type: "CRITERION", prompt: "a", levels: ["1", "2", "3", "4"] },
      { type: "CRITERION", prompt: "b", levels: ["1", "2", "3", "4"] },
    ]);
    expect(scoreRubric(rubric, validateAnswers(rubric, { q1: 3, q2: 2 })).score).toBe(62.5);
    expect(() => validateAnswers(rubric, { q1: 3 })).toThrow(/wajib/);
    expect(() => validateAnswers(rubric, { q1: 5, q2: 1 })).toThrow();
  });

  it("enforces the component pairs (E-06)", () => {
    expect(resolveComponent({ kind: "REACTION", instrumentKind: "FORM" })).toEqual({ level: 1, respondent: "PARTICIPANT", anonymous: true, weight: 0 });
    expect(() => resolveComponent({ kind: "REACTION", instrumentKind: "FORM", weight: 5 })).toThrow();
    expect(() => resolveComponent({ kind: "RUBRIC", instrumentKind: "RUBRIC", level: 3, weight: 10 })).toThrow();
    expect(resolveComponent({ kind: "RUBRIC", instrumentKind: "RUBRIC", level: 3, respondent: "SUPERVISOR" }).level).toBe(3);
    expect(() => resolveComponent({ kind: "FORM", instrumentKind: "FORM", respondent: "SUPERVISOR", anonymous: true })).toThrow();
    expect(() => resolveComponent({ kind: "TEST", instrumentKind: "TEST", anonymous: true })).toThrow();
  });

  it("opens pre until the post exists and post once the last session started (E-12)", () => {
    const base = { kind: "PRE_POST_TEST" as const, programStatus: "ACTIVE", nowMs: 1_000 };
    expect(stageOpen({ ...base, stage: "PRE", lastSessionStartMs: 5_000, hasPost: false })).toBe(true);
    expect(stageOpen({ ...base, stage: "PRE", lastSessionStartMs: 5_000, hasPost: true })).toBe(false);
    expect(stageOpen({ ...base, stage: "POST", lastSessionStartMs: 5_000, hasPost: false })).toBe(false);
    expect(stageOpen({ ...base, stage: "POST", lastSessionStartMs: 500, hasPost: false })).toBe(true);
    expect(stageOpen({ ...base, programStatus: "COMPLETED", stage: "POST", lastSessionStartMs: 5_000, hasPost: false })).toBe(true);
    expect(stageOpen({ ...base, kind: "TEST", stage: "PRE", lastSessionStartMs: null, hasPost: false })).toBe(false);
  });

  it("computes the weighted outcome from levels 1–2 only (E-07/E-08)", () => {
    const components = [
      { id: "t", kind: "TEST" as const, level: 2, weight: 30, required: true },
      { id: "r", kind: "RUBRIC" as const, level: 2, weight: 70, required: true },
      { id: "x", kind: "REACTION" as const, level: 1, weight: 0, required: true },
      { id: "s", kind: "FORM" as const, level: 3, weight: 0, required: true },
    ];
    const scores = new Map([["t", 60], ["r", 100]]);
    expect(computeOutcome({ components, done: new Set(["t", "r", "x"]), scores, passingScore: 80 })).toEqual({ finalScore: 88, status: "PASSED" });
    expect(computeOutcome({ components, done: new Set(["t", "r", "x"]), scores, passingScore: 90 }).status).toBe("FAILED");
    expect(computeOutcome({ components, done: new Set(["t", "r"]), scores, passingScore: 80 }).status).toBe("INCOMPLETE");
    expect(computeOutcome({ components: [components[2]!], done: new Set(["x"]), scores, passingScore: 80 }))
      .toEqual({ finalScore: null, status: "NOT_GRADED" });
  });

  it("summarizes scale and choice items", () => {
    const form = normalizeItems("FORM", [
      { type: "SCALE", prompt: "a" },
      { type: "CHOICE", prompt: "b", options: ["ya", "tidak"], required: false },
    ]);
    const summary = summarizeForm(form, [{ q1: 5, q2: 0 }, { q1: 4 }]);
    expect(summary[0]).toMatchObject({ average: 4.5, distribution: [0, 0, 0, 1, 1] });
    expect(summary[1]).toMatchObject({ count: 1, options: [{ label: "ya", count: 1 }, { label: "tidak", count: 0 }] });
  });
});
