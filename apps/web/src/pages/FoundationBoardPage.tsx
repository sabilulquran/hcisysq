import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Loader2,
  LogOut,
  ShieldCheck,
  UserRoundCheck,
  UsersRound,
  WalletCards,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { BrandLockup } from "@/components/BrandLockup";
import { logout } from "@/lib/auth";
import {
  BoardDashboardApiError,
  getBoardDashboard,
  type BoardDashboardData,
} from "@/lib/boardDashboard";

function percent(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}

function generatedLabel(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

export function FoundationBoardPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<BoardDashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        setData(await getBoardDashboard());
        setError(null);
      } catch (cause) {
        setError(
          cause instanceof BoardDashboardApiError
            ? cause.message
            : "Dashboard Organ Yayasan tidak dapat dimuat.",
        );
      }
    };
    void load();
  }, []);

  const handleLogout = async () => {
    try {
      await logout();
    } finally {
      await navigate({ to: "/" });
    }
  };

  const managerCoverage = data
    ? percent(data.approvalReadiness.withDirectManager, data.approvalReadiness.activeEmployees)
    : 0;
  const unitApproverCoverage = data
    ? percent(data.approvalReadiness.unitsWithApprover, data.approvalReadiness.activeUnits)
    : 0;
  const entitlementCoverage = data
    ? percent(
        data.entitlementGroups.education + data.entitlementGroups.nonEducation,
        data.employees.active,
      )
    : 0;

  const topUnits = useMemo(() => data?.unitDistribution.slice(0, 8) ?? [], [data]);
  const maxUnitCount = topUnits[0]?.employeeCount ?? 1;

  return (
    <div className="min-h-screen bg-surface text-foreground">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-surface-raised/95 px-4 py-3 backdrop-blur sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <BrandLockup compact />
            <span className="hidden truncate border-l border-border pl-3 text-[11px] font-semibold text-muted-foreground sm:inline">Organ Yayasan</span>
          </div>
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface-raised px-3.5 text-xs font-bold text-muted-foreground"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" /> Keluar
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 pb-10 pt-6 sm:px-6 sm:pt-8 lg:px-8">
        <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Ringkasan organisasi</p>
            <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-brand-heading sm:text-3xl">Dashboard Organ Yayasan</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Ringkasan agregat Human Capital untuk kebutuhan governance. Tidak menampilkan data pribadi pegawai atau dokumen cuti.
            </p>
          </div>
          {data ? (
            <p className="text-xs text-muted-foreground">Diperbarui {generatedLabel(data.generatedAt)}</p>
          ) : null}
        </section>

        {error ? (
          <div className="mt-5 flex gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {error}
          </div>
        ) : null}

        {!data ? (
          <div className="mt-6 flex items-center gap-2 rounded-3xl border border-border/70 bg-surface-raised p-6 text-sm text-muted-foreground shadow-[var(--shadow-soft)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat data organisasi...
          </div>
        ) : (
          <>
            <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <article className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
                <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-primary-pale text-brand-primary-deep">
                  <UsersRound className="h-5 w-5" aria-hidden="true" />
                </span>
                <p className="mt-5 text-3xl font-bold text-brand-heading">{data.employees.active}</p>
                <p className="mt-1 text-sm font-bold text-brand-heading">Pegawai aktif</p>
                <p className="mt-1 text-xs text-muted-foreground">{data.employees.total} seluruh record employee master</p>
              </article>

              <article className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
                <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-cyan/14 text-info-ink">
                  <Building2 className="h-5 w-5" aria-hidden="true" />
                </span>
                <p className="mt-5 text-3xl font-bold text-brand-heading">{data.approvalReadiness.activeUnits}</p>
                <p className="mt-1 text-sm font-bold text-brand-heading">Unit dengan pegawai aktif</p>
                <p className="mt-1 text-xs text-muted-foreground">{data.approvalReadiness.unitsWithApprover} sudah memiliki Approver Unit</p>
              </article>

              <article className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
                <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-yellow/16 text-warning-ink">
                  <CalendarDays className="h-5 w-5" aria-hidden="true" />
                </span>
                <p className="mt-5 text-3xl font-bold text-brand-heading">{data.workflow.leaveInReview}</p>
                <p className="mt-1 text-sm font-bold text-brand-heading">Cuti dalam proses</p>
                <p className="mt-1 text-xs text-muted-foreground">{data.workflow.hcValidationPending} menunggu validasi HC</p>
              </article>

              <article className={`rounded-3xl border p-5 shadow-[var(--shadow-soft)] ${data.workflow.attendanceResolutionOpen > 0 ? "border-warning-line bg-warning-soft" : "border-border/75 bg-surface-raised"}`}>
                <span className={`flex h-10 w-10 items-center justify-center rounded-2xl ${data.workflow.attendanceResolutionOpen > 0 ? "bg-warning-soft text-warning-ink" : "bg-success-soft text-success-ink"}`}>
                  {data.workflow.attendanceResolutionOpen > 0 ? <Clock3 className="h-5 w-5" aria-hidden="true" /> : <CheckCircle2 className="h-5 w-5" aria-hidden="true" />}
                </span>
                <p className="mt-5 text-3xl font-bold text-brand-heading">{data.workflow.attendanceResolutionOpen}</p>
                <p className="mt-1 text-sm font-bold text-brand-heading">Ketidakhadiran belum selesai</p>
                <p className="mt-1 text-xs text-muted-foreground">Kasus administrasi yang masih perlu penyelesaian</p>
              </article>
            </section>

            <section className="mt-4 grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
              <article className="rounded-[2rem] border border-border/80 bg-surface-raised p-5 shadow-[var(--shadow-raised)] sm:p-6">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Kesiapan approval</p>
                    <h2 className="mt-1 text-lg font-bold text-brand-heading">Konfigurasi organisasi</h2>
                  </div>
                  <ShieldCheck className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
                </div>

                <div className="mt-5 space-y-5">
                  <div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-brand-heading">Atasan langsung pegawai aktif</span>
                      <span className="font-bold text-brand-heading">{managerCoverage}%</span>
                    </div>
                    <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-brand-primary" style={{ width: `${managerCoverage}%` }} />
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">{data.approvalReadiness.withDirectManager} terisi · {data.approvalReadiness.withoutDirectManager} belum terisi</p>
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-brand-heading">Approver Unit</span>
                      <span className="font-bold text-brand-heading">{unitApproverCoverage}%</span>
                    </div>
                    <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-brand-primary" style={{ width: `${unitApproverCoverage}%` }} />
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">{data.approvalReadiness.unitsWithApprover} unit terisi · {data.approvalReadiness.unitsWithoutApprover} belum terisi</p>
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-brand-heading">Klasifikasi pendidikan/non-pendidikan</span>
                      <span className="font-bold text-brand-heading">{entitlementCoverage}%</span>
                    </div>
                    <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-brand-primary" style={{ width: `${entitlementCoverage}%` }} />
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">{data.entitlementGroups.unclassified} pegawai aktif belum diklasifikasikan</p>
                  </div>
                </div>
              </article>

              <article className="rounded-[2rem] border border-border/80 bg-surface-raised p-5 shadow-[var(--shadow-raised)] sm:p-6">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Komposisi hak cuti</p>
                    <h2 className="mt-1 text-lg font-bold text-brand-heading">Kelompok pegawai aktif</h2>
                  </div>
                  <UserRoundCheck className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
                </div>
                <div className="mt-5 grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                  <div className="rounded-2xl bg-surface p-4">
                    <p className="text-2xl font-bold text-brand-heading">{data.entitlementGroups.education}</p>
                    <p className="mt-1 text-xs font-semibold text-muted-foreground">Tenaga pendidikan</p>
                  </div>
                  <div className="rounded-2xl bg-surface p-4">
                    <p className="text-2xl font-bold text-brand-heading">{data.entitlementGroups.nonEducation}</p>
                    <p className="mt-1 text-xs font-semibold text-muted-foreground">Non-pendidikan</p>
                  </div>
                  <div className="rounded-2xl bg-surface p-4">
                    <p className="text-2xl font-bold text-brand-heading">{data.entitlementGroups.unclassified}</p>
                    <p className="mt-1 text-xs font-semibold text-muted-foreground">Belum diklasifikasikan</p>
                  </div>
                </div>
              </article>
            </section>

            <section className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
              <article className="rounded-[2rem] border border-border/80 bg-surface-raised p-5 shadow-[var(--shadow-raised)] sm:p-6">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Distribusi unit</p>
                  <h2 className="mt-1 text-lg font-bold text-brand-heading">Pegawai aktif per unit</h2>
                </div>
                <div className="mt-5 space-y-3">
                  {topUnits.map((unit) => (
                    <div key={unit.unitName}>
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <span className="truncate font-semibold text-brand-heading">{unit.unitName}</span>
                        <span className="shrink-0 font-bold text-brand-heading">{unit.employeeCount}</span>
                      </div>
                      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-brand-primary" style={{ width: `${Math.max(4, Math.round((unit.employeeCount / maxUnitCount) * 100))}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
                {data.unitDistribution.length > topUnits.length ? (
                  <p className="mt-4 text-[11px] text-muted-foreground">Menampilkan 8 unit dengan pegawai aktif terbanyak dari {data.unitDistribution.length} unit.</p>
                ) : null}
              </article>

              <article className="rounded-[2rem] border border-border/80 bg-surface-raised p-5 shadow-[var(--shadow-raised)] sm:p-6">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Status kepegawaian</p>
                <h2 className="mt-1 text-lg font-bold text-brand-heading">Komposisi pegawai aktif</h2>
                <div className="mt-5 divide-y divide-border/70">
                  {data.employmentStatus.map((item) => (
                    <div key={item.employmentStatus} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                      <span className="text-sm font-semibold text-brand-heading">{item.employmentStatus}</span>
                      <span className="rounded-full bg-surface px-3 py-1 text-xs font-bold text-brand-heading">{item.employeeCount}</span>
                    </div>
                  ))}
                </div>
              </article>
            </section>

            <section className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <article className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Pergerakan tahun ini</p>
                <p className="mt-3 text-2xl font-bold text-brand-heading">{data.movements.startedThisYear}</p>
                <p className="mt-1 text-xs text-muted-foreground">Tanggal mulai kerja tercatat tahun ini</p>
              </article>
              <article className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Pergerakan tahun ini</p>
                <p className="mt-3 text-2xl font-bold text-brand-heading">{data.movements.endedThisYear}</p>
                <p className="mt-1 text-xs text-muted-foreground">Tanggal akhir kerja tercatat tahun ini</p>
              </article>
              <article className="rounded-3xl border border-dashed border-border bg-surface-raised p-5">
                <Clock3 className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                <p className="mt-3 text-sm font-bold text-brand-heading">Kehadiran organisasi</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Belum terhubung. Tidak ada persentase kehadiran sintetis.</p>
              </article>
              <article className="rounded-3xl border border-dashed border-border bg-surface-raised p-5">
                <WalletCards className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                <p className="mt-3 text-sm font-bold text-brand-heading">Ringkasan payroll</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Belum terhubung. Tidak ada nominal payroll sintetis.</p>
              </article>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
