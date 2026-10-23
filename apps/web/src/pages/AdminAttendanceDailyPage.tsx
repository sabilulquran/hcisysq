import { AlertTriangle, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { ATTENDANCE_STATUSES, attendanceSourceLabel, attendanceStatusLabel } from "@/lib/attendanceLabels";
import { getAttendanceDaily, type AttendanceDailyItem } from "@/lib/workforceAttendance";

function todayJakarta() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()); }
function fmt(value: string | null) {
  return value ? new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta" }).format(new Date(value)) : "—";
}
/** I-3: a missing punch stays visible as "?" and is never filled from the schedule. */
function punch(value: string | null, other: string | null) { return value ? fmt(value) : other ? "?" : "—"; }

export function AdminAttendanceDailyPage() {
  const [date, setDate] = useState(todayJakarta());
  const [items, setItems] = useState<AttendanceDailyItem[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const daily = await getAttendanceDaily(date);
        if (!active) return;
        setItems(daily.items);
        setSummary(daily.summary);
        setError(null);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Kehadiran harian tidak dapat dimuat.");
      } finally {
        if (active) setLoaded(true);
      }
    };
    void refresh();
    const interval = date === todayJakarta() ? window.setInterval(() => { void refresh(); }, 30000) : null;
    return () => { active = false; if (interval !== null) window.clearInterval(interval); };
  }, [date]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((item) => (!status || item.status === status)
      && (!needle || [item.employeeName, item.employeeNumber, item.unitName ?? ""].join(" ").toLowerCase().includes(needle)));
  }, [items, q, status]);

  return (
    <AttendanceWorkforceShell tab="daily" title="Kehadiran harian" description="Semua pegawai aktif pada tanggal terpilih, termasuk yang belum absen. Halaman hari ini diperbarui setiap 30 detik.">
      {error ? <div className="mb-5 flex gap-2 rounded-2xl border border-warning-line bg-warning-soft p-4 text-sm text-warning-ink"><AlertTriangle className="h-4 w-4" />{error}</div> : null}
      <section className="overflow-hidden rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <header className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-bold text-brand-heading">Kehadiran pegawai</h2>
            <p className="mt-1 text-xs text-muted-foreground">Status dihitung dari jadwal, scan, cuti/izin, dan jam saat ini. Jam yang belum tercatat ditampilkan "?".</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input className="h-10 rounded-xl border px-3 text-sm" type="date" aria-label="Tanggal" value={date} onChange={(e) => setDate(e.target.value)} />
            <select className="h-10 rounded-xl border px-3 text-sm" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Semua status</option>
              {ATTENDANCE_STATUSES.map((item) => <option key={item} value={item}>{attendanceStatusLabel(item)}</option>)}
            </select>
            <label className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><input className="h-10 rounded-xl border pl-9 pr-3 text-sm" placeholder="Cari pegawai/unit…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          </div>
        </header>
        <div className="flex flex-wrap gap-2 border-b px-4 py-3">
          {Object.entries(summary).map(([key, value]) => <span key={key} className="rounded-full bg-surface px-3 py-1.5 text-xs font-bold">{attendanceStatusLabel(key)}: {value}</span>)}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[960px] w-full text-left text-sm">
            <thead className="bg-surface text-xs text-muted-foreground">
              <tr><th className="p-3">Pegawai</th><th className="p-3">Unit</th><th className="p-3">Status</th><th className="p-3">Jadwal</th><th className="p-3">Masuk</th><th className="p-3">Pulang</th><th className="p-3">Kerja</th><th className="p-3">Terlambat</th><th className="p-3">Lembur</th><th className="p-3">Sumber</th></tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((item) => (
                <tr key={item.employeeId}>
                  <td className="p-3"><p className="font-semibold">{item.employeeName}</p><p className="text-xs text-muted-foreground">{item.employeeNumber}</p></td>
                  <td className="p-3">{item.unitName ?? "—"}</td>
                  <td className="p-3">{attendanceStatusLabel(item.status)}</td>
                  <td className="p-3">{item.scheduledStartAt ? `${fmt(item.scheduledStartAt)}–${fmt(item.scheduledEndAt)}` : "—"}</td>
                  <td className="p-3">{punch(item.firstCheckInAt, item.lastCheckOutAt)}</td>
                  <td className="p-3">{punch(item.lastCheckOutAt, item.firstCheckInAt)}</td>
                  <td className="p-3">{item.workedMinutes} mnt</td>
                  <td className="p-3">{item.lateMinutes} mnt{item.lateJustified ? " · alasan diterima" : ""}</td>
                  <td className="p-3">{item.overtimeMinutes} mnt</td>
                  <td className="p-3">{attendanceSourceLabel(item.sources)}</td>
                </tr>
              ))}
              {loaded && filtered.length === 0 ? <tr><td colSpan={10} className="p-8 text-center text-muted-foreground">Tidak ada pegawai yang cocok dengan filter.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </AttendanceWorkforceShell>
  );
}
