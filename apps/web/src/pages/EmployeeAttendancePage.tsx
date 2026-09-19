import {
  AlertTriangle,
  CalendarDays,
  Clock3,
  Info,
  Loader2,
  LogIn,
  LogOut,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import {
  AttendanceApiError,
  getMyAttendance,
  type AttendanceListResponse,
} from "@/lib/attendance";
import {
  getEmployeeLeaveSummary,
  type EmployeeLeaveSummary,
} from "@/lib/employeeLeave";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(new Date(`${value}T00:00:00+07:00`));
}

function formatTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

export function EmployeeAttendancePage() {
  const [attendance, setAttendance] = useState<AttendanceListResponse | null>(null);
  const [summary, setSummary] = useState<EmployeeLeaveSummary | null>(null);
  const [loadingAttendance, setLoadingAttendance] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    void getMyAttendance()
      .then((attendanceResult) => {
        if (!mounted) return;
        setAttendance(attendanceResult);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!mounted) return;
        setAttendance(null);
        setError(
          cause instanceof AttendanceApiError || cause instanceof Error
            ? cause.message
            : "Data kehadiran tidak dapat dimuat.",
        );
      })
      .finally(() => {
        if (mounted) setLoadingAttendance(false);
      });

    // Leave summary is supporting shell context only. A failure here must not
    // turn an otherwise successful attendance read into a false attendance error.
    void getEmployeeLeaveSummary()
      .then((leaveSummary) => {
        if (mounted) setSummary(leaveSummary);
      })
      .catch(() => {
        if (mounted) setSummary(null);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const employee = attendance?.employee ?? summary?.employee;
  const user = useMemo(
    () => ({
      name: employee?.fullName ?? "Pegawai",
      initials: initials(employee?.fullName ?? "P"),
      position: employee?.positionName ?? "Pegawai",
      unit: employee?.unitName ?? "Yayasan Sabilul Qur'an",
      ...(summary?.pendingApprovalCount ? { additionalRole: "Approver" } : {}),
    }),
    [employee, summary?.pendingApprovalCount],
  );

  const referenceDate = attendance?.referenceDate;
  const today = attendance?.items.find((item) => item.attendanceDate === referenceDate) ?? null;

  return (
    <AppShell user={user} activeItem="Kehadiran">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Kehadiran saya</p>
        <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-brand-heading sm:text-3xl">Rekaman Kehadiran</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Jam masuk dan jam keluar yang sudah tercatat. Untuk presensi HP, jadwal/shift, hasil keterlambatan, dan klarifikasi, buka Clock In / Out.
        </p>
        <a href="/app/attendance/clock" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-brand-primary px-4 text-sm font-bold text-white">Buka Clock In / Out</a>
      </section>

      {error ? (
        <div className="mt-5 flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {error}
        </div>
      ) : null}

      {loadingAttendance ? (
        <div className="mt-6 flex items-center gap-2 rounded-3xl border border-border/70 bg-white p-6 text-sm text-muted-foreground shadow-[var(--shadow-soft)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat rekaman kehadiran...
        </div>
      ) : !attendance ? (
        <div className="mt-6 rounded-3xl border border-border/70 bg-white p-6 text-sm text-muted-foreground shadow-[var(--shadow-soft)]">
          Rekaman kehadiran belum dapat ditampilkan. Muat ulang halaman setelah koneksi tersedia kembali.
        </div>
      ) : (
        <>
          <section className="mt-6 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <article className="rounded-[2rem] border border-border/80 bg-white p-5 shadow-[var(--shadow-raised)] sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Hari ini</p>
                  <h2 className="mt-1 text-lg font-bold text-brand-heading">
                    {referenceDate ? formatDate(referenceDate) : "Kehadiran hari ini"}
                  </h2>
                </div>
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-primary-pale text-brand-primary-deep">
                  <Clock3 className="h-5 w-5" aria-hidden="true" />
                </span>
              </div>

              {today ? (
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-border/70 bg-surface p-4">
                    <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                      <LogIn className="h-4 w-4" aria-hidden="true" /> Jam masuk
                    </div>
                    <p className="mt-2 text-2xl font-bold text-brand-heading">{formatTime(today.checkInAt)}</p>
                  </div>
                  <div className="rounded-2xl border border-border/70 bg-surface p-4">
                    <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                      <LogOut className="h-4 w-4" aria-hidden="true" /> Jam keluar
                    </div>
                    <p className="mt-2 text-2xl font-bold text-brand-heading">{formatTime(today.checkOutAt)}</p>
                  </div>
                </div>
              ) : (
                <div className="mt-5 rounded-2xl border border-dashed border-border bg-surface p-5">
                  <p className="text-sm font-bold text-brand-heading">Belum ada rekaman hari ini</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Ini tidak otomatis berarti tidak hadir. Rekaman mungkin belum dimasukkan atau belum tersinkronisasi.
                  </p>
                </div>
              )}
            </article>

            <article className="rounded-[2rem] border border-border/80 bg-white p-5 shadow-[var(--shadow-soft)] sm:p-6">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-brand-cyan/14 text-cyan-900">
                  <Info className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <h2 className="text-sm font-bold text-brand-heading">Status modul saat ini</h2>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    Rekaman faktual ATT-001 tetap dipertahankan. Evaluasi jadwal/shift, keterlambatan, GPS/foto, dan klarifikasi tersedia pada workspace presensi baru.
                  </p>
                </div>
              </div>
              <div className="mt-5 rounded-2xl bg-surface p-4 text-xs text-muted-foreground">
                Rentang tampil: {formatDate(attendance.range.from)} – {formatDate(attendance.range.to)}
              </div>
            </article>
          </section>

          <section className="mt-5 overflow-hidden rounded-[2rem] border border-border/80 bg-white shadow-[var(--shadow-soft)]">
            <div className="flex items-center justify-between gap-3 border-b border-border/70 px-5 py-4 sm:px-6">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Riwayat</p>
                <h2 className="mt-1 text-base font-bold text-brand-heading">Rekaman terbaru</h2>
              </div>
              <CalendarDays className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            </div>

            {attendance.items.length ? (
              <div className="divide-y divide-border/70">
                {attendance.items.map((item) => (
                  <div key={item.attendanceDate} className="grid gap-3 px-5 py-4 sm:grid-cols-[1.2fr_0.8fr_0.8fr] sm:items-center sm:px-6">
                    <div>
                      <p className="text-sm font-bold text-brand-heading">{formatDate(item.attendanceDate)}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {item.source === "manual" ? "Rekaman administrasi" : "Rekaman integrasi"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Masuk</p>
                      <p className="mt-1 text-sm font-bold text-brand-heading">{formatTime(item.checkInAt)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Keluar</p>
                      <p className="mt-1 text-sm font-bold text-brand-heading">{formatTime(item.checkOutAt)}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-5 py-8 text-sm text-muted-foreground sm:px-6">
                Belum ada rekaman kehadiran pada rentang ini.
              </div>
            )}
          </section>
        </>
      )}
    </AppShell>
  );
}
