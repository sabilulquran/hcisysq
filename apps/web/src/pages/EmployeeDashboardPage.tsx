import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Grid2X2,
  Loader2,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import { getMyWorkforceAttendance, type WorkforceSnapshot } from "@/lib/workforceAttendance";
import {
  getMyAttendanceResolutions,
  type AttendanceResolutionItem,
} from "@/lib/attendanceResolution";
import {
  getEmployeeLeaveSummary,
  type EmployeeLeaveSummary,
} from "@/lib/employeeLeave";
import {
  getSpecialLeaveSummary,
  type SpecialLeaveSummary,
} from "@/lib/specialLeave";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function jakartaDateParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Jakarta",
  }).formatToParts(new Date());
  const read = (type: "year" | "month" | "day") => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function getDateLabel() {
  return new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(new Date());
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
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

function attendanceStatusLabel(status: string) {
  const labels: Record<string, string> = {
    scheduled: "Terjadwal",
    pending: "Belum check-in",
    present: "Hadir",
    late: "Terlambat",
    incomplete: "Belum lengkap",
    leave: "Cuti / Izin",
    absent: "Tidak hadir",
    off: "Libur",
    configuration_error: "Jadwal perlu diperiksa",
  };
  return labels[status] ?? status;
}

function requestStatusLabel(status: string, specialTaskStatus?: string | null) {
  if (specialTaskStatus === "needs_correction") return "Perlu dilengkapi";
  if (specialTaskStatus === "pending") return "Validasi HC";
  if (status === "approved") return "Selesai";
  if (status === "rejected") return "Tidak disetujui";
  if (status === "cancelled") return "Dibatalkan";
  return "Diproses";
}

interface DashboardState {
  annual: EmployeeLeaveSummary;
  special: SpecialLeaveSummary;
  resolutions: AttendanceResolutionItem[];
  attendance: WorkforceSnapshot;
}

export function EmployeeDashboardPage() {
  const [data, setData] = useState<DashboardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const today = jakartaDateParts();
      try {
        const [annual, special, resolutions, attendance] = await Promise.all([
          getEmployeeLeaveSummary(),
          getSpecialLeaveSummary(),
          getMyAttendanceResolutions(),
          getMyWorkforceAttendance(today),
        ]);
        setData({
          annual,
          special,
          resolutions: resolutions.items,
          attendance,
        });
        setError(null);
      } catch (cause) {
        setData(null);
        setError(cause instanceof Error ? cause.message : "Dashboard tidak dapat dimuat.");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  const employee = data?.annual.employee;
  const pendingEmployeeResolution =
    data?.resolutions.filter((item) => item.status === "awaiting_employee").length ?? 0;
  const needsCompletion =
    data?.special.requests.filter((item) => item.hcTaskStatus === "needs_correction").length ?? 0;
  const pendingApprovals = data?.annual.pendingApprovalCount ?? 0;
  const totalActions = pendingEmployeeResolution + needsCompletion + pendingApprovals;
  const hasOrganizationHcAccess = data?.special.hasHumanCapitalRole ?? false;
  const additionalRole = pendingApprovals > 0 ? "Approver" : undefined;
  const accessLabel = hasOrganizationHcAccess ? "Human Capital" : additionalRole;
  const user = {
    name: employee?.fullName ?? "Pegawai",
    initials: initials(employee?.fullName ?? "P"),
    position: employee?.positionName ?? "Pegawai",
    unit: employee?.unitName ?? "Yayasan Sabilul Qur'an",
    ...(additionalRole ? { additionalRole } : {}),
  };

  const firstName = employee?.fullName.split(/\s+/).filter(Boolean)[0] ?? "Pegawai";
  const annualView = data?.annual.annualLeave;
  const currentPeriod = annualView?.periods.find((period) => period.status === "current") ?? null;

  const latestRequests = useMemo(() => {
    if (!data) return [];
    const annual = data.annual.requests.map((item) => ({
      id: item.id,
      name: "Cuti Tahunan",
      detail: `${formatDate(item.startOn)} – ${formatDate(item.endOn)} · ${item.workingDays} hari kerja`,
      status: requestStatusLabel(item.status),
      submittedAt: item.submittedAt,
    }));
    const special = data.special.requests.map((item) => ({
      id: item.id,
      name: item.policyName,
      detail: `${formatDate(item.startOn)} – ${formatDate(item.endOn)} · ${item.workingDays} hari kerja`,
      status: requestStatusLabel(item.status, item.hcTaskStatus),
      submittedAt: item.submittedAt,
    }));
    return [...annual, ...special]
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
      .slice(0, 4);
  }, [data]);

  return (
    <AppShell
      user={user}
      activeItem="Beranda"
    >
      <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold capitalize tracking-wide text-muted-foreground">{getDateLabel()}</p>
          <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-brand-heading sm:text-3xl">
            Assalamu&apos;alaikum, {firstName}.
          </h1>
        </div>
        {accessLabel ? (
          <div className="inline-flex w-fit items-center gap-2 rounded-xl border border-brand-yellow/35 bg-brand-yellow/12 px-3 py-2 text-xs font-semibold text-amber-950">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" /> {accessLabel}
          </div>
        ) : null}
      </section>

      {error ? (
        <div className="mt-5 flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {error}
        </div>
      ) : null}

      {loading ? (
        <div className="mt-6 flex items-center gap-2 rounded-2xl border border-border/70 bg-white p-6 text-sm text-muted-foreground shadow-[var(--shadow-soft)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat beranda Anda...
        </div>
      ) : !data ? (
        <div className="mt-6 rounded-2xl border border-border/70 bg-white p-6 text-sm text-muted-foreground shadow-[var(--shadow-soft)]">
          Beranda belum dapat ditampilkan. Muat ulang halaman setelah koneksi tersedia kembali.
        </div>
      ) : (
        <>
          <section className="mt-6 grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
            <article className="order-1 rounded-2xl border border-border/75 bg-white p-4 shadow-[var(--shadow-soft)] sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Hari ini</p>
                  <h2 className="mt-1 text-lg font-bold text-brand-heading">Kehadiran</h2>
                </div>
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-cyan/14 text-cyan-900">
                  <Clock3 className="h-5 w-5" aria-hidden="true" />
                </span>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-brand-primary-pale px-2.5 py-1 text-[11px] font-bold text-brand-primary-deep">
                  {attendanceStatusLabel(data.attendance.result?.status ?? data.attendance.schedule.state)}
                </span>
                {data.attendance.schedule.scheduledStartAt ? (
                  <span className="text-[11px] font-semibold text-muted-foreground">
                    Jadwal {formatTime(data.attendance.schedule.scheduledStartAt)}–{formatTime(data.attendance.schedule.scheduledEndAt)}
                  </span>
                ) : null}
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 sm:mt-5">
                <div className="rounded-xl bg-surface p-3 sm:rounded-2xl sm:p-4">
                  <p className="text-xs font-semibold text-muted-foreground">Masuk</p>
                  <p className="mt-1 text-2xl font-bold text-brand-heading">{formatTime(data.attendance.result?.firstCheckInAt ?? null)}</p>
                </div>
                <div className="rounded-xl bg-surface p-3 sm:rounded-2xl sm:p-4">
                  <p className="text-xs font-semibold text-muted-foreground">Pulang</p>
                  <p className="mt-1 text-2xl font-bold text-brand-heading">{formatTime(data.attendance.result?.lastCheckOutAt ?? null)}</p>
                </div>
              </div>

              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                {data.attendance.result
                  ? `Hasil canonical: kerja ${data.attendance.result.workedMinutes} menit · telat ${data.attendance.result.lateMinutes} menit · lembur disetujui ${data.attendance.result.overtimeMinutes} menit.`
                  : data.attendance.schedule.state === "scheduled"
                    ? "Jadwal hari ini sudah terbaca; belum ada hasil kehadiran yang dimaterialisasi."
                    : "Tidak ada hasil kehadiran aktif untuk hari ini."}
              </p>
              <a href="/app/attendance" className="mt-4 inline-flex min-h-10 items-center gap-2 text-sm font-bold text-brand-primary-deep">
                Lihat kehadiran <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </article>

            <section className="order-2 lg:order-3 lg:col-span-2 lg:mt-2">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Akses cepat</p>
                  <h2 className="mt-1 text-lg font-bold text-brand-heading">Apa yang ingin Anda lakukan?</h2>
                </div>
                <a href="/app/services" className="hidden text-xs font-bold text-brand-primary-deep sm:inline">Semua layanan</a>
              </div>

              <div className="mt-3 grid grid-cols-4 gap-2 sm:gap-3">
                {[
                  ["Clock In/Out", "/app/attendance/clock", Clock3],
                  ["Cuti & Izin", "/app/leave", CalendarDays],
                  ["Slip Gaji", "/app/payslips", WalletCards],
                  ["Lainnya", "/app/services", Grid2X2],
                ].map(([label, href, Icon]) => {
                  const TileIcon = Icon as typeof Clock3;
                  return (
                    <a key={String(label)} href={String(href)} className="flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-2xl border border-border/70 bg-white px-1.5 py-2.5 text-center shadow-[var(--shadow-soft)] sm:min-h-24 sm:gap-2 sm:px-2 sm:py-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-primary-pale text-brand-primary-deep sm:h-10 sm:w-10">
                        <TileIcon className="h-5 w-5" aria-hidden="true" />
                      </span>
                      <span className="text-[10px] font-bold leading-4 text-brand-heading sm:text-xs">{String(label)}</span>
                    </a>
                  );
                })}
              </div>
            </section>

            <article className={totalActions > 0 ? "order-3 rounded-2xl border border-brand-yellow/40 bg-brand-yellow/10 p-4 sm:p-5 lg:order-2" : "order-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 sm:p-5 lg:order-2"}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Perlu tindakan</p>
                  <p className="mt-2 text-3xl font-bold text-brand-heading">{totalActions}</p>
                </div>
                {totalActions > 0 ? <ClipboardCheck className="h-5 w-5 text-amber-900" aria-hidden="true" /> : <CheckCircle2 className="h-5 w-5 text-emerald-800" aria-hidden="true" />}
              </div>
              {totalActions > 0 ? (
                <div className="mt-4 space-y-2 text-sm">
                  {pendingEmployeeResolution > 0 ? <a href="/app/attendance-resolution" className="flex items-center justify-between font-semibold text-brand-heading"><span>{pendingEmployeeResolution} tindak lanjut kehadiran</span><ArrowRight className="h-4 w-4" /></a> : null}
                  {needsCompletion > 0 ? <a href="/app/leave/special" className="flex items-center justify-between font-semibold text-brand-heading"><span>{needsCompletion} dokumen cuti perlu dilengkapi</span><ArrowRight className="h-4 w-4" /></a> : null}
                  {pendingApprovals > 0 ? <a href="/app/approvals" className="flex items-center justify-between font-semibold text-brand-heading"><span>{pendingApprovals} persetujuan menunggu</span><ArrowRight className="h-4 w-4" /></a> : null}
                </div>
              ) : (
                <p className="mt-3 text-sm leading-6 text-emerald-900">Tidak ada hal yang perlu Anda tindaklanjuti saat ini.</p>
              )}
            </article>
          </section>

          <section className="mt-7 grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
            <article className="rounded-2xl border border-border/75 bg-white p-5 shadow-[var(--shadow-soft)]">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Cuti tahunan</p>
                  {employee?.leaveEntitlementGroup === "non_education" ? (
                    <>
                      <p className="mt-2 text-3xl font-bold text-brand-heading">{annualView?.availableNowDays ?? 0} <span className="text-sm font-semibold text-muted-foreground">hari tersedia</span></p>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">
                        {currentPeriod ? `${currentPeriod.label} · ${currentPeriod.remainingDays} dari 3 hari belum digunakan` : "Belum masuk periode yang dapat digunakan."}
                      </p>
                    </>
                  ) : employee?.leaveEntitlementGroup === "education" ? (
                    <>
                      <p className="mt-2 text-base font-bold text-brand-heading">Kalender akademik</p>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">Hak tahunan dipenuhi melalui Cuti Akhir Semester dan Akhir Tahun Pelajaran.</p>
                    </>
                  ) : (
                    <p className="mt-2 text-sm font-semibold text-amber-900">Kelompok hak cuti belum dikonfigurasi.</p>
                  )}
                </div>
                <CalendarDays className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
              </div>
              <a href="/app/leave" className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-brand-primary-deep">Buka Cuti & Izin <ArrowRight className="h-4 w-4" /></a>
            </article>

            <article className="overflow-hidden rounded-2xl border border-border/75 bg-white shadow-[var(--shadow-soft)]">
              <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Aktivitas terbaru</p>
                  <h2 className="mt-1 text-base font-bold text-brand-heading">Pengajuan saya</h2>
                </div>
                <a href="/app/leave" className="text-xs font-bold text-brand-primary-deep">Lihat semua</a>
              </div>
              <div className="divide-y divide-border/70">
                {latestRequests.length === 0 ? (
                  <p className="px-5 py-7 text-sm text-muted-foreground">Belum ada pengajuan cuti atau izin.</p>
                ) : latestRequests.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-4 px-5 py-4">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-brand-heading">{item.name}</p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{item.detail}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-surface px-3 py-1 text-[11px] font-semibold text-brand-heading">{item.status}</span>
                  </div>
                ))}
              </div>
            </article>
          </section>
        </>
      )}
    </AppShell>
  );
}
