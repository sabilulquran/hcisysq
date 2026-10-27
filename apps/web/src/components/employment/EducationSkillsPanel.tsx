// EMP-007 P2-2 screen (spec docs/domain/employment-administration-package2.md
// §7.1). Records, not overwritten columns: nothing here edits a field of the
// employee master, every change keeps its own row, and a record that turns out
// to be wrong is voided with a reason rather than deleted.
//
// The lists and forms are presentational and exported on their own so the
// tests can render them with data; the panel below only fetches and wires
// them. The highest education level, whether a certificate has lapsed, and
// every refusal come from the API.

import { BookOpen, BadgeCheck, CircleSlash, Pencil, Plus, ShieldCheck } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { EmploymentApiError, formatDate, type EmploymentView } from "@/lib/employment";
import {
  COMPLETION_STATUS_LABEL,
  EDUCATION_LEVEL_LABEL,
  PROFICIENCY_LABEL,
  SKILL_CATEGORY_LABEL,
  SKILL_KIND_LABEL,
  VERIFICATION_STATUS_LABEL,
  amendEducation,
  amendSkill,
  getEducation,
  getSkills,
  recordEducation,
  recordSkill,
  setVerification,
  voidProfileRecord,
  type CompletionStatus,
  type EducationInput,
  type EducationLevel,
  type EducationList,
  type EducationRecord,
  type ProficiencyLevel,
  type ProfileRecordKind,
  type SkillCategory,
  type SkillInput,
  type SkillKind,
  type SkillList,
  type SkillRecord,
} from "@/lib/employeeProfile";

const card = "rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]";
const field = "w-full rounded-xl border border-border/70 bg-surface px-3 py-2 text-sm";
const primaryButton = "rounded-xl bg-brand-primary-deep px-4 py-2 text-sm font-bold text-white disabled:opacity-60";
const quietButton = "rounded-xl border border-border/70 px-3 py-1.5 text-xs font-bold text-muted-foreground";

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-bold text-brand-heading">{label}</span>
      {children}
    </label>
  );
}

function VerificationBadge({ status }: { status: string }) {
  const verified = status === "DIVERIFIKASI";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${
        verified ? "bg-success-soft text-success-ink" : "bg-surface text-muted-foreground"
      }`}
    >
      {verified ? <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" /> : null}
      {VERIFICATION_STATUS_LABEL[verified ? "DIVERIFIKASI" : "DILAPORKAN"]}
    </span>
  );
}

function ViewStates({ view, children }: { view: EmploymentView<unknown>; children: ReactNode }) {
  if (view.kind === "loading") return <p className="text-sm text-muted-foreground">Memuat data…</p>;
  if (view.kind === "forbidden") {
    return <p className="text-sm text-muted-foreground">Akun ini tidak berhak melihat pendidikan dan keahlian pegawai.</p>;
  }
  if (view.kind === "disabled") return <p className="text-sm text-muted-foreground">Bagian ini belum diaktifkan.</p>;
  if (view.kind === "error") return <p role="alert" className="text-sm text-danger-ink">{view.message}</p>;
  return <>{children}</>;
}

export interface RecordActions {
  canManage: boolean;
  busy?: boolean;
  onEdit: (recordId: string) => void;
  onVerify: (recordId: string) => void;
  onUnverify: (recordId: string) => void;
  onVoid: (recordId: string) => void;
}

function RowActions({ row, actions }: { row: { id: string; verificationStatus: string }; actions: RecordActions }) {
  if (!actions.canManage) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className={quietButton} onClick={() => actions.onEdit(row.id)} disabled={actions.busy}>
        <Pencil className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />Ubah
      </button>
      {row.verificationStatus === "DIVERIFIKASI" ? (
        <button type="button" className={quietButton} onClick={() => actions.onUnverify(row.id)} disabled={actions.busy}>
          Cabut verifikasi
        </button>
      ) : (
        <button type="button" className={quietButton} onClick={() => actions.onVerify(row.id)} disabled={actions.busy}>
          <ShieldCheck className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />Tandai terverifikasi
        </button>
      )}
      <button type="button" className={quietButton} onClick={() => actions.onVoid(row.id)} disabled={actions.busy}>
        <CircleSlash className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />Batalkan
      </button>
    </div>
  );
}

export function EducationRecords({ view, actions, onAdd }: {
  view: EmploymentView<EducationList>;
  actions: RecordActions;
  onAdd: () => void;
}) {
  return (
    <article className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <BookOpen className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
          <h2 className="text-base font-bold text-brand-heading">Pendidikan</h2>
        </div>
        {actions.canManage ? (
          <button type="button" className={primaryButton} onClick={onAdd}>
            <Plus className="mr-1 inline h-4 w-4" aria-hidden="true" />Tambah pendidikan
          </button>
        ) : null}
      </div>

      <ViewStates view={view}>
        {view.kind === "ready" ? (
          <>
            <p className="mt-3 text-sm text-muted-foreground">
              Pendidikan tertinggi (dari catatan terverifikasi):{" "}
              <strong className="text-brand-heading">
                {view.data.highestLevel ? EDUCATION_LEVEL_LABEL[view.data.highestLevel] : "Belum dapat ditentukan"}
              </strong>
            </p>
            {view.data.rows.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">Belum ada catatan pendidikan.</p>
            ) : (
              <ul className="mt-4 grid gap-3">
                {view.data.rows.map((row) => (
                  <li key={row.id} className="rounded-xl border border-border/70 bg-surface p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm text-brand-heading">{EDUCATION_LEVEL_LABEL[row.level]}</strong>
                      <VerificationBadge status={row.verificationStatus} />
                      <span className="text-xs text-muted-foreground">{COMPLETION_STATUS_LABEL[row.completionStatus]}</span>
                    </div>
                    <p className="mt-1 text-sm">{row.institutionName}{row.major ? ` — ${row.major}` : ""}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.startedYear ?? "?"}–{row.completedYear ?? "?"}{row.degreeTitle ? ` · ${row.degreeTitle}` : ""}
                    </p>
                    {row.unverifiedReason ? (
                      <p className="mt-1 text-xs text-warning-ink">Verifikasi dicabut: {row.unverifiedReason}</p>
                    ) : null}
                    <RowActions row={row} actions={actions} />
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </ViewStates>
    </article>
  );
}

export function SkillRecords({ view, actions, onAdd }: {
  view: EmploymentView<SkillList>;
  actions: RecordActions;
  onAdd: () => void;
}) {
  return (
    <article className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
          <h2 className="text-base font-bold text-brand-heading">Keahlian & sertifikat</h2>
        </div>
        {actions.canManage ? (
          <button type="button" className={primaryButton} onClick={onAdd}>
            <Plus className="mr-1 inline h-4 w-4" aria-hidden="true" />Tambah keahlian
          </button>
        ) : null}
      </div>

      <ViewStates view={view}>
        {view.kind === "ready" ? (
          view.data.rows.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">Belum ada catatan keahlian atau sertifikat.</p>
          ) : (
            <ul className="mt-4 grid gap-3">
              {view.data.rows.map((row) => (
                <li key={row.id} className="rounded-xl border border-border/70 bg-surface p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm text-brand-heading">{row.name}</strong>
                    <span className="text-xs text-muted-foreground">
                      {SKILL_KIND_LABEL[row.kind]} · {SKILL_CATEGORY_LABEL[row.category]}
                    </span>
                    <VerificationBadge status={row.verificationStatus} />
                    {row.expired ? (
                      <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-bold text-warning-ink">
                        Masa berlaku habis
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.issuer ? `${row.issuer} · ` : ""}
                    {row.proficiency ? `${PROFICIENCY_LABEL[row.proficiency]} · ` : ""}
                    {row.issuedOn ? `Terbit ${formatDate(row.issuedOn)}` : "Tanggal terbit belum dicatat"}
                    {row.expiresOn ? ` · Berlaku sampai ${formatDate(row.expiresOn)}` : " · Tanpa masa berlaku"}
                  </p>
                  <RowActions row={row} actions={actions} />
                </li>
              ))}
            </ul>
          )
        ) : null}
      </ViewStates>
    </article>
  );
}

export const EMPTY_EDUCATION: EducationInput = {
  level: "D4_S1",
  institutionName: "",
  major: "",
  startedYear: null,
  completedYear: null,
  completionStatus: "SELESAI",
  degreeTitle: "",
  certificateNumber: "",
  archiveReference: "",
  notes: "",
};

export const EMPTY_SKILL: SkillInput = {
  kind: "SERTIFIKAT",
  name: "",
  category: "PENGAJARAN",
  proficiency: null,
  issuer: "",
  certificateNumber: "",
  issuedOn: "",
  expiresOn: "",
  archiveReference: "",
  notes: "",
};

export function EducationForm({ draft, editing, busy, onChange, onSubmit, onCancel }: {
  draft: EducationInput;
  editing: boolean;
  busy: boolean;
  onChange: (next: EducationInput) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="grid gap-3 rounded-2xl border border-border/70 bg-surface p-4 sm:grid-cols-2">
      <h3 className="sm:col-span-2 text-sm font-bold text-brand-heading">
        {editing ? "Ubah catatan pendidikan" : "Catatan pendidikan baru"}
      </h3>
      <Labelled label="Jenjang">
        <select className={field} value={draft.level} onChange={(event) => onChange({ ...draft, level: event.target.value as EducationLevel })}>
          {Object.entries(EDUCATION_LEVEL_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Labelled>
      <Labelled label="Status">
        <select className={field} value={draft.completionStatus} onChange={(event) => onChange({ ...draft, completionStatus: event.target.value as CompletionStatus })}>
          {Object.entries(COMPLETION_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Labelled>
      <Labelled label="Nama lembaga">
        <input className={field} required value={draft.institutionName} onChange={(event) => onChange({ ...draft, institutionName: event.target.value })} />
      </Labelled>
      <Labelled label="Jurusan">
        <input className={field} value={draft.major ?? ""} onChange={(event) => onChange({ ...draft, major: event.target.value })} />
      </Labelled>
      <Labelled label="Tahun mulai">
        <input className={field} inputMode="numeric" value={draft.startedYear ?? ""} onChange={(event) => onChange({ ...draft, startedYear: yearOrNull(event.target.value) })} />
      </Labelled>
      <Labelled label="Tahun selesai">
        <input className={field} inputMode="numeric" value={draft.completedYear ?? ""} onChange={(event) => onChange({ ...draft, completedYear: yearOrNull(event.target.value) })} />
      </Labelled>
      <Labelled label="Gelar">
        <input className={field} value={draft.degreeTitle ?? ""} onChange={(event) => onChange({ ...draft, degreeTitle: event.target.value })} />
      </Labelled>
      <Labelled label="Letak arsip ijazah">
        <input className={field} value={draft.archiveReference ?? ""} onChange={(event) => onChange({ ...draft, archiveReference: event.target.value })} />
      </Labelled>
      <div className="sm:col-span-2 flex gap-2">
        <button type="submit" className={primaryButton} disabled={busy}>Simpan</button>
        <button type="button" className={quietButton} onClick={onCancel}>Batal</button>
      </div>
    </form>
  );
}

export function SkillForm({ draft, editing, busy, onChange, onSubmit, onCancel }: {
  draft: SkillInput;
  editing: boolean;
  busy: boolean;
  onChange: (next: SkillInput) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="grid gap-3 rounded-2xl border border-border/70 bg-surface p-4 sm:grid-cols-2">
      <h3 className="sm:col-span-2 text-sm font-bold text-brand-heading">
        {editing ? "Ubah catatan keahlian" : "Catatan keahlian baru"}
      </h3>
      <Labelled label="Jenis">
        <select className={field} value={draft.kind} onChange={(event) => onChange({ ...draft, kind: event.target.value as SkillKind })}>
          {Object.entries(SKILL_KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Labelled>
      <Labelled label="Kategori">
        <select className={field} value={draft.category} onChange={(event) => onChange({ ...draft, category: event.target.value as SkillCategory })}>
          {Object.entries(SKILL_CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Labelled>
      <Labelled label="Nama">
        <input className={field} required value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
      </Labelled>
      <Labelled label="Penerbit">
        <input className={field} value={draft.issuer ?? ""} onChange={(event) => onChange({ ...draft, issuer: event.target.value })} />
      </Labelled>
      {draft.kind === "KEAHLIAN" ? (
        <Labelled label="Tingkat">
          <select
            className={field}
            value={draft.proficiency ?? ""}
            onChange={(event) => onChange({ ...draft, proficiency: (event.target.value || null) as ProficiencyLevel | null })}
          >
            <option value="">Belum dinilai</option>
            {Object.entries(PROFICIENCY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Labelled>
      ) : null}
      <Labelled label="Tanggal terbit">
        <input className={field} type="date" value={draft.issuedOn ?? ""} onChange={(event) => onChange({ ...draft, issuedOn: event.target.value })} />
      </Labelled>
      <Labelled label="Berlaku sampai">
        <input className={field} type="date" value={draft.expiresOn ?? ""} onChange={(event) => onChange({ ...draft, expiresOn: event.target.value })} />
      </Labelled>
      <Labelled label="Letak arsip sertifikat">
        <input className={field} value={draft.archiveReference ?? ""} onChange={(event) => onChange({ ...draft, archiveReference: event.target.value })} />
      </Labelled>
      <div className="sm:col-span-2 flex gap-2">
        <button type="submit" className={primaryButton} disabled={busy}>Simpan</button>
        <button type="button" className={quietButton} onClick={onCancel}>Batal</button>
      </div>
    </form>
  );
}

export function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length ? trimmed : null;
}

function yearOrNull(value: string): number | null {
  const trimmed = value.trim();
  return trimmed.length ? Number(trimmed) : null;
}

/** What the API is sent: blanks become null, and a certificate carries no proficiency. */
export function educationPayload(draft: EducationInput): EducationInput {
  return {
    ...draft,
    institutionName: draft.institutionName.trim(),
    major: blankToNull(draft.major),
    degreeTitle: blankToNull(draft.degreeTitle),
    certificateNumber: blankToNull(draft.certificateNumber),
    archiveReference: blankToNull(draft.archiveReference),
    notes: blankToNull(draft.notes),
  };
}

export function skillPayload(draft: SkillInput): SkillInput {
  return {
    ...draft,
    name: draft.name.trim(),
    issuer: blankToNull(draft.issuer),
    certificateNumber: blankToNull(draft.certificateNumber),
    issuedOn: blankToNull(draft.issuedOn),
    expiresOn: blankToNull(draft.expiresOn),
    archiveReference: blankToNull(draft.archiveReference),
    notes: blankToNull(draft.notes),
    proficiency: draft.kind === "KEAHLIAN" ? draft.proficiency ?? null : null,
  };
}

export function viewFromProfileError(cause: unknown): EmploymentView<never> {
  if (cause instanceof EmploymentApiError) {
    if (cause.status === 403) return { kind: "forbidden" };
    return { kind: "error", message: cause.message };
  }
  return { kind: "error", message: "Data pendidikan dan keahlian tidak dapat dimuat. Periksa koneksi lalu coba lagi." };
}

function draftFromEducation(row: EducationRecord): EducationInput {
  return {
    level: row.level,
    institutionName: row.institutionName,
    major: row.major ?? "",
    startedYear: row.startedYear,
    completedYear: row.completedYear,
    completionStatus: row.completionStatus,
    degreeTitle: row.degreeTitle ?? "",
    certificateNumber: row.certificateNumber ?? "",
    archiveReference: row.archiveReference ?? "",
    notes: row.notes ?? "",
  };
}

function draftFromSkill(row: SkillRecord): SkillInput {
  return {
    kind: row.kind,
    name: row.name,
    category: row.category,
    proficiency: row.proficiency,
    issuer: row.issuer ?? "",
    certificateNumber: row.certificateNumber ?? "",
    issuedOn: row.issuedOn ?? "",
    expiresOn: row.expiresOn ?? "",
    archiveReference: row.archiveReference ?? "",
    notes: row.notes ?? "",
  };
}

export interface EducationSkillsPanelProps {
  employeeId: string;
  canManage: boolean;
  /** Overridden in tests; the browser prompt is how HC gives the reason. */
  askReason?: (question: string) => string | null;
}

export function EducationSkillsPanel({ employeeId, canManage, askReason }: EducationSkillsPanelProps) {
  const [educationView, setEducationView] = useState<EmploymentView<EducationList>>({ kind: "loading" });
  const [skillView, setSkillView] = useState<EmploymentView<SkillList>>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [educationDraft, setEducationDraft] = useState<EducationInput | null>(null);
  const [educationEditing, setEducationEditing] = useState<string | null>(null);
  const [skillDraft, setSkillDraft] = useState<SkillInput | null>(null);
  const [skillEditing, setSkillEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setEducationView({ kind: "loading" });
    setSkillView({ kind: "loading" });
    void getEducation(employeeId)
      .then((data) => { if (mounted) setEducationView({ kind: "ready", data }); })
      .catch((cause: unknown) => { if (mounted) setEducationView(viewFromProfileError(cause)); });
    void getSkills(employeeId)
      .then((data) => { if (mounted) setSkillView({ kind: "ready", data }); })
      .catch((cause: unknown) => { if (mounted) setSkillView(viewFromProfileError(cause)); });
    return () => { mounted = false; };
  }, [employeeId, reloadToken]);

  const refresh = (message: string) => {
    setNotice(message);
    setError(null);
    setEducationDraft(null);
    setEducationEditing(null);
    setSkillDraft(null);
    setSkillEditing(null);
    setReloadToken((token) => token + 1);
  };

  async function run(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof EmploymentApiError ? cause.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  const ask = askReason ?? ((question: string) => window.prompt(question));

  const submitEducation = (event: FormEvent) => {
    event.preventDefault();
    if (!educationDraft) return;
    const payload = educationPayload(educationDraft);
    void run(async () => {
      if (educationEditing) {
        await amendEducation(educationEditing, payload);
        refresh("Catatan pendidikan diperbarui.");
      } else {
        await recordEducation(employeeId, payload);
        refresh("Catatan pendidikan ditambahkan.");
      }
    }, "Catatan pendidikan tidak dapat disimpan.");
  };

  const submitSkill = (event: FormEvent) => {
    event.preventDefault();
    if (!skillDraft) return;
    const payload = skillPayload(skillDraft);
    void run(async () => {
      if (skillEditing) {
        await amendSkill(skillEditing, payload);
        refresh("Catatan keahlian diperbarui.");
      } else {
        await recordSkill(employeeId, payload);
        refresh("Catatan keahlian ditambahkan.");
      }
    }, "Catatan keahlian tidak dapat disimpan.");
  };

  function actionsFor(kind: ProfileRecordKind, startEdit: (recordId: string) => void): RecordActions {
    return {
      canManage,
      busy,
      onEdit: startEdit,
      onVerify: (recordId) => void run(async () => {
        await setVerification(kind, recordId, { verified: true });
        refresh("Catatan ditandai terverifikasi.");
      }, "Verifikasi tidak dapat disimpan."),
      onUnverify: (recordId) => {
        const reason = ask("Alasan pencabutan verifikasi (minimal 5 huruf):")?.trim() ?? "";
        if (reason.length < 5) return;
        void run(async () => {
          await setVerification(kind, recordId, { verified: false, reason });
          refresh("Verifikasi dicabut; siapa dan kapan memverifikasi tetap tercatat.");
        }, "Pencabutan verifikasi tidak dapat disimpan.");
      },
      onVoid: (recordId) => {
        const reason = ask("Alasan pembatalan catatan (minimal 5 huruf):")?.trim() ?? "";
        if (reason.length < 5) return;
        void run(async () => {
          await voidProfileRecord(kind, recordId, reason);
          refresh("Catatan dibatalkan; riwayatnya tetap tersimpan.");
        }, "Catatan tidak dapat dibatalkan.");
      },
    };
  }

  return (
    <section className="grid gap-5">
      {notice ? <p role="status" className="rounded-2xl border border-border/70 bg-surface p-4 text-sm">{notice}</p> : null}
      {error ? <p role="alert" className="rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</p> : null}

      <EducationRecords
        view={educationView}
        onAdd={() => { setEducationEditing(null); setEducationDraft({ ...EMPTY_EDUCATION }); }}
        actions={actionsFor("education", (recordId) => {
          const row = educationView.kind === "ready"
            ? educationView.data.rows.find((item) => item.id === recordId)
            : undefined;
          if (!row) return;
          setEducationEditing(recordId);
          setEducationDraft(draftFromEducation(row));
        })}
      />
      {educationDraft ? (
        <EducationForm
          draft={educationDraft}
          editing={educationEditing !== null}
          busy={busy}
          onChange={setEducationDraft}
          onSubmit={submitEducation}
          onCancel={() => { setEducationDraft(null); setEducationEditing(null); }}
        />
      ) : null}

      <SkillRecords
        view={skillView}
        onAdd={() => { setSkillEditing(null); setSkillDraft({ ...EMPTY_SKILL }); }}
        actions={actionsFor("skill", (recordId) => {
          const row = skillView.kind === "ready" ? skillView.data.rows.find((item) => item.id === recordId) : undefined;
          if (!row) return;
          setSkillEditing(recordId);
          setSkillDraft(draftFromSkill(row));
        })}
      />
      {skillDraft ? (
        <SkillForm
          draft={skillDraft}
          editing={skillEditing !== null}
          busy={busy}
          onChange={setSkillDraft}
          onSubmit={submitSkill}
          onCancel={() => { setSkillDraft(null); setSkillEditing(null); }}
        />
      ) : null}
    </section>
  );
}
