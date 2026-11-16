// TRAIN-001 R4 employee surface inside a program pop-up: modules, a video player that cannot be
// skipped or sped up, readings, and module quizzes. The player's rules are comfort only: progress
// counts when the server credits it from heartbeats (spec M-10).

import { useEffect, useRef, useState } from "react";

import { EvaluationFormView } from "@/components/training/EvaluationFormView";
import {
  confirmReading,
  formatDuration,
  getMyModules,
  getQuiz,
  heartbeat,
  progressPercent,
  reachableSeconds,
  startPlayback,
  submitQuiz,
  type MyMaterial,
  type MyModule,
} from "@/lib/trainingOnline";

const secondary = "min-h-11 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50";
const HEARTBEAT_MS = 10_000;

export function VideoPlayer({ material, onProgress }: { material: MyMaterial; onProgress: (completed: boolean, programCompleted: boolean) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [session, setSession] = useState<{ playbackId: string; streamUrl: string } | null>(null);
  const [credited, setCredited] = useState(material.creditedSeconds);
  const creditedRef = useRef(material.creditedSeconds);
  const progressRef = useRef(onProgress);
  progressRef.current = onProgress;
  const doneRef = useRef(material.completed);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void startPlayback(material.id).then((result) => {
      if (!active) return;
      creditedRef.current = result.creditedSeconds;
      setCredited(result.creditedSeconds);
      setSession({ playbackId: result.playbackId, streamUrl: result.streamUrl });
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Video tidak dapat dibuka."));
    return () => { active = false; };
  }, [material.id]);

  useEffect(() => {
    if (!session) return;
    const element = video.current;
    const report = async () => {
      if (!element || element.paused) return;
      try {
        const result = await heartbeat(session.playbackId, element.currentTime);
        creditedRef.current = result.creditedSeconds;
        setCredited(result.creditedSeconds);
        if (result.completed && !doneRef.current) {
          doneRef.current = true;
          progressRef.current(true, result.programCompleted);
        }
      } catch (cause) {
        element.pause();
        setError(cause instanceof Error ? cause.message : "Sesi tonton berakhir.");
      }
    };
    const timer = window.setInterval(() => void report(), HEARTBEAT_MS);
    // Discovery §12 no. 5: the video pauses while the tab is hidden.
    const hidden = () => { if (document.hidden) element?.pause(); };
    document.addEventListener("visibilitychange", hidden);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", hidden); };
  }, [session]);

  return (
    <div>
      {error ? <p role="alert" className="mb-2 text-sm text-danger-ink">{error}</p> : null}
      {session ? (
        <video
          ref={video}
          src={session.streamUrl}
          controls
          playsInline
          preload="metadata"
          controlsList="nodownload noplaybackrate noremoteplayback"
          disablePictureInPicture
          onContextMenu={(event) => event.preventDefault()}
          onLoadedMetadata={(event) => { event.currentTarget.currentTime = Math.max(0, creditedRef.current - 1); }}
          // M-08: no skipping past what was watched, no speed change.
          onSeeking={(event) => {
            const limit = reachableSeconds(creditedRef.current);
            if (event.currentTarget.currentTime > limit) event.currentTarget.currentTime = creditedRef.current;
          }}
          onRateChange={(event) => { if (event.currentTarget.playbackRate !== 1) event.currentTarget.playbackRate = 1; }}
          className="aspect-video w-full rounded-2xl bg-black"
        />
      ) : <p className="text-sm text-muted-foreground">Menyiapkan video...</p>}
      <p className="mt-1 text-xs text-muted-foreground">
        Tercatat {progressPercent(credited, material.durationSeconds)}% dari {formatDuration(material.durationSeconds)}.
        Video tidak dapat dipercepat atau dilewati; selesai setelah 95% ditonton.
      </p>
    </div>
  );
}

function Quiz({ module, onDone }: { module: MyModule; onDone: (programCompleted: boolean) => void }) {
  const [quiz, setQuiz] = useState<Awaited<ReturnType<typeof getQuiz>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void getQuiz(module.id).then(setQuiz).catch((cause) => setError(cause instanceof Error ? cause.message : "Kuis tidak dapat dibuka."));
  }, [module.id]);
  if (error) return <p role="alert" className="text-sm text-danger-ink">{error}</p>;
  if (!quiz) return <p className="text-sm text-muted-foreground">Memuat kuis...</p>;
  return (
    <EvaluationFormView
      form={{
        component: { id: module.id, title: quiz.title, kind: "TEST", level: 2, instrumentKind: "TEST", anonymous: false, respondent: "PARTICIPANT", closesAt: null },
        program: { id: "", title: "" }, stage: "SINGLE", subject: null, items: quiz.items,
      }}
      onSubmit={async (answers) => {
        const result = await submitQuiz(module.id, answers);
        onDone(result.programCompleted);
        return { anonymous: false, score: result.score };
      }}
    />
  );
}

/** Module list with per-material state; exported for markup tests. */
export function ModuleList({ modules, onOpen }: { modules: MyModule[]; onOpen: (module: MyModule, material: MyMaterial | "quiz") => void }) {
  if (modules.length === 0) return <p className="text-sm text-muted-foreground">Belum ada modul yang terbit.</p>;
  return (
    <ol className="space-y-3">
      {modules.map((module, index) => (
        <li key={module.id} className="rounded-2xl border border-border/70 p-3 text-sm">
          <p className="font-semibold text-brand-heading">{index + 1}. {module.title}{module.completed ? " · selesai" : ""}</p>
          <p className="text-xs text-muted-foreground">{module.creditHours} jam kredit</p>
          <ul className="mt-2 space-y-1">
            {module.materials.map((material) => (
              <li key={material.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">
                  {material.kind === "VIDEO" ? "Video" : "Bacaan"}: {material.title}
                  <span className="ml-1 text-xs text-muted-foreground">
                    {material.completed ? "selesai" : material.kind === "VIDEO" ? `${progressPercent(material.creditedSeconds, material.durationSeconds)}%` : "belum dibaca"}
                  </span>
                </span>
                <button type="button" className={secondary} onClick={() => onOpen(module, material)}>{material.kind === "VIDEO" ? "Tonton" : "Baca"}</button>
              </li>
            ))}
          </ul>
          {module.quiz ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                Kuis: {module.quiz.passed ? `lulus (nilai ${module.quiz.best})` : module.quiz.unlocked
                  ? `minimal ${module.quiz.passingScore}, sisa ${module.quiz.attemptsLeft} percobaan` : "terbuka setelah semua materi selesai"}
              </span>
              {module.quiz.unlocked && !module.quiz.passed && module.quiz.attemptsLeft > 0
                ? <button type="button" className={secondary} onClick={() => onOpen(module, "quiz")}>Kerjakan kuis</button> : null}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function OnlineModules({ programId, onProgramCompleted }: { programId: string; onProgramCompleted: () => void }) {
  const [modules, setModules] = useState<MyModule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ module: MyModule; material: MyMaterial | "quiz" } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => setModules((await getMyModules(programId)).items);
  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Modul tidak dapat dimuat."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programId]);

  const progressed = (_completed: boolean, programCompleted: boolean) => {
    if (programCompleted) {
      setNotice("Selamat, Anda menyelesaikan program ini. Catatan pelatihan dan jamnya sudah tersimpan.");
      onProgramCompleted();
    }
    void load().catch(() => undefined);
  };

  if (error) return <p role="alert" className="text-sm text-danger-ink">{error}</p>;
  if (!modules) return <p className="text-sm text-muted-foreground">Memuat modul...</p>;
  return (
    <div className="space-y-3">
      {notice ? <p role="status" className="rounded-2xl border border-border bg-surface p-3 text-sm text-brand-heading">{notice}</p> : null}
      {open ? (
        <div className="rounded-2xl border border-border p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-bold text-brand-heading">{open.material === "quiz" ? `Kuis · ${open.module.title}` : open.material.title}</p>
            <button type="button" className={secondary} onClick={() => { setOpen(null); void load(); }}>Kembali</button>
          </div>
          {open.material === "quiz" ? <Quiz module={open.module} onDone={(done) => progressed(true, done)} />
            : open.material.kind === "VIDEO" ? <VideoPlayer key={open.material.id} material={open.material} onProgress={progressed} /> : (
              <div>
                <p className="whitespace-pre-wrap text-sm text-brand-heading">{open.material.body}</p>
                {open.material.completed ? null : (
                  <button type="button" className={`${secondary} mt-3`} onClick={() => {
                    const material = open.material as MyMaterial;
                    void confirmReading(material.id).then((result) => { progressed(true, result.programCompleted); setOpen(null); })
                      .catch((cause) => setError(cause instanceof Error ? cause.message : "Tidak dapat disimpan."));
                  }}>Saya sudah membaca</button>
                )}
              </div>
            )}
        </div>
      ) : <ModuleList modules={modules} onOpen={(module, material) => setOpen({ module, material })} />}
    </div>
  );
}
