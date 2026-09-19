import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Copy, Loader2, Plus, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import {
  copyPreviousAttendanceRoster,
  createAttendanceRoster,
  getAttendanceRosterWeek,
  publishAttendanceRoster,
  removeAttendanceRosterEntry,
  updateAttendanceRosterEntries,
  type AttendanceRosterWorkspace,
} from "@/lib/workforceAttendance";

const dayNames = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];

function mondayOf(value = new Date()) {
  const date = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function shiftDate(value: string, days: number) {
  const date = new Date(value + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function AdminAttendanceRosterPage() {
  const [weekStart, setWeekStart] = useState(() => mondayOf());
  const [data, setData] = useState<AttendanceRosterWorkspace | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setData(await getAttendanceRosterWeek(weekStart));
  };
  useEffect(() => {
    void getAttendanceRosterWeek(weekStart)
      .then(setData)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Roster tidak dapat dimuat."));
  }, [weekStart]);

  const draft = data?.rosters.find((item) => item.status === "DRAFT") ?? null;
  const published = data?.rosters.find((item) => item.status === "PUBLISHED") ?? null;
  const dates = useMemo(() => Array.from({ length: 7 }, (_, index) => shiftDate(weekStart, index)), [weekStart]);

  const entryMap = useMemo(() => {
    const result = new Map<string, AttendanceRosterWorkspace["entries"][number]>();
    if (!data) return result;
    const rosterId = draft?.id ?? published?.id;
    if (!rosterId) return result;
    for (const entry of data.entries) {
      if (entry.rosterId === rosterId) result.set(entry.employeeId + ":" + entry.workDate, entry);
    }
    return result;
  }, [data, draft?.id, published?.id]);

  const run = async (key: string, operation: () => Promise<unknown>, message: string) => {
    setBusy(key); setError(null); setNotice(null);
    try { await operation(); await load(); setNotice(message); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Operasi roster gagal."); }
    finally { setBusy(null); }
  };

  const changeCell = async (employeeId: string, workDate: string, value: string) => {
    if (!draft) return;
    const key = employeeId + ":" + workDate;
    if (value === "inherit") {
      if (!entryMap.has(key)) return;
      await run(key, () => removeAttendanceRosterEntry(draft.id, employeeId, workDate), "Cell kembali mengikuti jadwal default.");
      return;
    }
    const isOff = value === "off";
    await run(
      key,
      () => updateAttendanceRosterEntries(draft.id, [{
        employeeId,
        workDate,
        scheduleTemplateId: isOff ? null : value.replace("schedule:", ""),
        isOff,
        note: null,
      }]),
      "Perubahan roster disimpan sebagai draft.",
    );
  };

  return (
    <AttendanceWorkforceShell section="roster" title="Roster Shift Mingguan" description="Grid Senin–Minggu dengan draft, inherit default, libur, shift override, dan publish eksplisit.">
      {error ? <div className="mb-4 flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><AlertTriangle className="h-4 w-4" /> {error}</div> : null}
      {notice ? <div className="mb-4 flex gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" /> {notice}</div> : null}

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <header className="flex flex-col gap-4 border-b border-border/70 p-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-bold text-brand-heading">Minggu {weekStart}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {draft ? "Ada draft versi " + draft.version + ". Perubahan belum memengaruhi engine sampai dipublish." : published ? "Published versi " + published.version + " aktif. Buat draft untuk melakukan perubahan." : "Belum ada roster published; pegawai mengikuti assignment default."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="h-10 rounded-xl border px-3" onClick={() => setWeekStart(shiftDate(weekStart, -7))}><ChevronLeft className="h-4 w-4" /></button>
            <input className="h-10 rounded-xl border px-3 text-sm" type="date" value={weekStart} onChange={(e) => setWeekStart(mondayOf(new Date(e.target.value + "T12:00:00")))} />
            <button type="button" className="h-10 rounded-xl border px-3" onClick={() => setWeekStart(shiftDate(weekStart, 7))}><ChevronRight className="h-4 w-4" /></button>
            {!draft ? (
              <button type="button" disabled={busy !== null} onClick={() => void run("create", () => createAttendanceRoster(weekStart), "Draft roster dibuat.")} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-3 text-xs font-bold text-white disabled:opacity-50"><Plus className="h-4 w-4" /> Buat draft</button>
            ) : (
              <>
                <button type="button" disabled={busy !== null} onClick={() => void run("copy", () => copyPreviousAttendanceRoster(draft.id), "Roster minggu lalu disalin ke draft.")} className="inline-flex h-10 items-center gap-2 rounded-xl border px-3 text-xs font-bold disabled:opacity-50">{busy === "copy" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />} Salin minggu lalu</button>
                <button type="button" disabled={busy !== null} onClick={() => void run("publish", () => publishAttendanceRoster(draft.id), "Roster dipublikasikan dan menjadi authoritative.")} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-3 text-xs font-bold text-white disabled:opacity-50">{busy === "publish" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Publish</button>
              </>
            )}
          </div>
        </header>

        <div className="overflow-x-auto">
          <table className="min-w-[1160px] w-full table-fixed text-left text-sm">
            <thead className="bg-surface">
              <tr>
                <th className="w-[250px] p-3 text-xs text-muted-foreground">Pegawai</th>
                {dates.map((date, index) => <th key={date} className="w-[130px] p-3 text-center text-xs text-muted-foreground"><div>{dayNames[index]}</div><div className="font-normal">{date.slice(8,10)}/{date.slice(5,7)}</div></th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {data?.employees.map((employee) => (
                <tr key={employee.id}>
                  <td className="p-3 align-top">
                    <p className="font-semibold text-brand-heading">{employee.employeeName}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{employee.employeeNumber}{employee.unitName ? " · " + employee.unitName : ""}</p>
                    <p className="mt-1 text-[10px] text-muted-foreground">Default: {data?.schedules.find((item) => item.id === employee.defaultScheduleId)?.name ?? "belum ada"}</p>
                  </td>
                  {dates.map((workDate) => {
                    const entry = entryMap.get(employee.id + ":" + workDate);
                    const value = !entry ? "inherit" : entry.isOff ? "off" : "schedule:" + entry.scheduleTemplateId;
                    const key = employee.id + ":" + workDate;
                    return (
                      <td key={workDate} className="p-2 align-top">
                        <select
                          className="h-10 w-full rounded-lg border border-border bg-white px-2 text-xs disabled:bg-surface disabled:text-muted-foreground"
                          value={value}
                          disabled={!draft || busy !== null}
                          onChange={(event) => void changeCell(employee.id, workDate, event.target.value)}
                        >
                          <option value="inherit">Ikuti default</option>
                          <option value="off">Libur / OFF</option>
                          {data?.schedules.filter((item) => item.active).map((schedule) => <option key={schedule.id} value={"schedule:" + schedule.id}>{schedule.name}</option>)}
                        </select>
                        <div className="mt-1 text-[10px]">
                          {busy === key ? <span className="text-brand-primary-deep">Menyimpan…</span> : draft ? <span className="font-semibold text-amber-700">DRAFT</span> : published ? <span className="text-emerald-700">Published</span> : <span className="text-muted-foreground">Default</span>}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {data && data.employees.length === 0 ? <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">Belum ada pegawai aktif.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </AttendanceWorkforceShell>
  );
}
