// ORG-012 Human Capital surface: record committees, keep their line-up, decree them (SK issued
// in HCIS or recorded from outside), complete or cancel them, and read the participation recap.
// Spec: docs/domain/committees.md §10.

import { Loader2, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { CommitteeDetailPanel } from "@/components/committees/CommitteeDetailPanel";
import { PaginationBar } from "@/components/PaginationBar";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  activateCommittee,
  addCommitteeMember,
  cancelCommittee,
  CATEGORY_LABELS,
  committeeCategories,
  CommitteeRequestError,
  committeeRoles,
  completeCommittee,
  createCommittee,
  describeEvent,
  endCommitteeMember,
  formatDate,
  formatInstant,
  formatPeriod,
  getCommittee,
  getEmployeeParticipation,
  listCommitteeHistory,
  listCommittees,
  listParticipation,
  ROLE_LABELS,
  roleLabel,
  searchCommitteeEmployees,
  STATUS_LABELS,
  todayInJakarta,
  updateCommittee,
  updateCommitteeMember,
  type CommitteeCategory,
  type CommitteeDetail,
  type CommitteeEvent,
  type CommitteeFilter,
  type CommitteeMember,
  type CommitteeRole,
  type CommitteeStatus,
  type CommitteeSummary,
  type EmployeeOption,
  type EmployeeParticipation,
  type Pagination,
  type ParticipationRow,
} from "@/lib/committees";
import { cn } from "@/lib/utils";

type Tab = "committees" | "participation";
type Panel = { kind: "none" } | { kind: "create" } | { kind: "edit" } | { kind: "activate" } | { kind: "cancel" };

const inputClass = "mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading";
const labelClass = "text-sm font-semibold text-brand-heading";
const cardClass = "rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]";
const primaryButton = "inline-flex min-h-11 items-center gap-1 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50";
const secondaryButton = "inline-flex min-h-11 items-center gap-1 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50";
const dangerButton = "inline-flex min-h-11 items-center gap-1 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50";

const currentYear = Number(todayInJakarta().slice(0, 4));
const yearOptions = [currentYear + 1, currentYear, currentYear - 1, currentYear - 2, currentYear - 3];

function problemText(cause: unknown, fallback: string) {
  if (cause instanceof CommitteeRequestError && cause.problems.length) return cause.problems.join(" ");
  return cause instanceof Error ? cause.message : fallback;
}

function StatusBadge({ status }: { status: CommitteeStatus }) {
  const tone = status === "ACTIVE" ? "bg-brand-primary-pale text-brand-primary-deep"
    : status === "DRAFT" ? "bg-warning-soft text-warning-ink"
      : status === "CANCELLED" ? "bg-danger-soft text-danger-ink" : "bg-surface text-muted-foreground";
  return <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", tone)}>{STATUS_LABELS[status]}</span>;
}

// ------------------------------------------------------------- committee form

function CommitteeForm({ initial, busy, onCancel, onSave }: {
  initial: CommitteeDetail | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (input: { name: string; category: CommitteeCategory; description: string | null; organizer: string | null; startOn: string; endOn: string }) => void;
}) {
  const today = todayInJakarta();
  const [state, setState] = useState({
    name: initial?.name ?? "", category: initial?.category ?? ("EVENT" as CommitteeCategory),
    description: initial?.description ?? "", organizer: initial?.organizer ?? "",
    startOn: initial?.startOn ?? today, endOn: initial?.endOn ?? today,
  });
  // D-10: after activation the decree fixes name, category and start date.
  const locked = Boolean(initial && initial.status !== "DRAFT");
  const set = (patch: Partial<typeof state>) => setState((current) => ({ ...current, ...patch }));
  return (
    <form className={cardClass} onSubmit={(event) => {
      event.preventDefault();
      onSave({ ...state, name: state.name.trim(), description: state.description.trim() || null, organizer: state.organizer.trim() || null });
    }}>
      <h2 className="text-sm font-bold text-brand-heading">{initial ? "Ubah data kegiatan" : "Catat kepanitiaan"}</h2>
      {locked ? <p className="mt-1 text-xs text-muted-foreground">Nama, jenis, dan tanggal mulai sudah tertulis di SK dan tidak dapat diubah.</p> : null}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className={`${labelClass} sm:col-span-2`}>
          Nama kegiatan
          <input required minLength={3} maxLength={200} disabled={locked} value={state.name}
            placeholder="Contoh: Panitia PPDB 2027/2028" onChange={(event) => set({ name: event.target.value })} className={inputClass} />
        </label>
        <label className={labelClass}>
          Jenis
          <select value={state.category} disabled={locked} onChange={(event) => set({ category: event.target.value as CommitteeCategory })} className={inputClass}>
            {committeeCategories.map((category) => <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>)}
          </select>
        </label>
        <label className={labelClass}>
          Penyelenggara <span className="font-normal text-muted-foreground">(opsional)</span>
          <input maxLength={200} value={state.organizer} placeholder="Contoh: SMP Sabilul Qur'an"
            onChange={(event) => set({ organizer: event.target.value })} className={inputClass} />
        </label>
        <label className={labelClass}>
          Tanggal mulai
          <input type="date" required disabled={locked} value={state.startOn}
            onChange={(event) => set({ startOn: event.target.value, endOn: state.endOn < event.target.value ? event.target.value : state.endOn })} className={inputClass} />
        </label>
        <label className={labelClass}>
          Tanggal selesai
          <input type="date" required min={state.startOn} value={state.endOn} onChange={(event) => set({ endOn: event.target.value })} className={inputClass} />
        </label>
        <label className={`${labelClass} sm:col-span-2`}>
          Keterangan <span className="font-normal text-muted-foreground">(opsional)</span>
          <textarea maxLength={2000} rows={3} value={state.description} onChange={(event) => set({ description: event.target.value })}
            className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal text-brand-heading" />
        </label>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Kepanitiaan tidak mengubah struktur organisasi dan tidak memberi kewenangan persetujuan. Honor panitia tidak dicatat di sini.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={primaryButton}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Simpan</button>
        <button type="button" onClick={onCancel} className={secondaryButton}>Batal</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------- member editor

function MemberAdder({ busy, onAdd }: { busy: boolean; onAdd: (employee: EmployeeOption, role: CommitteeRole, section: string | null) => void }) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<EmployeeOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [chosen, setChosen] = useState<EmployeeOption | null>(null);
  const [role, setRole] = useState<CommitteeRole>("MEMBER");
  const [section, setSection] = useState("");

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2 || chosen) {
      setOptions([]);
      return;
    }
    let active = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchCommitteeEmployees(term)
        .then((result) => { if (active) setOptions(result.items); })
        .catch(() => { if (active) setOptions([]); })
        .finally(() => { if (active) setSearching(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, chosen]);

  return (
    <form className="rounded-2xl border border-border/70 bg-surface p-4" onSubmit={(event) => {
      event.preventDefault();
      if (!chosen) return;
      onAdd(chosen, role, section.trim() || null);
      setChosen(null);
      setQuery("");
      setSection("");
      setRole("MEMBER");
    }}>
      <h4 className="text-sm font-bold text-brand-heading">Tambah anggota</h4>
      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <div className="relative">
          <label className={labelClass} htmlFor="committee-member-search">Pegawai</label>
          {chosen ? (
            <div className="mt-1.5 flex min-h-11 items-center justify-between gap-2 rounded-xl border border-border bg-surface-raised px-3 text-sm">
              <span className="truncate font-semibold text-brand-heading">{chosen.fullName}</span>
              <button type="button" aria-label="Ganti pegawai" onClick={() => setChosen(null)} className="rounded p-0.5 hover:bg-muted"><X className="h-3.5 w-3.5" /></button>
            </div>
          ) : (
            <>
              <Search className="pointer-events-none absolute left-3 top-[2.45rem] h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <input id="committee-member-search" value={query} onChange={(event) => setQuery(event.target.value)}
                placeholder="Ketik minimal 2 huruf nama atau NIP" role="combobox" aria-expanded={options.length > 0}
                aria-controls="committee-member-options" className={`${inputClass} pl-9`} />
              {searching ? <Loader2 className="absolute right-3 top-[2.45rem] h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
              {options.length > 0 ? (
                <ul id="committee-member-options" role="listbox"
                  className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-2xl border border-border bg-surface-raised p-1 shadow-[var(--shadow-soft)]">
                  {options.map((option) => (
                    <li key={option.id} role="option" aria-selected={false}>
                      <button type="button" onClick={() => { setChosen(option); setOptions([]); }}
                        className="flex w-full flex-col items-start rounded-xl px-3 py-2 text-left text-sm hover:bg-muted">
                        <span className="font-semibold text-brand-heading">{option.fullName}</span>
                        <span className="text-xs text-muted-foreground">{option.employeeNumber} · {option.unitName ?? "Tanpa unit"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : query.trim().length >= 2 && !searching ? (
                <p className="mt-1 text-xs text-muted-foreground">Tidak ada pegawai aktif yang cocok.</p>
              ) : null}
            </>
          )}
        </div>
        <label className={labelClass}>
          Peran
          <select value={role} onChange={(event) => setRole(event.target.value as CommitteeRole)} className={inputClass}>
            {committeeRoles.map((value) => <option key={value} value={value}>{ROLE_LABELS[value]}</option>)}
          </select>
        </label>
        <label className={labelClass}>
          Seksi {role === "SECTION_COORDINATOR" ? "" : <span className="font-normal text-muted-foreground">(opsional)</span>}
          <input maxLength={100} required={role === "SECTION_COORDINATOR"} value={section} placeholder="Contoh: Seksi Acara"
            onChange={(event) => setSection(event.target.value)} className={inputClass} />
        </label>
        <button type="submit" disabled={busy || !chosen} className={primaryButton}><Plus className="h-4 w-4" />Tambah</button>
      </div>
      {role === "CHAIR" ? <p className="mt-2 text-xs text-muted-foreground">Bila sudah ada Ketua, Ketua lama otomatis menjadi Anggota.</p> : null}
    </form>
  );
}

function MemberControls({ member, busy, onChange, onEnd }: {
  member: CommitteeMember;
  busy: boolean;
  onChange: (role: CommitteeRole, section: string | null) => void;
  onEnd: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState(member.role);
  const [section, setSection] = useState(member.section ?? "");
  if (!editing) {
    return (
      <>
        <button type="button" disabled={busy} onClick={() => setEditing(true)} className="min-h-9 rounded-lg border border-border px-2 text-xs font-bold text-brand-heading">Ubah peran</button>
        <button type="button" disabled={busy} onClick={onEnd} className="min-h-9 rounded-lg border border-danger-line px-2 text-xs font-bold text-danger-ink">Akhiri</button>
      </>
    );
  }
  return (
    <form className="flex flex-wrap items-end gap-1.5" onSubmit={(event) => {
      event.preventDefault();
      onChange(role, section.trim() || null);
      setEditing(false);
    }}>
      <select aria-label={`Peran ${member.fullName}`} value={role} onChange={(event) => setRole(event.target.value as CommitteeRole)}
        className="min-h-9 rounded-lg border border-border bg-surface px-2 text-xs">
        {committeeRoles.map((value) => <option key={value} value={value}>{ROLE_LABELS[value]}</option>)}
      </select>
      <input aria-label={`Seksi ${member.fullName}`} maxLength={100} required={role === "SECTION_COORDINATOR"} value={section}
        placeholder="Seksi" onChange={(event) => setSection(event.target.value)} className="min-h-9 w-28 rounded-lg border border-border bg-surface px-2 text-xs" />
      <button type="submit" disabled={busy} className="min-h-9 rounded-lg bg-brand-primary px-2 text-xs font-bold text-brand-foreground">Simpan</button>
      <button type="button" onClick={() => setEditing(false)} className="min-h-9 rounded-lg border border-border px-2 text-xs font-bold">Batal</button>
    </form>
  );
}

// ------------------------------------------------------------ decree form

function ActivateForm({ busy, onCancel, onSubmit }: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (decree: { mode: "ISSUE" } | { mode: "EXTERNAL"; number: string; date: string }) => void;
}) {
  const [mode, setMode] = useState<"ISSUE" | "EXTERNAL">("ISSUE");
  const [number, setNumber] = useState("");
  const [date, setDate] = useState(todayInJakarta());
  return (
    <form className="rounded-2xl border border-border/70 bg-surface p-4" onSubmit={(event) => {
      event.preventDefault();
      onSubmit(mode === "ISSUE" ? { mode } : { mode, number: number.trim(), date });
    }}>
      <h4 className="text-sm font-bold text-brand-heading">Tetapkan kepanitiaan</h4>
      <p className="mt-1 text-xs text-muted-foreground">Syarat: tepat satu Ketua dan paling sedikit dua anggota aktif. Setelah ditetapkan, anggota mendapat pemberitahuan.</p>
      <fieldset className="mt-3 space-y-2">
        <legend className="sr-only">Cara SK</legend>
        <label className="flex items-start gap-3 text-sm text-brand-heading">
          <input type="radio" name="decree-mode" checked={mode === "ISSUE"} onChange={() => setMode("ISSUE")} className="mt-1 h-4 w-4" />
          <span><span className="font-semibold">Terbitkan SK di HCIS</span> — nomor otomatis dari register surat (…/SKP/YSQ/…), ditandatangani Kepala HCM atau Direktur.</span>
        </label>
        <label className="flex items-start gap-3 text-sm text-brand-heading">
          <input type="radio" name="decree-mode" checked={mode === "EXTERNAL"} onChange={() => setMode("EXTERNAL")} className="mt-1 h-4 w-4" />
          <span><span className="font-semibold">SK sudah terbit di luar HCIS</span> — misalnya ditandatangani Kepala Sekolah; catat nomor dan tanggalnya.</span>
        </label>
      </fieldset>
      {mode === "EXTERNAL" ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className={labelClass}>
            Nomor SK
            <input required minLength={3} maxLength={100} value={number} onChange={(event) => setNumber(event.target.value)} className={inputClass} />
          </label>
          <label className={labelClass}>
            Tanggal SK
            <input type="date" required value={date} onChange={(event) => setDate(event.target.value)} className={inputClass} />
          </label>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={primaryButton}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Tetapkan</button>
        <button type="button" onClick={onCancel} className={secondaryButton}>Batal</button>
      </div>
    </form>
  );
}

function CancelForm({ busy, hasDecree, onCancel, onSubmit }: { busy: boolean; hasDecree: boolean; onCancel: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <form className="rounded-2xl border border-danger-line bg-danger-soft/40 p-4" onSubmit={(event) => { event.preventDefault(); onSubmit(reason.trim()); }}>
      <h4 className="text-sm font-bold text-brand-heading">Batalkan kepanitiaan</h4>
      {hasDecree ? <p className="mt-1 text-xs text-danger-ink">SK yang terbit di HCIS ikut dicabut dengan alasan yang sama; nomornya tidak dipakai ulang.</p> : null}
      <label className={`${labelClass} mt-3 block`}>
        Alasan (10–500 karakter)
        <textarea required minLength={10} maxLength={500} rows={2} value={reason} onChange={(event) => setReason(event.target.value)}
          className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal text-brand-heading" />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={dangerButton}>Batalkan kepanitiaan</button>
        <button type="button" onClick={onCancel} className={secondaryButton}>Kembali</button>
      </div>
    </form>
  );
}

// -------------------------------------------------------------- committees tab

function CommitteesTab({ canManage }: { canManage: boolean }) {
  const [filter, setFilter] = useState<CommitteeFilter>({ status: "", category: "", year: "", q: "", page: 1, pageSize: 25 });
  const [items, setItems] = useState<CommitteeSummary[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [detail, setDetail] = useState<CommitteeDetail | null>(null);
  const [history, setHistory] = useState<CommitteeEvent[]>([]);
  const [historyPaging, setHistoryPaging] = useState<Pagination | null>(null);
  const [panel, setPanel] = useState<Panel>({ kind: "none" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadList = useCallback(async (next: CommitteeFilter) => {
    setLoading(true);
    try {
      const result = await listCommittees(next);
      setItems(result.items);
      setPaging(result.pagination);
    } catch (cause) {
      if (cause instanceof CommitteeRequestError && cause.status === 403) setForbidden(true);
      else setError(problemText(cause, "Daftar kepanitiaan tidak dapat dimuat."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadList(filter), 250);
    return () => window.clearTimeout(timer);
  }, [filter, loadList]);

  const loadHistory = async (id: string, page = 1) => {
    const result = await listCommitteeHistory(id, page);
    setHistory(result.items);
    setHistoryPaging(result.pagination);
  };

  const open = async (id: string) => {
    setError(null);
    setNotice(null);
    setPanel({ kind: "none" });
    try {
      const [loaded] = await Promise.all([getCommittee(id), loadHistory(id)]);
      setDetail(loaded);
    } catch (cause) {
      setError(problemText(cause, "Kepanitiaan tidak dapat dibuka."));
    }
  };

  const update = (patch: Partial<CommitteeFilter>) => setFilter((current) => ({ ...current, page: 1, ...patch }));

  /** Every write reloads the detail and list; a stale version simply reloads with the message. */
  const run = async (action: () => Promise<unknown>, success: string, fallback: string, reopenId = detail?.id) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      setPanel({ kind: "none" });
    } catch (cause) {
      setError(problemText(cause, fallback));
    } finally {
      setBusy(false);
      if (reopenId) {
        await Promise.all([getCommittee(reopenId).then(setDetail), loadHistory(reopenId)]).catch(() => undefined);
      }
      await loadList(filter);
    }
  };

  const version = detail?.version ?? 1;
  const writable = canManage && detail && (detail.status === "DRAFT" || detail.status === "ACTIVE");

  if (forbidden) {
    return <div role="alert" className="rounded-2xl border border-warning-line bg-warning-soft p-4 text-sm text-warning-ink">Anda tidak memiliki akses ke data kepanitiaan.</div>;
  }

  return (
    <div className="space-y-5">
      {error ? <div role="alert" className="rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
      {notice ? <div role="status" className="rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

      <div className="flex flex-wrap items-end gap-3">
        <label className={labelClass}>
          Cari nama
          <input value={filter.q ?? ""} onChange={(event) => update({ q: event.target.value })} placeholder="Minimal 2 huruf" className={`${inputClass} w-56`} />
        </label>
        <label className={labelClass}>
          Status
          <select value={filter.status ?? ""} onChange={(event) => update({ status: event.target.value as CommitteeStatus | "" })} className={inputClass}>
            <option value="">Semua</option>
            {(Object.keys(STATUS_LABELS) as CommitteeStatus[]).map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
          </select>
        </label>
        <label className={labelClass}>
          Jenis
          <select value={filter.category ?? ""} onChange={(event) => update({ category: event.target.value as CommitteeCategory | "" })} className={inputClass}>
            <option value="">Semua</option>
            {committeeCategories.map((category) => <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>)}
          </select>
        </label>
        <label className={labelClass}>
          Tahun
          <select value={filter.year ?? ""} onChange={(event) => update({ year: event.target.value ? Number(event.target.value) : "" })} className={inputClass}>
            <option value="">Semua</option>
            {yearOptions.map((year) => <option key={year} value={year}>{year}</option>)}
          </select>
        </label>
        {canManage ? (
          <button type="button" onClick={() => { setDetail(null); setPanel({ kind: "create" }); }} className={`${primaryButton} ml-auto`}>
            <Plus className="h-4 w-4" />Catat kepanitiaan
          </button>
        ) : null}
      </div>

      {panel.kind === "create" ? (
        <CommitteeForm initial={null} busy={busy} onCancel={() => setPanel({ kind: "none" })} onSave={(input) => {
          void (async () => {
            setBusy(true);
            setError(null);
            try {
              const created = await createCommittee(input);
              setNotice("Kepanitiaan dicatat sebagai draf. Tambahkan susunan panitia, lalu tetapkan.");
              setPanel({ kind: "none" });
              await Promise.all([open(created.id), loadList(filter)]);
            } catch (cause) {
              setError(problemText(cause, "Kepanitiaan tidak dapat dicatat."));
            } finally {
              setBusy(false);
            }
          })();
        }} />
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]" aria-busy={loading}>
          {loading && items.length === 0 ? (
            <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
          ) : items.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted-foreground">Belum ada kepanitiaan yang cocok dengan filter ini.</p>
          ) : (
            <ul className="divide-y divide-border/70">
              {items.map((item) => (
                <li key={item.id}>
                  <button type="button" onClick={() => void open(item.id)}
                    className={cn("flex w-full flex-col items-start gap-1 px-5 py-3 text-left hover:bg-muted/50", detail?.id === item.id && "bg-muted/60")}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-brand-heading">{item.name}</span>
                      <StatusBadge status={item.status} />
                    </span>
                    <span className="text-xs text-muted-foreground">{formatPeriod(item.startOn, item.endOn)} · {CATEGORY_LABELS[item.category]}</span>
                    <span className="text-[11px] text-muted-foreground">
                      Ketua: {item.chairName ?? "belum ada"} · {item.activeMemberCount} anggota{item.decreeNumber ? ` · SK ${item.decreeNumber}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {paging && paging.total > 0 ? (
            <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total}
              onPageChange={(page) => setFilter((current) => ({ ...current, page }))}
              onPageSizeChange={(pageSize) => update({ pageSize })} />
          ) : null}
        </section>

        <section className={cardClass}>
          {!detail ? (
            <p className="text-sm text-muted-foreground">Pilih kepanitiaan untuk melihat susunan panitia, SK, dan riwayatnya.</p>
          ) : panel.kind === "edit" ? (
            <CommitteeForm initial={detail} busy={busy} onCancel={() => setPanel({ kind: "none" })}
              onSave={(input) => void run(() => updateCommittee(detail.id, { ...input, version }), "Data kegiatan disimpan.", "Data kegiatan tidak dapat disimpan.")} />
          ) : (
            <CommitteeDetailPanel
              detail={detail}
              actions={writable ? (
                <>
                  <button type="button" disabled={busy} onClick={() => setPanel({ kind: "edit" })} className={secondaryButton}>Ubah data</button>
                  {detail.status === "DRAFT" ? (
                    <button type="button" disabled={busy} onClick={() => setPanel({ kind: "activate" })} className={primaryButton}>Tetapkan</button>
                  ) : null}
                  {detail.status === "ACTIVE" ? (
                    <button type="button" disabled={busy} onClick={() => {
                      if (!window.confirm(`Tandai ${detail.name} selesai? Tugas semua anggota ikut berakhir.`)) return;
                      void run(() => completeCommittee(detail.id, version), "Kepanitiaan ditandai selesai.", "Kepanitiaan tidak dapat diselesaikan.");
                    }} className={secondaryButton}>Selesaikan</button>
                  ) : null}
                  <button type="button" disabled={busy} onClick={() => setPanel({ kind: "cancel" })} className={dangerButton}>Batalkan</button>
                </>
              ) : null}
              memberActions={writable ? (member) => (
                <MemberControls key={`${member.id}-${member.role}-${member.section ?? ""}`} member={member} busy={busy}
                  onChange={(role, section) => void run(() => updateCommitteeMember(detail.id, member.id, { role, section, version }),
                    "Peran anggota disimpan.", "Peran anggota tidak dapat diubah.")}
                  onEnd={() => {
                    const reason = detail.status === "DRAFT" ? null
                      : window.prompt(`Akhiri tugas ${member.fullName}? Alasan (opsional, maks. 300 karakter):`, "");
                    if (detail.status !== "DRAFT" && reason === null) return;
                    void run(() => endCommitteeMember(detail.id, member.id, { reason: reason?.trim() || null, version }),
                      detail.status === "DRAFT" ? "Anggota dihapus dari draf." : "Tugas anggota diakhiri.", "Tugas anggota tidak dapat diakhiri.");
                  }} />
              ) : undefined}
            >
              {panel.kind === "activate" ? (
                <ActivateForm busy={busy} onCancel={() => setPanel({ kind: "none" })}
                  onSubmit={(decree) => void run(() => activateCommittee(detail.id, { decree, version }),
                    "Kepanitiaan ditetapkan.", "Kepanitiaan tidak dapat ditetapkan.")} />
              ) : null}
              {panel.kind === "cancel" ? (
                <CancelForm busy={busy} hasDecree={detail.decreeMode === "ISSUED"} onCancel={() => setPanel({ kind: "none" })}
                  onSubmit={(reason) => void run(() => cancelCommittee(detail.id, { reason, version }),
                    "Kepanitiaan dibatalkan.", "Kepanitiaan tidak dapat dibatalkan.")} />
              ) : null}
              {writable ? (
                <MemberAdder busy={busy} onAdd={(employee, role, section) => void run(
                  () => addCommitteeMember(detail.id, { employeeId: employee.id, role, section, version }),
                  `${employee.fullName} ditambahkan sebagai ${roleLabel(role, section)}.`, "Anggota tidak dapat ditambahkan.")} />
              ) : null}
            </CommitteeDetailPanel>
          )}

          {detail && panel.kind !== "edit" ? (
            <section className="mt-6">
              <h4 className="text-sm font-bold text-brand-heading">Riwayat</h4>
              {history.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">Belum ada riwayat.</p>
              ) : (
                <ol className="mt-2 space-y-1.5 border-l border-border pl-4">
                  {history.map((event) => (
                    <li key={event.id} className="text-sm">
                      <p className="font-semibold text-brand-heading">{describeEvent(event)}</p>
                      <p className="text-xs text-muted-foreground">{formatInstant(event.occurredAt)}{event.actorName ? ` · ${event.actorName}` : ""}</p>
                      {event.reason ? <p className="text-xs text-foreground">{event.reason}</p> : null}
                    </li>
                  ))}
                </ol>
              )}
              {historyPaging && historyPaging.total > historyPaging.pageSize ? (
                <PaginationBar page={historyPaging.page} pageSize={historyPaging.pageSize} total={historyPaging.total}
                  onPageChange={(page) => void loadHistory(detail.id, page)} />
              ) : null}
            </section>
          ) : null}
        </section>
      </div>
    </div>
  );
}

// ----------------------------------------------------------- participation tab

function ParticipationTab() {
  const [year, setYear] = useState(currentYear);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [rows, setRows] = useState<ParticipationRow[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<EmployeeParticipation | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void listParticipation({ year, q, page, pageSize })
        .then((result) => { if (active) { setRows(result.items); setPaging(result.pagination); setError(null); } })
        .catch((cause) => { if (active) setError(problemText(cause, "Rekap tidak dapat dimuat.")); })
        .finally(() => { if (active) setLoading(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [year, q, page, pageSize]);

  const openEmployee = (employeeId: string, nextPage = 1) => {
    void getEmployeeParticipation(employeeId, year, nextPage)
      .then(setSelected)
      .catch((cause) => setError(problemText(cause, "Rincian tidak dapat dimuat.")));
  };

  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
        Jumlah kepanitiaan yang ditetapkan atau selesai per pegawai pada tahun yang dipilih. Kepanitiaan yang dibatalkan dan
        draf tidak dihitung. Rekap ini bahan pertimbangan penilaian kinerja, bukan skor otomatis.
      </p>
      {error ? <div role="alert" className="rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
      <div className="flex flex-wrap items-end gap-3">
        <label className={labelClass}>
          Tahun
          <select value={year} onChange={(event) => { setYear(Number(event.target.value)); setPage(1); setSelected(null); }} className={inputClass}>
            {yearOptions.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className={labelClass}>
          Cari pegawai
          <input value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }} placeholder="Nama atau NIP, minimal 2 huruf" className={`${inputClass} w-64`} />
        </label>
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]" aria-busy={loading}>
          {loading && rows.length === 0 ? (
            <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
          ) : rows.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted-foreground">Belum ada keikutsertaan kepanitiaan pada tahun {year}.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-left text-sm">
                <thead className="border-b border-border/70 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Pegawai</th>
                    <th className="px-2 py-2 text-right font-semibold">Kepanitiaan</th>
                    <th className="px-2 py-2 text-right font-semibold">Ketua</th>
                    <th className="px-2 py-2 text-right font-semibold">Pengurus inti</th>
                    <th className="px-4 py-2 text-right font-semibold">Berjalan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {rows.map((row) => (
                    <tr key={row.employeeId} className={cn("cursor-pointer hover:bg-muted/50", selected?.employee.id === row.employeeId && "bg-muted/60")}
                      onClick={() => openEmployee(row.employeeId)}>
                      <td className="px-4 py-2">
                        <button type="button" className="text-left font-semibold text-brand-heading" onClick={(event) => { event.stopPropagation(); openEmployee(row.employeeId); }}>
                          {row.fullName}
                        </button>
                        <span className="block text-xs text-muted-foreground">{row.employeeNumber} · {row.unitName ?? "Tanpa unit"}</span>
                      </td>
                      <td className="px-2 py-2 text-right font-bold">{row.total}</td>
                      <td className="px-2 py-2 text-right">{row.asChair}</td>
                      <td className="px-2 py-2 text-right">{row.asCore}</td>
                      <td className="px-4 py-2 text-right">{row.ongoing}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {paging && paging.total > 0 ? (
            <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={setPage}
              onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} />
          ) : null}
        </section>
        <section className={cardClass}>
          {!selected ? (
            <p className="text-sm text-muted-foreground">Pilih pegawai untuk melihat kepanitiaannya pada tahun {year}.</p>
          ) : (
            <>
              <h3 className="text-base font-bold text-brand-heading">{selected.employee.fullName}</h3>
              <p className="text-xs text-muted-foreground">{selected.employee.employeeNumber} · {selected.employee.unitName ?? "Tanpa unit"} · {selected.year}</p>
              <ul className="mt-3 divide-y divide-border/70 rounded-xl border border-border/70 bg-surface">
                {selected.items.map((item) => (
                  <li key={item.memberId} className="px-3 py-2.5 text-sm">
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-brand-heading">{item.name} <StatusBadge status={item.status} /></p>
                    <p className="text-xs text-muted-foreground">{roleLabel(item.role, item.section)} · {formatPeriod(item.startOn, item.endOn)}</p>
                    <p className="text-[11px] text-muted-foreground">
                      Bergabung {formatDate(item.joinedOn)}{item.leftOn ? ` · berakhir ${formatDate(item.leftOn)}` : ""}
                      {item.decreeNumber ? ` · SK ${item.decreeNumber}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
              {selected.pagination.total > selected.pagination.pageSize ? (
                <PaginationBar page={selected.pagination.page} pageSize={selected.pagination.pageSize} total={selected.pagination.total}
                  onPageChange={(next) => openEmployee(selected.employee.id, next)} />
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export function AdminCommitteesPage() {
  const [tab, setTab] = useState<Tab>("committees");
  const [canManage, setCanManage] = useState(false);
  useEffect(() => {
    void getCurrentSession().then((session) => setCanManage(hasPermission(session, "committees.manage"))).catch(() => setCanManage(false));
  }, []);
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "committees", label: "Kepanitiaan" },
    { key: "participation", label: "Rekap keikutsertaan" },
  ];
  return (
    <AdminShell active="committees" title="Kepanitiaan" description="Panitia kegiatan lintas unit: susunan, SK, riwayat, dan rekap keikutsertaan pegawai.">
      <div className="mb-5 flex gap-2 overflow-x-auto" role="group" aria-label="Bagian Kepanitiaan">
        {tabs.map((entry) => (
          <button key={entry.key} type="button" aria-pressed={tab === entry.key} onClick={() => setTab(entry.key)}
            className={cn("min-h-11 shrink-0 rounded-xl border px-4 text-sm font-bold",
              tab === entry.key ? "border-brand-primary bg-brand-primary text-brand-foreground" : "border-border text-brand-heading")}>
            {entry.label}
          </button>
        ))}
      </div>
      {tab === "committees" ? <CommitteesTab canManage={canManage} /> : <ParticipationTab />}
    </AdminShell>
  );
}
