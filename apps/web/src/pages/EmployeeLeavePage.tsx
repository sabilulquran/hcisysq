import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  Stethoscope,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { CancelLeaveRequest } from "@/components/leave/CancelLeaveRequest";
import { PostponementResponse } from "@/components/leave/PostponementResponse";
import { postponementStatusNote } from "@/lib/leavePostponementView";
import { AppShell } from "@/layouts/AppShell";
import {
  EmployeeLeaveApiError,
  annualQuotaHint,
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

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(new Date(`${value}T00:00:00+07:00`));
}

function statusLabel(status: string) {
  if (status === "approved") return "Disetujui";
  if (status === "rejected") return "Ditolak";
  if (status === "cancelled") return "Dibatalkan";
  if (status === "postponement_proposed") return "Menunggu respons Anda";
  if (status === "postponed") return "Ditangguhkan";
  return "Dalam persetujuan";
}

export function EmployeeLeavePage() {
  const [summary, setSummary] = useState<EmployeeLeaveSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setSummary(await getEmployeeLeaveSummary());
    } catch (cause) {
      setError(
        cause instanceof EmployeeLeaveApiError
          ? cause.message
          : "Data cuti tidak dapat dimuat.",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const user = useMemo(() => {
    const employee = summary?.employee;
    return {
      name: employee?.fullName ?? "Pegawai",
      initials: initials(employee?.fullName ?? "P"),
      position: employee?.positionName ?? "Pegawai",
      unit: employee?.unitName ?? "Yayasan Sabilul Qur'an",
      ...(summary?.pendingApprovalCount
        ? { additionalRole: "Approver" }
        : {}),
    };
  }, [summary]);

  const annual = summary?.annualLeave;
  const group = summary?.employee.leaveEntitlementGroup;

  return (
    <AppShell user={user} activeItem="Cuti & Izin">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="sq-eyebrow text-muted-foreground">
            Cuti & izin
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-brand-heading sm:text-3xl">
            Apa yang Anda butuhkan?
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Pilih jenis kebutuhan terlebih dahulu. Sistem akan menampilkan langkah yang relevan saja.
          </p>
        </div>
        {(summary?.pendingApprovalCount ?? 0) > 0 ? (
          <a
            href="/app/approvals"
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-brand-yellow/40 bg-brand-yellow/12 px-4 text-sm font-semibold text-warning-ink"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            {summary?.pendingApprovalCount} persetujuan menunggu
          </a>
        ) : null}
      </section>

      <section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <a
          href="/app/leave/annual"
          className="group rounded-3xl border border-brand-primary/25 bg-brand-primary-pale/45 p-4 shadow-[var(--shadow-soft)] transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-surface-raised text-brand-primary-deep shadow-sm">
              <CalendarDays className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-bold text-brand-heading">Cuti Tahunan</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Untuk tenaga non-pendidikan. Hak tetap ditampilkan 12 hari/tahun dengan batas pemakaian per periode kuota.
              </p>
              <p className="mt-2 text-xs font-bold text-brand-primary-deep">Ajukan cuti tahunan →</p>
            </div>
          </div>
        </a>

        <a
          href="/app/leave/special"
          className="group rounded-3xl border border-border/70 bg-surface-raised p-4 shadow-[var(--shadow-soft)] transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-cyan/14 text-info-ink">
              <Stethoscope className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-bold text-brand-heading">Sakit atau kondisi khusus</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Sakit, melahirkan, keguguran, haid, pendampingan istri, atau keluarga meninggal dunia.
              </p>
              <p className="mt-2 text-xs font-bold text-brand-primary-deep">Laporkan kondisi →</p>
            </div>
          </div>
        </a>

        <a
          href="/app/leave/planned"
          className="group rounded-3xl border border-border/70 bg-surface-raised p-4 shadow-[var(--shadow-soft)] transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-yellow/15 text-warning-ink">
              <CalendarDays className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-bold text-brand-heading">Keperluan terencana</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Pernikahan, menikahkan atau khitan anak, Haji wajib, dan Cuti Tanpa Gaji.
              </p>
              <p className="mt-2 text-xs font-bold text-brand-primary-deep">Pilih keperluan →</p>
            </div>
          </div>
        </a>
      </section>

      {error ? (
        <div className="mt-5 flex gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="mt-5 flex gap-3 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {success}
        </div>
      ) : null}

      <section className="mt-5">
        <article className="rounded-3xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold text-muted-foreground">Hak Cuti Tahunan</p>
              <p className="mt-2 text-3xl font-bold text-brand-heading">12 hari</p>
              <p className="mt-1 text-xs text-muted-foreground">per tahun</p>
            </div>
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-primary-pale text-brand-primary-deep">
              <CalendarDays className="h-5 w-5" aria-hidden="true" />
            </span>
          </div>

          {loading ? (
            <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat hak cuti...
            </div>
          ) : group === "education" ? (
            <div className="mt-6 rounded-2xl bg-surface p-4 text-sm leading-6 text-muted-foreground">
              Anda terdaftar sebagai tenaga pendidikan. Pemenuhan hak tahunan mengikuti Cuti Akhir Semester & Akhir Tahun Pelajaran sesuai kalender akademik Yayasan.
            </div>
          ) : group === null ? (
            <div className="mt-6 rounded-2xl border border-warning-line bg-warning-soft p-4 text-sm text-warning-ink">
              Kelompok hak cuti belum dikonfigurasi oleh Human Capital.
            </div>
          ) : annual ? (
            <div className="mt-6 space-y-4">
              <div className="rounded-2xl bg-surface p-4">
                <p className="text-xs text-muted-foreground">Hak dapat digunakan sejak</p>
                <p className="mt-1 text-sm font-bold text-brand-heading">{formatDate(annual.eligibleFrom)}</p>
                <p className="mt-3 text-xs text-muted-foreground">Tersedia pada periode saat ini</p>
                <p className="mt-1 text-2xl font-bold text-brand-heading">{annual.availableNowDays} hari</p>
                {/*
                  LEAVE-003 R2: the rule reads off the API, never off a number typed here, and it
                  names the day the rule changes rather than letting today's rule speak for dates
                  after it — enforcement follows the leave date.
                */}
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  Batas pemakaian{" "}
                  {annualQuotaHint({
                    quotaScheme: annual.quotaScheme,
                    periodLimitDays: annual.currentPeriodLimitDays,
                    semesterEffectiveFrom: annual.semesterEffectiveFrom,
                    referenceDate: summary?.referenceDate,
                  })}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {annual.periods.map((period) => (
                  <div key={period.key} className="rounded-2xl border border-border/70 p-3">
                    <p className="text-xs font-semibold text-brand-heading">{period.label}</p>
                    <p className="mt-1 text-lg font-bold">{period.remainingDays}<span className="ml-1 text-xs font-medium text-muted-foreground">/ {period.allocationDays}</span></p>
                    <p className="mt-1 text-2xs text-muted-foreground">

                      {period.status === "not_eligible"
                        ? "Belum dapat digunakan"
                        : period.status === "current"
                          ? "Periode berjalan"
                          : period.status === "closed"
                            ? "Periode selesai"
                            : "Periode berikutnya"}
                    </p>
                  </div>
                ))}
              </div>
              <a
                href="/app/leave/annual"
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand-primary px-5 text-sm font-bold text-brand-foreground shadow-[var(--shadow-button)] sm:w-auto"
              >
                Ajukan Cuti Tahunan <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
          ) : null}
        </article>

      </section>

      <section className="mt-5 overflow-hidden rounded-3xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <div className="border-b border-border/70 px-5 py-4">
          <h2 className="text-base font-bold text-brand-heading">Riwayat Cuti Tahunan</h2>
        </div>
        <div className="divide-y divide-border/70">
          {(summary?.requests ?? []).length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted-foreground">Belum ada pengajuan Cuti Tahunan.</p>
          ) : (
            summary?.requests.map((item) => (
              <div key={item.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-brand-heading">
                    {formatDate(item.startOn)} – {formatDate(item.endOn)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.workingDays} hari kerja
                    {item.currentApproverName ? ` · menunggu ${item.currentApproverName}` : ""}
                  </p>
                  {postponementStatusNote(item) ? (
                    <p className="mt-1 text-xs font-semibold text-brand-primary-deep">{postponementStatusNote(item)}</p>
                  ) : null}
                  {item.canRespondToPostponement && item.postponement ? (
                    <PostponementResponse
                      postponement={item.postponement}
                      onDone={(outcome) => {
                        if (outcome.ok) {
                          setError(null);
                          setSuccess(outcome.message);
                        } else {
                          setSuccess(null);
                          setError(outcome.message);
                        }
                        void load();
                      }}
                    />
                  ) : null}
                </div>
                <div className="flex flex-col items-start gap-2 sm:items-end">
                  <span className="w-fit rounded-full bg-muted px-3 py-1 text-xs font-semibold">
                    {statusLabel(item.status)}
                  </span>
                  {item.canCancel ? (
                    <CancelLeaveRequest
                      requestId={item.id}
                      onDone={(outcome) => {
                        if (outcome.ok) {
                          setError(null);
                          setSuccess("Pengajuan Cuti Tahunan dibatalkan.");
                        } else {
                          setSuccess(null);
                          setError(outcome.message);
                        }
                        void load();
                      }}
                    />
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </AppShell>
  );
}
