// TRAIN-001 R4 web: module list, storage line and player helpers, as markup. Synthetic data.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ModuleList } from "@/components/training/OnlineModules";
import { StorageLine } from "@/components/training/ProgramModulesPanel";
import { formatBytes, formatDuration, progressPercent, reachableSeconds, type MyModule } from "@/lib/trainingOnline";

const module: MyModule = {
  id: "m1", title: "Pengantar SOP", description: null, creditHours: 1.5,
  materials: [
    { id: "v1", kind: "VIDEO", title: "Video pengantar", body: null, durationSeconds: 200, creditedSeconds: 50, completed: false },
    { id: "t1", kind: "TEXT", title: "Bacaan SOP", body: "Isi", durationSeconds: null, creditedSeconds: 0, completed: true },
  ],
  quiz: { best: null, passed: false, attemptsLeft: 3, passingScore: 70, unlocked: false },
  completed: false,
};

describe("TRAIN-001 R4 online modules web", () => {
  it("lists materials with server-credited progress and a locked quiz", () => {
    const html = renderToStaticMarkup(<ModuleList modules={[module]} onOpen={() => undefined} />);
    expect(html).toContain("Video pengantar");
    expect(html).toContain("25%");
    expect(html).toContain("selesai");
    expect(html).toContain("terbuka setelah semua materi selesai");
    expect(html).not.toContain("Kerjakan kuis");
    const unlocked = renderToStaticMarkup(<ModuleList modules={[{ ...module, quiz: { ...module.quiz!, unlocked: true } }]} onOpen={() => undefined} />);
    expect(unlocked).toContain("Kerjakan kuis");
  });

  it("says when online modules are off, and shows usage when on", () => {
    expect(renderToStaticMarkup(<StorageLine info={{ enabled: false, videoMaxBytes: 1, quotaBytes: 1, usedBytes: 0 }} />)).toContain("belum diaktifkan");
    expect(renderToStaticMarkup(<StorageLine info={{ enabled: true, videoMaxBytes: 314_572_800, quotaBytes: 5_368_709_120, usedBytes: 1_048_576 }} />))
      .toContain("1 MB dari 5 GB");
  });

  it("formats durations, sizes and progress; the player never lets you past the credit", () => {
    expect(formatDuration(125)).toBe("2:05");
    expect(formatBytes(314_572_800)).toBe("300 MB");
    expect(progressPercent(190, 200)).toBe(95);
    expect(reachableSeconds(40)).toBe(42);
  });
});
