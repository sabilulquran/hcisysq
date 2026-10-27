import { AlertTriangle, CalendarRange, CheckCircle2, ChevronLeft, ChevronRight, Copy, History, Loader2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { listEmployees } from "@/lib/adminEmployees";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  applyScheduleChange,
  getScheduleCalendar,
  listScheduleChanges,
  previewScheduleChange,
  ScheduleChangeApiError,
  type ScheduleCalendar,
  type ScheduleChangeHistory,
  type ScheduleChangeInput,
  type ScheduleChangePreview,
} from "@/lib/scheduleChanges";

// ATT-011-5 §5.2 layar "Jadwal": kalender planner, Atur/Ganti/Salin jadwal, Lihat dampak → Terapkan,
// Riwayat perubahan dengan Kembalikan seperti sebelumnya. Mutations need attendance.schedule.manage;
// attendance.reports.read sees the calendar read-only (D-1). Bulk changes are tablet/desktop only (D-8).

const dayNames = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];
const ranges = { week: { label: "Minggu", days: 7 }, twoWeeks: { label: "2 Minggu", days: 14 }, month: { label: "Bulan", days: 35 } } as const;
type RangeKey = keyof typeof ranges;
const kindLabels: Record<string, string> = { pattern: "Atur jadwal", replacement: "Ganti jadwal", copy: "Salin jadwal", revert: "Kembalikan" };

function todayJakarta() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()); }
function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function mondayOf(date: string) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  return addDays(date, 1 - day);
}
function shortDate(date: string) {
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}
function newKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type Panel =
  | { mode: "pattern" }
  | { mode: "replacement" }
  | { mode: "copy" }
  | { mode: "history" }
  | null;

export function AdminAttendancePlannerPage() {
  const [canManage, setCanManage] = useState(false);
  const [from, setFrom] = useState(() => mondayOf(todayJakarta()));
  const [rangeKey, setRangeKey] = useState<RangeKey>("week");
  const [unitId, setUnitId] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [units, setUnits] = useState<Array<{ id: string; name: string }>>([]);
  const [calendar, setCalendar] = useState<ScheduleCalendar | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedEmployees, setSelectedEmployees] = useState<Set<string>>(new Set());
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState<Panel>(null);
  const [pending, setPending] = useState<{ change: ScheduleChangeInput; preview: ScheduleChangePreview; key: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const to = addDays(from, ranges[rangeKey].days - 1);
  const dates = useMemo(() => Array.from({ length: ranges[rangeKey].days }, (_, index) => addDays(from, index)), [from, rangeKey]);

  useEffect(() => {
    void getCurrentSession().then((session) => setCanManage(hasPermission(session, "attendance.schedule.manage"))).catch(() => setCanManage(false));
    void listEmployees({ pageSize: 1, status: "active" }).then((result) => setUnits(result.filters.units)).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCalendar(await getScheduleCalendar({ from, to, ...(unitId ? { unitId } : {}), ...(query ? { q: query } : {}), page }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Jadwal tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  }, [from, to, unitId, query, page]);
  useEffect(() => { void load(); }, [load]);

  const shiftName = useMemo(() => new Map((calendar?.shifts ?? []).map((shift) => [shift.id, shift.name])), [calendar]);
  const holidayLabel = useMemo(() => new Map((calendar?.holidays ?? []).map((holiday) => [holiday.date, holiday.label])), [calendar]);
  const unscheduled = (calendar?.employees ?? []).filter((employee) => employee.days.every((day) => day.source === "off" || day.source === "holiday")).length;

  const toggleCell = (employeeId: string, date: string) => {
    if (!canManage || date < todayJakarta()) return;
    setSelectedCells((current) => {
      const next = new Set(current);
      const key = `${employeeId}|${date}`;
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const cellSelection = useMemo(() => {
    const pairs = [...selectedCells].map((key) => key.split("|") as [string, string]);
    const days = pairs.map(([, date]) => date).sort();
    return { employeeIds: [...new Set(pairs.map(([employeeId]) => employeeId))], from: days[0] ?? null, to: days.at(-1) ?? null };
  }, [selectedCells]);

  const scope = (): { employeeIds?: string[]; unitId?: string } =>
    selectedEmployees.size ? { employeeIds: [...selectedEmployees] } : unitId ? { unitId } : {};

  const runPreview = async (change: ScheduleChangeInput) => {
    setBusy(true);
    setError(null);
    try {
      setPending({ change, preview: await previewScheduleChange(change), key: newKey() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dampak tidak dapat dihitung.");
    } finally {
      setBusy(false);
    }
  };

  const exclude = (employeeId: string) => {
    if (!pending) return;
    const excluded = [...new Set([...(pending.change.excludeEmployeeIds ?? []), employeeId])];
    void runPreview({ ...pending.change, excludeEmployeeIds: excluded } as ScheduleChangeInput);
  };

  const apply = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const result = await applyScheduleChange(pending.change, pending.preview.fingerprint, pending.key);
      setNotice(`Jadwal diterapkan untuk ${pending.preview.summary.employees} pegawai.${result.recalculated ? " Hasil kehadiran hari ini sedang diperbarui." : ""}`);
      setPending(null);
      setPanel(null);
      setSelectedCells(new Set());
      await load();
    } catch (cause) {
      if (cause instanceof ScheduleChangeApiError && cause.status === 409) {
        setPending(null);
        setError(`${cause.message} Lihat dampak lagi.`);
      } else if (cause instanceof ScheduleChangeApiError && cause.status >= 400 && cause.status < 500) {
        setError(cause.message);
      } else {
        // §5.5: nothing was applied; Terapkan again reuses the same key and cannot apply twice.
        setError("Belum diterapkan. Coba lagi.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AttendanceWorkforceShell tab="calendar" title="Jadwal" description="Siapa masuk shift apa, tanggal berapa. Ubah lewat Atur, Ganti, atau Salin jadwal; setiap perubahan dilihat dampaknya dulu.">
      {error ? <div role="alert" className="mb-4 flex gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink"><AlertTriangle className="h-4 w-4 shrink-0" /> {error}</div> : null}
      {notice ? <div role="status" className="mb-4 flex gap-3 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink"><CheckCircle2 className="h-4 w-4 shrink-0" /> {notice}</div> : null}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Sebelumnya" className="rounded-lg border p-2" onClick={() => setFrom(addDays(from, -7))}><ChevronLeft className="h-4 w-4" /></button>
          <span className="min-w-40 text-center text-sm font-semibold">{shortDate(from)} – {shortDate(to)}</span>
          <button type="button" aria-label="Berikutnya" className="rounded-lg border p-2" onClick={() => setFrom(addDays(from, 7))}><ChevronRight className="h-4 w-4" /></button>
        </div>
        <select aria-label="Rentang" className="h-9 rounded-xl border px-3 text-sm" value={rangeKey} onChange={(event) => setRangeKey(event.target.value as RangeKey)}>
          {Object.entries(ranges).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
        </select>
        {units.length ? (
          <select aria-label="Unit" className="h-9 rounded-xl border px-3 text-sm" value={unitId} onChange={(event) => { setUnitId(event.target.value); setPage(1); setSelectedEmployees(new Set()); }}>
            <option value="">Semua unit</option>
            {units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
          </select>
        ) : null}
        <input aria-label="Cari pegawai" placeholder="Cari pegawai" className="h-9 rounded-xl border px-3 text-sm" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
        <div className="ml-auto flex flex-wrap gap-2">
          {canManage ? (
            <>
              <button type="button" className="hidden items-center gap-1 rounded-xl bg-brand-primary px-3 py-2 text-sm font-semibold text-brand-foreground md:inline-flex" onClick={() => { setPanel({ mode: "pattern" }); setPending(null); }}><CalendarRange className="h-4 w-4" /> Atur jadwal</button>
              <button type="button" className="hidden items-center gap-1 rounded-xl border px-3 py-2 text-sm font-semibold md:inline-flex" onClick={() => { setPanel({ mode: "copy" }); setPending(null); }}><Copy className="h-4 w-4" /> Salin jadwal</button>
              <button type="button" disabled={!selectedCells.size} className="inline-flex items-center gap-1 rounded-xl border px-3 py-2 text-sm font-semibold disabled:opacity-50" onClick={() => { setPanel({ mode: "replacement" }); setPending(null); }}>Ganti jadwal{selectedCells.size ? ` (${selectedCells.size})` : ""}</button>
            </>
          ) : null}
          <button type="button" className="inline-flex items-center gap-1 rounded-xl border px-3 py-2 text-sm font-semibold" onClick={() => { setPanel({ mode: "history" }); setPending(null); }}><History className="h-4 w-4" /> Riwayat perubahan</button>
        </div>
      </div>
      {canManage ? <p className="mb-3 text-xs text-muted-foreground md:hidden">Gunakan layar lebih besar untuk perubahan massal. Ganti jadwal tetap bisa dari daftar.</p> : null}
      {unscheduled > 0 ? <p className="mb-3 rounded-xl border border-warning-line bg-warning-soft px-3 py-2 text-sm text-warning-ink">{unscheduled} pegawai belum punya jadwal pada rentang ini.</p> : null}

      {calendar && calendar.shifts.length === 0 ? (
        <p className="rounded-2xl border p-6 text-sm">Belum ada shift. <a className="font-semibold text-brand-primary-deep" href="/admin/attendance/shifts">Buat shift dulu</a>.</p>
      ) : null}

      {panel && panel.mode !== "history" && canManage ? (
        <ChangeForm
          mode={panel.mode} shifts={(calendar?.shifts ?? []).filter((shift) => shift.active)} from={from}
          scopeLabel={selectedEmployees.size ? `${selectedEmployees.size} pegawai terpilih` : unitId ? `Unit ${units.find((unit) => unit.id === unitId)?.name ?? ""}` : "Pilih unit atau centang pegawai"}
          scope={scope()} cells={cellSelection} busy={busy}
          onCancel={() => { setPanel(null); setPending(null); }}
          onPreview={(change) => void runPreview(change)}
        />
      ) : null}
      {panel?.mode === "history" ? (
        <HistoryPanel canManage={canManage} onClose={() => setPanel(null)} onRevert={(changeSetId, note) => void runPreview({ kind: "revert", changeSetId, note })} />
      ) : null}
      {pending ? <ImpactPanel preview={pending.preview} busy={busy} onExclude={exclude} onBack={() => setPending(null)} onApply={() => void apply()} /> : null}

      {loading && !calendar ? <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Memuat jadwal…</p> : null}
      {calendar && calendar.employees.length === 0 ? <p className="rounded-2xl border p-6 text-sm text-muted-foreground">Tidak ada pegawai aktif di unit ini pada rentang tersebut.</p> : null}

      {calendar && calendar.employees.length ? (
        <>
          <div className="hidden overflow-x-auto rounded-2xl border md:block">
            <table className="w-full min-w-max text-xs">
              <thead className="bg-surface-sunken text-left">
                <tr>
                  {canManage ? <th className="p-2"><input type="checkbox" aria-label="Pilih semua di halaman ini" checked={calendar.employees.every((employee) => selectedEmployees.has(employee.id))} onChange={(event) => setSelectedEmployees(event.target.checked ? new Set(calendar.employees.map((employee) => employee.id)) : new Set())} /></th> : null}
                  <th className="sticky left-0 bg-surface-sunken p-2">Pegawai</th>
                  {dates.map((date, index) => (
                    <th key={date} className={`p-2 text-center ${holidayLabel.has(date) ? "text-danger-ink" : ""}`} title={holidayLabel.get(date) ?? undefined}>{dayNames[index % 7]}<br />{shortDate(date)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {calendar.employees.map((employee) => (
                  <tr key={employee.id} className="border-t">
                    {canManage ? <td className="p-2"><input type="checkbox" aria-label={`Pilih ${employee.fullName}`} checked={selectedEmployees.has(employee.id)} onChange={() => setSelectedEmployees((current) => { const next = new Set(current); if (next.has(employee.id)) next.delete(employee.id); else next.add(employee.id); return next; })} /></td> : null}
                    <td className="sticky left-0 bg-surface-raised p-2"><span className="font-semibold">{employee.fullName}</span><span className="block text-muted-foreground">{employee.unitName ?? "—"}</span></td>
                    {employee.days.map((day) => {
                      const key = `${employee.id}|${day.date}`;
                      return (
                        <td key={day.date} className="p-1 text-center">
                          <button type="button" disabled={!canManage || day.date < todayJakarta()} onClick={() => toggleCell(employee.id, day.date)}
                            aria-pressed={selectedCells.has(key)}
                            className={`min-h-9 w-full rounded-lg border px-1 ${selectedCells.has(key) ? "border-brand-primary bg-brand-primary-pale" : "border-transparent"} ${cellTone(day.source)}`}>
                            {cellText(day, shiftName)}{day.source === "roster" || day.source === "roster_off" ? <span className="ml-0.5" title="Jadwal pengganti">•</span> : null}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-3 md:hidden">
            {calendar.employees.map((employee) => (
              <article key={employee.id} className="rounded-2xl border p-3">
                <h3 className="font-semibold">{employee.fullName}</h3>
                <ul className="mt-2 grid grid-cols-2 gap-1 text-xs">
                  {employee.days.slice(0, 7).map((day, index) => {
                    const key = `${employee.id}|${day.date}`;
                    return (
                      <li key={day.date}>
                        <button type="button" disabled={!canManage || day.date < todayJakarta()} onClick={() => toggleCell(employee.id, day.date)} aria-pressed={selectedCells.has(key)}
                          className={`flex min-h-11 w-full justify-between rounded-lg border px-2 py-1 ${selectedCells.has(key) ? "border-brand-primary bg-brand-primary-pale" : ""} ${cellTone(day.source)}`}>
                          <span>{dayNames[index]} {shortDate(day.date)}</span><span>{cellText(day, shiftName)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </article>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between text-sm">
            <span>{calendar.total} pegawai</span>
            <div className="flex gap-2">
              <button type="button" className="rounded-lg border px-3 py-1 disabled:opacity-50" disabled={page <= 1} onClick={() => setPage(page - 1)}>Sebelumnya</button>
              <button type="button" className="rounded-lg border px-3 py-1 disabled:opacity-50" disabled={page * calendar.pageSize >= calendar.total} onClick={() => setPage(page + 1)}>Berikutnya</button>
            </div>
          </div>
        </>
      ) : null}
    </AttendanceWorkforceShell>
  );
}

function cellText(day: ScheduleCalendar["employees"][number]["days"][number], shiftName: Map<string, string>) {
  if (day.source === "holiday") return "Libur nasional";
  if (day.source === "roster_off") return "Libur";
  if (day.source === "conflict") return "!";
  if (day.source === "off") return "—";
  return shiftName.get(day.scheduleTemplateId ?? "") ?? "Shift";
}
function cellTone(source: string) {
  if (source === "conflict") return "bg-danger-soft font-bold text-danger-ink";
  if (source === "holiday" || source === "roster_off") return "text-muted-foreground";
  if (source === "off") return "text-muted-foreground/60";
  return "font-semibold";
}

function ChangeForm({ mode, shifts, from, scope, scopeLabel, cells, busy, onCancel, onPreview }: {
  mode: "pattern" | "replacement" | "copy";
  shifts: ScheduleCalendar["shifts"];
  from: string;
  scope: { employeeIds?: string[]; unitId?: string };
  scopeLabel: string;
  cells: { employeeIds: string[]; from: string | null; to: string | null };
  busy: boolean;
  onCancel: () => void;
  onPreview: (change: ScheduleChangeInput) => void;
}) {
  const [shift, setShift] = useState("");
  const [start, setStart] = useState(() => (from > todayJakarta() ? from : addDays(todayJakarta(), 1)));
  const [end, setEnd] = useState("");
  const [noEnd, setNoEnd] = useState(false);
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [unticked, setUnticked] = useState<"off" | "keep">("off");
  const [holidays, setHolidays] = useState(false);
  const [note, setNote] = useState("");
  const [weeks, setWeeks] = useState(1);
  const hasScope = Boolean(scope.employeeIds?.length || scope.unitId);

  const submit = () => {
    const common = { ...(note ? { note } : {}), ...(holidays ? { workOnHolidays: true } : {}) };
    if (mode === "replacement") {
      onPreview({ kind: "replacement", employeeIds: cells.employeeIds, scheduleTemplateId: shift || null, from: cells.from!, to: cells.to!, ...common, note });
    } else if (mode === "copy") {
      onPreview({ kind: "copy", ...scope, sourceWeekStart: from, targetWeekStarts: Array.from({ length: weeks }, (_, index) => addDays(from, 7 * (index + 1))), ...common });
    } else {
      onPreview({ kind: "pattern", ...scope, scheduleTemplateId: shift || null, from: start, to: noEnd ? null : end, weekdays, untickedDays: unticked, ...common });
    }
  };
  const ready = mode === "replacement" ? Boolean(cells.from && note.trim()) : mode === "copy" ? hasScope : hasScope && Boolean(start) && (noEnd || Boolean(end));

  return (
    <section aria-label={kindLabels[mode]} className="mb-4 rounded-2xl border bg-surface-raised p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">{kindLabels[mode]}</h2>
        <button type="button" aria-label="Tutup" className="rounded-lg p-1" onClick={onCancel}><X className="h-4 w-4" /></button>
      </div>
      <div className="grid gap-3 text-sm md:grid-cols-2">
        <p><span className="font-semibold">Siapa:</span> {mode === "replacement" ? `${cells.employeeIds.length} pegawai · ${cells.from ? `${shortDate(cells.from)} – ${shortDate(cells.to!)}` : "pilih sel di kalender"}` : scopeLabel}</p>
        {mode === "copy" ? (
          <label className="grid gap-1">Salin minggu {shortDate(from)} ke berapa minggu berikutnya
            <input type="number" min={1} max={8} className="h-9 rounded-lg border px-2" value={weeks} onChange={(event) => setWeeks(Math.min(8, Math.max(1, Number(event.target.value) || 1)))} />
          </label>
        ) : (
          <label className="grid gap-1">Jadwal
            <select className="h-9 rounded-lg border px-2" value={shift} onChange={(event) => setShift(event.target.value)}>
              <option value="">Libur</option>
              {shifts.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.startTime.slice(0, 5)}–{item.endTime.slice(0, 5)})</option>)}
            </select>
          </label>
        )}
        {mode === "pattern" ? (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <label className="grid gap-1">Mulai<input type="date" min={todayJakarta()} className="h-9 rounded-lg border px-2" value={start} onChange={(event) => setStart(event.target.value)} /></label>
              <label className="grid gap-1">Sampai<input type="date" disabled={noEnd} min={start} className="h-9 rounded-lg border px-2" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={noEnd} onChange={(event) => setNoEnd(event.target.checked)} /> tanpa tanggal akhir</label>
            </div>
            <fieldset className="flex flex-wrap gap-2"><legend className="mb-1">Hari</legend>
              {dayNames.map((name, index) => (
                <label key={name} className="flex items-center gap-1"><input type="checkbox" checked={weekdays.includes(index + 1)} onChange={(event) => setWeekdays(event.target.checked ? [...weekdays, index + 1].sort() : weekdays.filter((day) => day !== index + 1))} /> {name}</label>
              ))}
            </fieldset>
            <fieldset className="flex flex-wrap gap-3"><legend className="mb-1">Hari yang tidak dicentang</legend>
              <label className="flex items-center gap-1"><input type="radio" name="unticked" checked={unticked === "off"} onChange={() => setUnticked("off")} /> Libur</label>
              <label className="flex items-center gap-1"><input type="radio" name="unticked" disabled={!shift} checked={unticked === "keep"} onChange={() => setUnticked("keep")} /> biarkan seperti sekarang</label>
            </fieldset>
          </>
        ) : null}
        <label className="flex items-center gap-2"><input type="checkbox" checked={holidays} onChange={(event) => setHolidays(event.target.checked)} /> tetap masuk pada libur nasional</label>
        <label className="grid gap-1">Keterangan{mode === "replacement" ? " (wajib)" : ""}<input maxLength={500} className="h-9 rounded-lg border px-2" value={note} onChange={(event) => setNote(event.target.value)} /></label>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="rounded-xl border px-3 py-2 text-sm" onClick={onCancel}>Batal</button>
        <button type="button" disabled={!ready || busy || (mode === "pattern" && !weekdays.length)} className="rounded-xl bg-brand-primary px-3 py-2 text-sm font-semibold text-brand-foreground disabled:opacity-50" onClick={submit}>Lihat dampak</button>
      </div>
    </section>
  );
}

export function ImpactPanel({ preview, busy, onExclude, onBack, onApply }: {
  preview: ScheduleChangePreview;
  busy: boolean;
  onExclude: (employeeId: string) => void;
  onBack: () => void;
  onApply: () => void;
}) {
  const blocking = preview.issues.filter((issue) => issue.blocking);
  const notes = preview.issues.filter((issue) => !issue.blocking);
  return (
    <section aria-label="Lihat dampak" className="mb-4 rounded-2xl border border-brand-primary/40 bg-surface-raised p-4 text-sm">
      <h2 className="font-semibold">Lihat dampak</h2>
      <p className="mt-1">{preview.summary.employees} pegawai · {shortDate(preview.summary.from)} – {preview.summary.to ? shortDate(preview.summary.to) : "tanpa akhir"}{preview.summary.rosterDays ? ` · ${preview.summary.rosterDays} hari diganti` : ""}</p>
      <ul className="mt-2 space-y-1">
        {preview.summary.newEmployees ? <li>✓ {preview.summary.newEmployees} pegawai jadwal baru (sebelumnya kosong)</li> : null}
        {preview.summary.replacedEmployees ? <li>↻ {preview.summary.replacedEmployees} pegawai menggantikan jadwal lama</li> : null}
        {preview.holidays.length ? <li>⚑ {preview.holidays.length} tanggal libur nasional ({preview.holidays.slice(0, 3).map((holiday) => shortDate(holiday.date)).join(", ")}{preview.holidays.length > 3 ? ", …" : ""})</li> : null}
        {notes.map((issue, index) => <li key={`n${index}`} className="text-muted-foreground">• {issue.employeeName ? `${issue.employeeName}: ` : ""}{issue.message}</li>)}
      </ul>
      {blocking.length ? (
        <div className="mt-3 rounded-xl border border-danger-line bg-danger-soft p-3 text-danger-ink">
          <p className="font-semibold">⚠ {blocking.length} masalah — tidak bisa diterapkan</p>
          <ul className="mt-1 space-y-1">
            {blocking.map((issue, index) => (
              <li key={`b${index}`} className="flex flex-wrap items-center justify-between gap-2">
                <span>{issue.employeeName ? `${issue.employeeName}: ` : ""}{issue.message}</span>
                {issue.employeeId ? <button type="button" className="rounded-lg border border-danger-line px-2 py-0.5 text-xs" onClick={() => onExclude(issue.employeeId!)}>Kecualikan</button> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs">Pegawai terdampak ({preview.employeesTotal})</summary>
        <ul className="mt-1 max-h-48 overflow-y-auto text-xs">
          {preview.employees.map((employee) => <li key={employee.id}>{employee.fullName} · {employee.changes} perubahan</li>)}
          {preview.employeesTotal > preview.employees.length ? <li>… dan {preview.employeesTotal - preview.employees.length} lainnya</li> : null}
        </ul>
      </details>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="rounded-xl border px-3 py-2" onClick={onBack}>Kembali</button>
        <button type="button" disabled={busy || blocking.length > 0} className="inline-flex items-center gap-1 rounded-xl bg-brand-primary px-3 py-2 font-semibold text-brand-foreground disabled:opacity-50" onClick={onApply}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Terapkan
        </button>
      </div>
    </section>
  );
}

function HistoryPanel({ canManage, onClose, onRevert }: { canManage: boolean; onClose: () => void; onRevert: (changeSetId: string, note: string) => void }) {
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState<ScheduleChangeHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reverting, setReverting] = useState<{ id: string; note: string } | null>(null);
  useEffect(() => {
    void listScheduleChanges(page).then(setHistory).catch((cause) => setError(cause instanceof Error ? cause.message : "Riwayat tidak dapat dimuat."));
  }, [page]);
  return (
    <section aria-label="Riwayat perubahan" className="mb-4 rounded-2xl border bg-surface-raised p-4 text-sm">
      <div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">Riwayat perubahan</h2><button type="button" aria-label="Tutup" onClick={onClose}><X className="h-4 w-4" /></button></div>
      {error ? <p className="text-danger-ink">{error}</p> : null}
      {history && history.items.length === 0 ? <p className="text-muted-foreground">Belum ada perubahan jadwal.</p> : null}
      <ul className="divide-y">
        {history?.items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              <span className="font-semibold">{kindLabels[item.kind]}</span> · {new Date(item.appliedAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} · {item.requestedBy ?? "—"} · {item.summary.employees} pegawai · {shortDate(item.summary.from)} – {item.summary.to ? shortDate(item.summary.to) : "tanpa akhir"}{item.note ? ` · ${item.note}` : ""}
            </span>
            {canManage && item.kind !== "revert" ? (
              reverting?.id === item.id ? (
                <span className="flex gap-1">
                  <input aria-label="Keterangan pengembalian" placeholder="Keterangan" className="h-8 rounded-lg border px-2" value={reverting.note} onChange={(event) => setReverting({ id: item.id, note: event.target.value })} />
                  <button type="button" disabled={!reverting.note.trim()} className="rounded-lg bg-brand-primary px-2 text-brand-foreground disabled:opacity-50" onClick={() => onRevert(item.id, reverting.note.trim())}>Lihat dampak</button>
                </span>
              ) : (
                <button type="button" className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs" onClick={() => setReverting({ id: item.id, note: "" })}><Undo2 className="h-3.5 w-3.5" /> Kembalikan seperti sebelumnya</button>
              )
            ) : null}
          </li>
        ))}
      </ul>
      {history && history.total > history.pageSize ? (
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" className="rounded-lg border px-2 disabled:opacity-50" disabled={page <= 1} onClick={() => setPage(page - 1)}>Sebelumnya</button>
          <button type="button" className="rounded-lg border px-2 disabled:opacity-50" disabled={page * history.pageSize >= history.total} onClick={() => setPage(page + 1)}>Berikutnya</button>
        </div>
      ) : null}
    </section>
  );
}
