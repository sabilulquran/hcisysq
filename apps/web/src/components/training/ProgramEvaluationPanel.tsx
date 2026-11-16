// TRAIN-001 R3 HC surface inside a program pop-up: passing score, evaluation components, supervisor
// assessors, HC answers (rubric, result indicators), per-component summary and per-participant
// outcome. The API owns every rule; this only shows and sends.

import { useEffect, useState } from "react";

import { EmployeeSearchField, type PickedEmployee } from "@/components/attendance/workforce/EmployeeSearchField";
import { DetailDialog } from "@/components/DetailDialog";
import { DialogLoading } from "@/components/DetailDialogParts";
import { PaginationBar } from "@/components/PaginationBar";
import { EvaluationFormView } from "@/components/training/EvaluationFormView";
import { formatInstant, searchTrainingEmployees, wibInstant, type Pagination } from "@/lib/training";
import {
  archiveComponent,
  assignAssessor,
  COMPONENT_KIND_LABELS,
  createComponent,
  formatScore,
  getAssessors,
  getComments,
  getComponents,
  getEmployeeEvaluation,
  getEvaluationResults,
  getEvaluationSummary,
  getHcEvaluationForm,
  getInstruments,
  INSTRUMENT_FOR_COMPONENT,
  LEVEL_LABELS,
  OUTCOME_LABELS,
  RESPONDENT_LABELS,
  setPassingScore,
  summaryLine,
  validPassingScore,
  submitHcEvaluation,
  type AssessorRow,
  type Component,
  type ComponentKind,
  type ComponentSummary,
  type EvaluationForm,
  type InstrumentSummary,
  type Outcome,
  type Respondent,
} from "@/lib/trainingEvaluation";

const input = "mt-1 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading";
const label = "text-xs font-semibold text-muted-foreground";
const primary = "inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50";
const secondary = "min-h-11 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50";
const danger = "min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50";

const emptyComponent = () => ({
  kind: "REACTION" as ComponentKind, instrumentId: "", title: "", level: "2", respondent: "HC" as Respondent, anonymous: false,
  weight: "0", required: true, opensDay: "", opensTime: "08:00", closesDay: "", closesTime: "17:00",
});

function weighted(kind: ComponentKind, level: string) {
  return kind === "TEST" || kind === "PRE_POST_TEST" || (kind === "RUBRIC" && level === "2");
}

export function ProgramEvaluationPanel({ programId, programStatus, canManage }: { programId: string; programStatus: string; canManage: boolean }) {
  const editable = canManage && programStatus !== "CANCELLED";
  const [components, setComponents] = useState<Component[]>([]);
  const [summary, setSummary] = useState<ComponentSummary[]>([]);
  const [passing, setPassing] = useState("75");
  const [results, setResults] = useState<Outcome[]>([]);
  const [resultPaging, setResultPaging] = useState<Pagination | null>(null);
  const [resultPage, setResultPage] = useState(1);
  const [form, setForm] = useState(emptyComponent);
  const [instrumentQuery, setInstrumentQuery] = useState("");
  const [instrumentOptions, setInstrumentOptions] = useState<InstrumentSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [people, setPeople] = useState<Component | null>(null);
  const [comments, setComments] = useState<Component | null>(null);
  const [answering, setAnswering] = useState<{ component: Component; subjectEmployeeId: string | null } | null>(null);
  const [employee, setEmployee] = useState<string | null>(null);

  const load = async () => {
    const [plan, totals] = await Promise.all([getComponents(programId), getEvaluationSummary(programId)]);
    setComponents(plan.items);
    setPassing(String(plan.passingScore));
    setSummary(totals.components);
  };
  const loadResults = async () => {
    const result = await getEvaluationResults(programId, resultPage);
    setResults(result.items);
    setResultPaging(result.pagination);
  };

  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Evaluasi tidak dapat dimuat."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programId]);
  useEffect(() => {
    void loadResults().catch((cause) => setError(cause instanceof Error ? cause.message : "Hasil tidak dapat dimuat."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programId, resultPage]);

  // ENG-LIST-001 typeahead: instruments of the kind this component needs, searched by title.
  useEffect(() => {
    if (!editable) return;
    const timer = window.setTimeout(() => {
      void getInstruments({ kind: INSTRUMENT_FOR_COMPONENT[form.kind], status: "ACTIVE", q: instrumentQuery.trim() || undefined })
        .then((result) => setInstrumentOptions(result.items))
        .catch(() => setInstrumentOptions([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [editable, form.kind, instrumentQuery]);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      await Promise.all([load(), loadResults()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tindakan tidak dapat diproses.");
    } finally {
      setBusy(false);
    }
  };

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const kind = form.kind;
      await createComponent(programId, {
        kind, instrumentId: form.instrumentId, title: form.title.trim() || undefined,
        level: kind === "RUBRIC" || kind === "FORM" ? Number(form.level) : null,
        respondent: kind === "RUBRIC" || kind === "FORM" ? form.respondent : null,
        anonymous: kind === "FORM" && form.respondent === "PARTICIPANT" ? form.anonymous : null,
        weight: weighted(kind, form.level) ? Number(form.weight) : null,
        required: form.required,
        opensAt: form.opensDay ? wibInstant(form.opensDay, form.opensTime) : null,
        closesAt: form.closesDay ? wibInstant(form.closesDay, form.closesTime) : null,
      });
      setForm(emptyComponent());
      return "Komponen evaluasi ditambahkan.";
    });
  };

  const archive = (component: Component) => {
    const reason = window.prompt(`Alasan mengarsipkan "${component.title}" (minimal 5 karakter)`);
    if (!reason || reason.trim().length < 5) return;
    void run(async () => { await archiveComponent(component.id, reason.trim()); return "Komponen diarsipkan."; });
  };

  const levelChoices = form.kind === "RUBRIC" ? ["2", "3"] : ["1", "2", "3"];
  const respondentChoices: Respondent[] = form.kind === "RUBRIC" ? ["HC", "SUPERVISOR"] : ["PARTICIPANT", "SUPERVISOR"];
  const active = components.filter((component) => component.status === "ACTIVE");

  return (
    <div className="mt-6 border-t border-border/70 pt-4">
      <h3 className="text-sm font-bold text-brand-heading">Evaluasi</h3>
      <p className="text-xs text-muted-foreground">Empat tingkat: reaksi, pembelajaran, penerapan, hasil. Kelulusan dihitung dari tingkat 1–2.</p>
      {error ? <div role="alert" className="mt-2 rounded-2xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">{error}</div> : null}
      {notice ? <div role="status" className="mt-2 rounded-2xl border border-border bg-surface p-3 text-sm text-brand-heading">{notice}</div> : null}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className={label}>
          Nilai minimal lulus
          <input type="number" min={0} max={100} disabled={!editable} className={`${input} w-28`} value={passing} onChange={(event) => setPassing(event.target.value)} />
        </label>
        {editable ? (
          <button type="button" className={secondary} disabled={busy || !validPassingScore(passing)}
            onClick={() => void run(async () => { await setPassingScore(programId, Number(passing)); return "Nilai minimal lulus disimpan."; })}>
            Simpan
          </button>
        ) : null}
      </div>

      {components.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">Belum ada komponen evaluasi.</p> : (
        <ol className="mt-3 space-y-2">
          {components.map((component) => (
            <li key={component.id} className="rounded-2xl border border-border/70 p-3 text-sm">
              <p className={`font-semibold ${component.status === "ARCHIVED" ? "text-muted-foreground line-through" : "text-brand-heading"}`}>{component.title}</p>
              <p className="text-xs text-muted-foreground">
                {LEVEL_LABELS[component.level]} · {COMPONENT_KIND_LABELS[component.kind]} · diisi {RESPONDENT_LABELS[component.respondent]}
                {component.weight > 0 ? ` · bobot ${component.weight}` : ""}{component.required ? " · wajib" : ""}
                {component.opensAt ? ` · buka ${formatInstant(component.opensAt)}` : ""}{component.closesAt ? ` · tutup ${formatInstant(component.closesAt)}` : ""}
              </p>
              {component.status === "ACTIVE" ? (
                <>
                  <p className="mt-1 text-xs font-semibold text-brand-heading">{summaryLine(summary.find((item) => item.id === component.id))}</p>
                  {component.unassignedCount > 0 ? <p className="mt-1 text-xs text-warning-ink">{component.unassignedCount} peserta belum punya penilai.</p> : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {component.respondent === "SUPERVISOR" || (component.respondent === "HC" && component.kind === "RUBRIC") ? (
                      <button type="button" className={secondary} onClick={() => setPeople(component)}>
                        {component.respondent === "SUPERVISOR" ? "Penilai" : "Nilai peserta"}
                      </button>
                    ) : null}
                    {component.kind === "RESULT" && editable ? (
                      <button type="button" className={secondary} onClick={() => setAnswering({ component, subjectEmployeeId: null })}>Isi indikator</button>
                    ) : null}
                    {component.items.some((item) => item.type === "TEXT") ? (
                      <button type="button" className={secondary} onClick={() => setComments(component)}>Komentar</button>
                    ) : null}
                    {editable ? <button type="button" className={danger} disabled={busy} onClick={() => archive(component)}>Arsipkan</button> : null}
                  </div>
                </>
              ) : <p className="mt-1 text-[11px] text-muted-foreground">Diarsipkan: {component.archiveReason}</p>}
            </li>
          ))}
        </ol>
      )}

      {editable && active.length < 20 ? (
        <form onSubmit={add} className="mt-3 grid gap-3 rounded-2xl border border-border/70 p-3 sm:grid-cols-3">
          <label className={label}>
            Jenis komponen
            <select className={input} value={form.kind}
              onChange={(event) => setForm({ ...emptyComponent(), kind: event.target.value as ComponentKind, respondent: event.target.value === "RUBRIC" ? "HC" : "PARTICIPANT", level: event.target.value === "FORM" ? "1" : "2" })}>
              {Object.entries(COMPONENT_KIND_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </label>
          <label className={label}>
            Cari instrumen
            <input className={input} maxLength={100} value={instrumentQuery} onChange={(event) => setInstrumentQuery(event.target.value)} />
          </label>
          <label className={label}>
            Instrumen
            <select required className={input} value={form.instrumentId} onChange={(event) => setForm({ ...form, instrumentId: event.target.value })}>
              <option value="">Pilih...</option>
              {instrumentOptions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </label>
          <label className={`${label} sm:col-span-2`}>
            Judul (kosong = judul instrumen)
            <input maxLength={200} className={input} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          </label>
          {form.kind === "RUBRIC" || form.kind === "FORM" ? (
            <>
              <label className={label}>
                Tingkat
                <select className={input} value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value })}>
                  {levelChoices.map((value) => <option key={value} value={value}>{LEVEL_LABELS[Number(value)]}</option>)}
                </select>
              </label>
              <label className={label}>
                Diisi oleh
                <select className={input} value={form.respondent} onChange={(event) => setForm({ ...form, respondent: event.target.value as Respondent })}>
                  {respondentChoices.map((value) => <option key={value} value={value}>{RESPONDENT_LABELS[value]}</option>)}
                </select>
              </label>
            </>
          ) : null}
          {form.kind === "FORM" && form.respondent === "PARTICIPANT" ? (
            <label className={`${label} flex items-center gap-2 pt-5`}>
              <input type="checkbox" checked={form.anonymous} onChange={(event) => setForm({ ...form, anonymous: event.target.checked })} />Anonim
            </label>
          ) : null}
          {weighted(form.kind, form.level) ? (
            <label className={label}>
              Bobot nilai akhir (0 = tidak dihitung)
              <input type="number" min={0} max={100} className={input} value={form.weight} onChange={(event) => setForm({ ...form, weight: event.target.value })} />
            </label>
          ) : null}
          <label className={`${label} flex items-center gap-2 pt-5`}>
            <input type="checkbox" checked={form.required} onChange={(event) => setForm({ ...form, required: event.target.checked })} />Wajib
          </label>
          <label className={label}>
            Dibuka (opsional)
            <input type="date" className={input} value={form.opensDay} onChange={(event) => setForm({ ...form, opensDay: event.target.value })} />
          </label>
          <label className={label}>
            Ditutup (opsional)
            <input type="date" className={input} value={form.closesDay} onChange={(event) => setForm({ ...form, closesDay: event.target.value })} />
          </label>
          <div className="sm:col-span-3">
            <button type="submit" className={primary} disabled={busy || !form.instrumentId}>Tambah komponen</button>
          </div>
        </form>
      ) : null}

      <h4 className="mt-5 text-sm font-bold text-brand-heading">Hasil per peserta</h4>
      {results.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Belum ada peserta.</p> : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr><th className="py-2 pr-2">Peserta</th><th className="px-2">Pre</th><th className="px-2">Post</th><th className="px-2">Nilai akhir</th><th className="px-2">Status</th><th className="px-2">Penerapan</th></tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {results.map((row) => (
                <tr key={row.employeeId}>
                  <td className="py-2 pr-2">
                    <button type="button" className="text-left font-semibold text-brand-heading underline-offset-2 hover:underline" onClick={() => setEmployee(row.employeeId ?? null)}>
                      {row.fullName}
                    </button>
                  </td>
                  <td className="px-2">{formatScore(row.pre)}</td>
                  <td className="px-2">{formatScore(row.post)}{row.gain !== null ? ` (${row.gain >= 0 ? "+" : ""}${formatScore(row.gain)})` : ""}</td>
                  <td className="px-2">{formatScore(row.finalScore)}</td>
                  <td className="px-2">{OUTCOME_LABELS[row.status]}</td>
                  <td className="px-2">{row.applicationRating !== null ? `${formatScore(row.applicationRating)}/5` : formatScore(row.applicationScore)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {resultPaging && resultPaging.total > resultPaging.pageSize
        ? <PaginationBar page={resultPaging.page} pageSize={resultPaging.pageSize} total={resultPaging.total} onPageChange={setResultPage} /> : null}

      {people ? (
        <PeopleDialog component={people} editable={editable} onClose={() => { setPeople(null); void load(); }}
          onAnswer={(subjectEmployeeId) => setAnswering({ component: people, subjectEmployeeId })} />
      ) : null}
      {comments ? <CommentsDialog component={comments} onClose={() => setComments(null)} /> : null}
      {answering ? (
        <HcAnswerDialog component={answering.component} subjectEmployeeId={answering.subjectEmployeeId}
          onClose={() => { setAnswering(null); void Promise.all([load(), loadResults()]).catch(() => undefined); }} />
      ) : null}
      {employee ? <EmployeeRecapDialog employeeId={employee} onClose={() => setEmployee(null)} /> : null}
    </div>
  );
}

function PeopleDialog({ component, editable, onClose, onAnswer }: {
  component: Component;
  editable: boolean;
  onClose: () => void;
  onAnswer: (subjectEmployeeId: string) => void;
}) {
  const [rows, setRows] = useState<AssessorRow[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const supervisor = component.respondent === "SUPERVISOR";

  const load = async () => {
    const result = await getAssessors(component.id, page);
    setRows(result.items);
    setPaging(result.pagination);
    setLoaded(true);
  };
  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Peserta tidak dapat dimuat."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [component.id, page]);

  const reassign = async (row: AssessorRow, person: PickedEmployee | null) => {
    if (!person) return;
    setError(null);
    try {
      await assignAssessor(component.id, row.subjectEmployeeId, person.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Penilai tidak dapat disimpan.");
    }
  };

  return (
    <DetailDialog wide title={component.title} description={supervisor ? "Penilai atasan per peserta" : "Penilaian HC per peserta"} onClose={onClose}>
      {error ? <div role="alert" className="mb-3 rounded-2xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">{error}</div> : null}
      {!loaded ? <DialogLoading /> : rows.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada peserta.</p> : (
        <ul className="divide-y divide-border/70">
          {rows.map((row) => (
            <li key={row.subjectEmployeeId} className="grid gap-2 py-3 text-sm sm:grid-cols-2">
              <span>
                <span className="block font-semibold text-brand-heading">{row.subjectName}</span>
                <span className="block text-xs text-muted-foreground">
                  {row.subjectNumber}{row.answered ? " · sudah dinilai" : " · belum dinilai"}
                  {supervisor ? ` · penilai: ${row.assessorName ?? "belum ada"}` : ""}
                </span>
              </span>
              {supervisor ? (
                editable && !row.answered ? (
                  <EmployeeSearchField label="Ganti penilai" value={null} search={searchTrainingEmployees} onChange={(person) => void reassign(row, person)} />
                ) : null
              ) : editable && !row.answered ? (
                <div><button type="button" className={secondary} onClick={() => onAnswer(row.subjectEmployeeId)}>Isi rubrik</button></div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {paging && paging.total > paging.pageSize ? <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={setPage} /> : null}
    </DetailDialog>
  );
}

function CommentsDialog({ component, onClose }: { component: Component; onClose: () => void }) {
  const [state, setState] = useState<Awaited<ReturnType<typeof getComments>> | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void getComments(component.id, page).then(setState).catch((cause) => setError(cause instanceof Error ? cause.message : "Komentar tidak dapat dimuat."));
  }, [component.id, page]);
  return (
    <DetailDialog title={`Komentar · ${component.title}`} onClose={onClose}>
      {error ? <p role="alert" className="text-sm text-danger-ink">{error}</p> : !state ? <DialogLoading /> : state.hidden ? (
        <p className="text-sm text-muted-foreground">Komentar anonim tampil setelah komponen ditutup dan minimal {state.threshold} peserta mengisi, supaya pengisinya tidak dapat dikenali.</p>
      ) : state.items.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada komentar.</p> : (
        <ul className="space-y-2">
          {state.items.map((item, index) => (
            <li key={index} className="rounded-2xl border border-border/70 p-3 text-sm">
              <p className="whitespace-pre-wrap text-brand-heading">{item.text}</p>
              {item.subjectName ? <p className="mt-1 text-xs text-muted-foreground">{item.subjectName}</p> : null}
            </li>
          ))}
        </ul>
      )}
      {state && state.pagination.total > state.pagination.pageSize
        ? <PaginationBar page={state.pagination.page} pageSize={state.pagination.pageSize} total={state.pagination.total} onPageChange={setPage} /> : null}
    </DetailDialog>
  );
}

function HcAnswerDialog({ component, subjectEmployeeId, onClose }: { component: Component; subjectEmployeeId: string | null; onClose: () => void }) {
  const [form, setForm] = useState<EvaluationForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void getHcEvaluationForm(component.id, "SINGLE", subjectEmployeeId).then(setForm)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Formulir tidak dapat dibuka."));
  }, [component.id, subjectEmployeeId]);
  return (
    <DetailDialog wide title={component.title} onClose={onClose}>
      {error ? <p role="alert" className="text-sm text-danger-ink">{error}</p> : !form ? <DialogLoading /> : (
        <EvaluationFormView form={form} onSubmit={(answers) => submitHcEvaluation(component.id, { stage: "SINGLE", subjectEmployeeId, answers })} />
      )}
    </DetailDialog>
  );
}

function EmployeeRecapDialog({ employeeId, onClose }: { employeeId: string; onClose: () => void }) {
  const [state, setState] = useState<Awaited<ReturnType<typeof getEmployeeEvaluation>> | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void getEmployeeEvaluation(employeeId, page).then(setState).catch((cause) => setError(cause instanceof Error ? cause.message : "Rekap tidak dapat dimuat."));
  }, [employeeId, page]);
  return (
    <DetailDialog wide title={state ? `Rekap evaluasi · ${state.employee.fullName}` : "Rekap evaluasi"} onClose={onClose}>
      {error ? <p role="alert" className="text-sm text-danger-ink">{error}</p> : !state ? <DialogLoading /> : state.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Belum ada hasil evaluasi.</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {state.items.map((item) => (
            <li key={item.programId} className="py-2 text-sm">
              <span className="block font-semibold text-brand-heading">{item.title}</span>
              <span className="block text-xs text-muted-foreground">
                Pre {formatScore(item.pre)} · Post {formatScore(item.post)} · Nilai akhir {formatScore(item.finalScore)} · {OUTCOME_LABELS[item.status]}
                {item.applicationRating !== null ? ` · penerapan ${formatScore(item.applicationRating)}/5` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {state && state.pagination.total > state.pagination.pageSize
        ? <PaginationBar page={state.pagination.page} pageSize={state.pagination.pageSize} total={state.pagination.total} onPageChange={setPage} /> : null}
    </DetailDialog>
  );
}
