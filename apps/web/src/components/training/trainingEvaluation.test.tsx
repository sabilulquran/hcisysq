// TRAIN-001 R3 web: evaluation forms, tasks, outcomes and builder helpers, as markup. Synthetic data.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OutcomeList, TaskList } from "@/components/training/EmployeeEvaluationSection";
import { EvaluationFormView } from "@/components/training/EvaluationFormView";
import { blankItem, cleanItems, describeTask, missingRequired, summaryLine, type EvaluationForm, type Task } from "@/lib/trainingEvaluation";

const form: EvaluationForm = {
  component: { id: "c1", title: "Kuesioner reaksi", kind: "REACTION", level: 1, instrumentKind: "FORM", anonymous: true, respondent: "PARTICIPANT", closesAt: null },
  program: { id: "p1", title: "Tahsin Guru" },
  stage: "SINGLE",
  subject: null,
  items: [
    { id: "q1", type: "SCALE", prompt: "Materi relevan dengan pekerjaan saya.", required: true },
    { id: "q2", type: "SINGLE", prompt: "Hukum nun mati bertemu ba?", options: ["Izhar", "Iqlab"], points: 2 },
    { id: "q3", type: "TEXT", prompt: "Komentar", required: false },
  ],
};

const task = (overrides: Partial<Task> = {}): Task => ({
  componentId: "c1", title: "Tes tajwid", kind: "PRE_POST_TEST", level: 2, anonymous: false, stage: "PRE",
  programId: "p1", programTitle: "Tahsin Guru", subjectEmployeeId: null, subjectName: null, as: "PARTICIPANT", closesAt: null,
  ...overrides,
});

describe("TRAIN-001 R3 evaluation web", () => {
  it("renders a form with every item, the anonymity notice and optional marks", () => {
    const html = renderToStaticMarkup(<EvaluationFormView form={form} onSubmit={async () => ({ anonymous: true, score: null })} />);
    expect(html).toContain("Formulir ini anonim");
    expect(html).toContain("Sangat setuju");
    expect(html).toContain("Iqlab");
    expect(html).toContain("(2 poin)");
    expect(html).toContain("(opsional)");
    expect(html).toContain("Kirim jawaban");
  });

  it("names tasks by stage and by the person assessed", () => {
    expect(describeTask(task())).toBe("Pre-test · Tes tajwid");
    expect(describeTask(task({ stage: "SINGLE", as: "SUPERVISOR", subjectName: "Aisyah", title: "Penilaian penerapan" })))
      .toBe("Penilaian penerapan — menilai Aisyah");
    const html = renderToStaticMarkup(<TaskList tasks={[task()]} onOpen={() => undefined} />);
    expect(html).toContain("Tingkat 2 · Pembelajaran");
    expect(renderToStaticMarkup(<TaskList tasks={[]} onOpen={() => undefined} />)).toContain("Tidak ada evaluasi");
  });

  it("shows outcomes with the gain and the pass status", () => {
    const html = renderToStaticMarkup(<OutcomeList items={[{
      programId: "p1", title: "Tahsin Guru", status: "PASSED", pre: 60, post: 100, gain: 40, scores: {}, finalScore: 88,
      applicationScore: null, applicationRating: 4.5,
    }]} />);
    expect(html).toContain("(+40)");
    expect(html).toContain("Lulus");
    expect(html).toContain("4,5/5");
  });

  it("flags unanswered required items and keeps optional ones optional", () => {
    expect(missingRequired(form.items, {}).map((item) => item.id)).toEqual(["q1"]);
    expect(missingRequired(form.items, { q1: 4 })).toEqual([]);
  });

  it("cleans builder lines and summarizes components", () => {
    const item = { ...blankItem("CHOICE"), prompt: "  Pilih ", options: ["Ya", "", " Tidak "] };
    expect(cleanItems([item])[0]).toMatchObject({ prompt: "Pilih", options: ["Ya", "Tidak"] });
    expect(summaryLine({
      id: "c1", kind: "PRE_POST_TEST", level: 2, respondent: "PARTICIPANT", title: "x", anonymous: false, weight: 100,
      expected: 3, submitted: 2, submittedPre: 3, averagePre: 55, averagePost: 80, averageGain: 20, pairs: 2,
    })).toContain("peningkatan 20");
    expect(summaryLine({
      id: "c2", kind: "REACTION", level: 1, respondent: "PARTICIPANT", title: "x", anonymous: true, weight: 0, expected: 3, submitted: 3,
      averageScore: null, items: [{ id: "q1", type: "SCALE", prompt: "a", count: 3, average: 4 }],
    })).toBe("Terisi 3/3 · skala rata-rata 4/5");
  });
});
