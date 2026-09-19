import { AlertTriangle, ArrowRight, CalendarRange, ClipboardCheck, MapPin, Radio, Smartphone, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { listEmployees } from "@/lib/adminEmployees";
import {
  getAttendanceReport,
  listAttendanceClarificationsForHcByStatus,
  listAttendanceMobileEvidence,
  listAttendanceSchedules,
  listAttendanceWorkLocations,
} from "@/lib/workforceAttendance";

function todayJakarta() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function AdminAttendanceWorkforceOverviewPage() {
  const [summary, setSummary] = useState({
    employees: 0,
    schedules: 0,
    locations: 0,
    clarifications: 0,
    mobileReview: 0,
    present: 0,
    late: 0,
    absent: 0,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const date = todayJakarta();
    void Promise.all([
      listEmployees({ page: 1, pageSize: 1, status: "active" }),
      listAttendanceSchedules(),
      listAttendanceWorkLocations(),
      listAttendanceClarificationsForHcByStatus("submitted"),
      listAttendanceMobileEvidence({ date, reviewState: "needs_review" }),
      getAttendanceReport(date),
    ])
      .then(([employees, schedules, locations, clarifications, mobile, report]) => {
        setSummary({
          employees: employees.pagination.total,
          schedules: schedules.items.filter((item) => item.active).length,
          locations: locations.items.filter((item) => item.active).length,
          clarifications: clarifications.items.length,
          mobileReview: mobile.items.length,
          present: report.summary.present ?? 0,
          late: report.summary.late ?? 0,
          absent: report.summary.absent ?? 0,
        });
        setError(null);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Ringkasan kehadiran tidak dapat dimuat."));
  }, []);

  const cards = [
    ["Pegawai aktif", summary.employees, UsersRound],
    ["Jadwal aktif", summary.schedules, CalendarRange],
    ["Lokasi aktif", summary.locations, MapPin],
    ["Klarifikasi menunggu", summary.clarifications, ClipboardCheck],
    ["Evidence perlu review", summary.mobileReview, Smartphone],
    ["Hadir / telat", summary.present + summary.late, Radio],
  ] as const;

  return (
    <AttendanceWorkforceShell
      section="overview"
      title="Operasional Kehadiran"
      description="Workspace Human Capital untuk jadwal, roster, evidence, klarifikasi, dan laporan kehadiran YSQ."
    >
      {error ? (
        <div className="mb-5 flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {cards.map(([label, value, Icon]) => (
          <article key={label} className="rounded-2xl border border-border/70 bg-white p-4 shadow-[var(--shadow-soft)]">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
              <Icon className="h-4 w-4" /> {label}
            </div>
            <p className="mt-2 text-2xl font-bold text-brand-heading">{value}</p>
          </article>
        ))}
      </section>

      <section className="mt-5 grid gap-4 lg:grid-cols-3">
        <a href="/admin/attendance/workforce/roster" className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)] hover:border-brand-primary/40">
          <h2 className="font-bold text-brand-heading">Roster mingguan</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Atur shift per pegawai dengan grid Senin–Minggu, draft, salin minggu lalu, dan publish.</p>
          <span className="mt-4 inline-flex items-center gap-1 text-xs font-bold text-brand-primary-deep">Buka roster <ArrowRight className="h-3.5 w-3.5" /></span>
        </a>
        <a href="/admin/attendance/workforce/clarifications" className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)] hover:border-brand-primary/40">
          <h2 className="font-bold text-brand-heading">Klarifikasi</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{summary.clarifications} pengajuan masih menunggu keputusan Human Capital.</p>
          <span className="mt-4 inline-flex items-center gap-1 text-xs font-bold text-brand-primary-deep">Tinjau klarifikasi <ArrowRight className="h-3.5 w-3.5" /></span>
        </a>
        <a href="/admin/attendance/workforce/mobile" className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)] hover:border-brand-primary/40">
          <h2 className="font-bold text-brand-heading">Evidence mobile</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{summary.mobileReview} evidence GPS/foto hari ini perlu ditinjau.</p>
          <span className="mt-4 inline-flex items-center gap-1 text-xs font-bold text-brand-primary-deep">Buka evidence <ArrowRight className="h-3.5 w-3.5" /></span>
        </a>
      </section>

      <section className="mt-5 rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-bold text-brand-heading">Status hasil hari ini</h2>
            <p className="mt-1 text-xs text-muted-foreground">Data muncul dari result version yang sudah dimaterialisasi.</p>
          </div>
          <a href="/admin/attendance/workforce/reports" className="text-xs font-bold text-brand-primary-deep hover:underline">Buka laporan</a>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl bg-emerald-50 p-4"><p className="text-xs font-semibold text-emerald-700">Hadir</p><p className="mt-1 text-2xl font-bold text-emerald-900">{summary.present}</p></div>
          <div className="rounded-xl bg-amber-50 p-4"><p className="text-xs font-semibold text-amber-700">Terlambat</p><p className="mt-1 text-2xl font-bold text-amber-900">{summary.late}</p></div>
          <div className="rounded-xl bg-red-50 p-4"><p className="text-xs font-semibold text-red-700">Tidak hadir</p><p className="mt-1 text-2xl font-bold text-red-900">{summary.absent}</p></div>
        </div>
      </section>
    </AttendanceWorkforceShell>
  );
}
