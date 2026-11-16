// TRAIN-001 R3 employee surface: evaluation tasks (as participant and as supervisor assessor),
// the form in a pop-up, and my evaluation outcome per program.

import { ClipboardCheck, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { DetailDialog } from "@/components/DetailDialog";
import { DialogLoading } from "@/components/DetailDialogParts";
import { PaginationBar } from "@/components/PaginationBar";
import { EvaluationFormView } from "@/components/training/EvaluationFormView";
import { formatInstant, type Pagination } from "@/lib/training";
import {
  describeTask,
  formatScore,
  getMyEvaluationForm,
  getMyEvaluationResults,
  getMyEvaluationTasks,
  LEVEL_LABELS,
  OUTCOME_LABELS,
  submitMyEvaluation,
  type EvaluationForm,
  type Outcome,
  type Task,
} from "@/lib/trainingEvaluation";

const card = "rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]";
const secondary = "min-h-11 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50";

/** Pure list of tasks, exported for markup tests. */
export function TaskList({ tasks, onOpen }: { tasks: Task[]; onOpen: (task: Task) => void }) {
  if (tasks.length === 0) return <p className="px-5 py-6 text-sm text-muted-foreground">Tidak ada evaluasi yang perlu diisi.</p>;
  return (
    <ul className="divide-y divide-border/70 border-t border-border/70">
      {tasks.map((task) => (
        <li key={`${task.componentId}-${task.stage}-${task.subjectEmployeeId ?? "self"}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
          <span>
            <span className="block text-sm font-semibold text-brand-heading">{describeTask(task)}</span>
            <span className="block text-xs text-muted-foreground">
              {task.programTitle} · {LEVEL_LABELS[task.level]}{task.anonymous ? " · anonim" : ""}
              {task.closesAt ? ` · tutup ${formatInstant(task.closesAt)}` : ""}
            </span>
          </span>
          <button type="button" className={secondary} onClick={() => onOpen(task)}>Isi</button>
        </li>
      ))}
    </ul>
  );
}

/** Pure outcome table, exported for markup tests. */
export function OutcomeList({ items }: { items: Outcome[] }) {
  if (items.length === 0) return <p className="px-5 py-6 text-sm text-muted-foreground">Belum ada hasil evaluasi.</p>;
  return (
    <div className="overflow-x-auto border-t border-border/70">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr><th className="px-5 py-2">Program</th><th className="px-2 py-2">Pre</th><th className="px-2 py-2">Post</th><th className="px-2 py-2">Nilai akhir</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Penerapan</th></tr>
        </thead>
        <tbody className="divide-y divide-border/70">
          {items.map((item) => (
            <tr key={item.programId}>
              <td className="px-5 py-2 font-semibold text-brand-heading">{item.title}</td>
              <td className="px-2 py-2">{formatScore(item.pre)}</td>
              <td className="px-2 py-2">{formatScore(item.post)}{item.gain !== null ? ` (${item.gain >= 0 ? "+" : ""}${formatScore(item.gain)})` : ""}</td>
              <td className="px-2 py-2">{formatScore(item.finalScore)}</td>
              <td className="px-2 py-2">{OUTCOME_LABELS[item.status]}</td>
              <td className="px-2 py-2">
                {item.applicationScore !== null ? formatScore(item.applicationScore) : ""}
                {item.applicationRating !== null ? `${item.applicationScore !== null ? " · " : ""}${formatScore(item.applicationRating)}/5` : ""}
                {item.applicationScore === null && item.applicationRating === null ? "-" : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EmployeeEvaluationSection() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskPaging, setTaskPaging] = useState<Pagination | null>(null);
  const [taskPage, setTaskPage] = useState(1);
  const [results, setResults] = useState<Outcome[]>([]);
  const [resultPaging, setResultPaging] = useState<Pagination | null>(null);
  const [resultPage, setResultPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Task | null>(null);
  const [form, setForm] = useState<EvaluationForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const loadTasks = async () => {
    const result = await getMyEvaluationTasks(taskPage);
    setTasks(result.items);
    setTaskPaging(result.pagination);
  };
  const loadResults = async () => {
    const result = await getMyEvaluationResults(resultPage);
    setResults(result.items);
    setResultPaging(result.pagination);
  };

  useEffect(() => {
    setLoading(true);
    void loadTasks().catch((cause) => setError(cause instanceof Error ? cause.message : "Evaluasi tidak dapat dimuat.")).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskPage]);
  useEffect(() => {
    void loadResults().catch((cause) => setError(cause instanceof Error ? cause.message : "Hasil evaluasi tidak dapat dimuat."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultPage]);

  useEffect(() => {
    setForm(null);
    setFormError(null);
    if (!open) return;
    let active = true;
    void getMyEvaluationForm(open.componentId, open.stage, open.subjectEmployeeId)
      .then((value) => { if (active) setForm(value); })
      .catch((cause) => { if (active) setFormError(cause instanceof Error ? cause.message : "Formulir tidak dapat dibuka."); });
    return () => { active = false; };
  }, [open]);

  const close = () => {
    setOpen(null);
    void Promise.all([loadTasks(), loadResults()]).catch(() => undefined);
  };

  return (
    <>
      <section className={`${card} mt-6 overflow-hidden`} aria-labelledby="training-evaluation-tasks">
        <h2 id="training-evaluation-tasks" className="flex items-center gap-2 px-5 pt-5 text-sm font-bold text-brand-heading">
          <ClipboardCheck className="h-4 w-4" aria-hidden="true" />Evaluasi yang perlu diisi
        </h2>
        <p className="px-5 pb-3 text-xs text-muted-foreground">Kuesioner, pre/post test, dan penilaian penerapan untuk pelatihan Anda atau anggota tim Anda.</p>
        {error ? <p role="alert" className="px-5 pb-3 text-sm text-danger-ink">{error}</p> : null}
        {loading ? (
          <div className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
        ) : <TaskList tasks={tasks} onOpen={setOpen} />}
        {taskPaging && taskPaging.total > taskPaging.pageSize
          ? <PaginationBar page={taskPaging.page} pageSize={taskPaging.pageSize} total={taskPaging.total} onPageChange={setTaskPage} /> : null}
      </section>

      <section className={`${card} mt-6 overflow-hidden`} aria-labelledby="training-evaluation-results">
        <h2 id="training-evaluation-results" className="px-5 pt-5 text-sm font-bold text-brand-heading">Hasil evaluasi saya</h2>
        <p className="px-5 pb-3 text-xs text-muted-foreground">Kelulusan dihitung dari reaksi dan pembelajaran; penilaian penerapan dicatat terpisah.</p>
        <OutcomeList items={results} />
        {resultPaging && resultPaging.total > resultPaging.pageSize
          ? <PaginationBar page={resultPaging.page} pageSize={resultPaging.pageSize} total={resultPaging.total} onPageChange={setResultPage} /> : null}
      </section>

      {open ? (
        <DetailDialog title={describeTask(open)} description={open.programTitle} onClose={close}>
          {form ? (
            <EvaluationFormView form={form} onSubmit={(answers) => submitMyEvaluation(open.componentId, {
              stage: open.stage, subjectEmployeeId: open.subjectEmployeeId, answers,
            })} />
          ) : formError ? <p role="alert" className="text-sm text-danger-ink">{formError}</p> : <DialogLoading />}
        </DetailDialog>
      ) : null}
    </>
  );
}
