import { AlertTriangle, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { attendanceSourceLabel } from "@/lib/attendanceLabels";
import { TODAY_CARDS, todayCardLabel, todayDeltaLabel, todayFactLabel, todayScheduleLabel } from "@/lib/attendanceToday";
import { getAttendanceToday, type AttendanceTodayCard, type AttendanceTodayItem } from "@/lib/workforceAttendance";

function fmt(value: string | null) {
  return value ? new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta" }).format(new Date(value)) : "—";
}
function longDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta" }).format(new Date(`${value}T12:00:00+07:00`));
}
function scheduleTime(item: AttendanceTodayItem) {
  return item.scheduledStartAt ? `${fmt(item.scheduledStartAt)}–${fmt(item.scheduledEndAt)}` : null;
}
function scanText(item: AttendanceTodayItem) {
  if (!item.firstScanAt) return todayFactLabel(item);
  return item.scanCount > 1 ? `${fmt(item.firstScanAt)} → ${fmt(item.lastScanAt)}` : fmt(item.firstScanAt);
}

/**
 * ATT-014 §5 Pantauan Hari Ini: who has scanned today and when. Facts only — the official verdict
 * (Tidak hadir, Terlambat, Tidak lengkap) comes from Laporan & Kalkulasi, never from this screen.
 */
export function AdminAttendanceDailyPage() {
  const [date, setDate] = useState<string | null>(null);
  const [items, setItems] = useState<AttendanceTodayItem[]>([]);
  const [summary, setSummary] = useState<Partial<Record<AttendanceTodayCard, number>>>({});
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [card, setCard] = useState<AttendanceTodayCard | "">("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const today = await getAttendanceToday();
        if (!active) return;
        setDate(today.date);
        setItems(today.items);
        setSummary(today.summary);
        setUpdatedAt(today.generatedAt);
        setError(null);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Pantauan hari ini tidak dapat dimuat.");
      } finally {
        if (active) setLoaded(true);
      }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 30000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((item) => (!card || item.card === card)
      && (!needle || [item.employeeName, item.employeeNumber, item.unitName ?? ""].join(" ").toLowerCase().includes(needle)));
  }, [items, q, card]);

  const visibleCards = TODAY_CARDS.filter((key) => key === "scanned" || key === "not_scanned" || (summary[key] ?? 0) > 0);

  return (
    <AttendanceWorkforceShell tab="daily" title="Pantauan Hari Ini" description="Siapa yang sudah scan hari ini dan jam berapa. Diperbarui setiap 30 detik. Status resmi (hadir, terlambat, tidak hadir) dihitung di Laporan & Kalkulasi.">
      {error ? <div className="mb-5 flex gap-2 rounded-2xl border border-warning-line bg-warning-soft p-4 text-sm text-warning-ink" role="alert"><AlertTriangle className="h-4 w-4" />{error}</div> : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-4">
        {visibleCards.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={card === key}
            onClick={() => setCard(card === key ? "" : key)}
            className={`rounded-2xl border p-4 text-left shadow-[var(--shadow-soft)] ${card === key ? "border-brand-primary bg-brand-primary-pale" : "border-border/70 bg-surface-raised"}`}
          >
            <p className="text-xs font-semibold text-muted-foreground">{todayCardLabel(key)}</p>
            <p className="mt-2 text-2xl font-bold text-brand-heading">{loaded ? summary[key] ?? 0 : "…"}</p>
          </button>
        ))}
      </div>

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <header className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-bold text-brand-heading">{date ? longDate(date) : "Hari ini"}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {updatedAt ? `Diperbarui ${fmt(updatedAt)}. ` : ""}Jam scan diambil langsung dari mesin dan absen HP. Selisih dibandingkan dengan jam masuk jadwal.
            </p>
          </div>
          <label className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><input className="h-10 w-full rounded-xl border pl-9 pr-3 text-sm lg:w-64" placeholder="Cari pegawai/unit…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        </header>

        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-[900px] w-full text-left text-sm">
            <thead className="bg-surface text-xs text-muted-foreground">
              <tr><th className="p-3">Pegawai</th><th className="p-3">Unit</th><th className="p-3">Jadwal hari ini</th><th className="p-3">Scan</th><th className="p-3">Selisih dari jadwal</th><th className="p-3">Sumber</th><th className="p-3">Keterangan</th></tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((item) => (
                <tr key={item.employeeId}>
                  <td className="p-3"><p className="font-semibold">{item.employeeName}</p><p className="text-xs text-muted-foreground">{item.employeeNumber}</p></td>
                  <td className="p-3">{item.unitName ?? "—"}</td>
                  <td className="p-3">{todayScheduleLabel(item, scheduleTime(item))}</td>
                  <td className="p-3 tabular-nums">{item.firstScanAt ? scanText(item) : "—"}</td>
                  <td className="p-3 tabular-nums">{todayDeltaLabel(item.startDeltaMinutes)}</td>
                  <td className="p-3">{attendanceSourceLabel(item.sources)}</td>
                  <td className="p-3 text-muted-foreground">{todayFactLabel(item)}</td>
                </tr>
              ))}
              {loaded && filtered.length === 0 ? <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">Tidak ada pegawai yang cocok dengan filter.</td></tr> : null}
            </tbody>
          </table>
        </div>

        <ul className="divide-y md:hidden">
          {filtered.map((item) => (
            <li key={item.employeeId} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div><p className="font-semibold">{item.employeeName}</p><p className="text-xs text-muted-foreground">{item.unitName ?? "—"}</p></div>
                <span className="rounded-full bg-surface px-2.5 py-1 text-xs font-bold">{todayCardLabel(item.card)}</span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{todayScheduleLabel(item, scheduleTime(item))}</p>
              <p className="mt-1 text-sm tabular-nums">{scanText(item)}{item.startDeltaMinutes !== null ? ` · ${todayDeltaLabel(item.startDeltaMinutes)}` : ""}</p>
            </li>
          ))}
          {loaded && filtered.length === 0 ? <li className="p-8 text-center text-sm text-muted-foreground">Tidak ada pegawai yang cocok dengan filter.</li> : null}
        </ul>
      </section>
    </AttendanceWorkforceShell>
  );
}
