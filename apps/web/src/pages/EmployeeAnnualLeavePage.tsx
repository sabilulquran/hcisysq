import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { CriticalPeriodNotice } from "@/components/leave/CriticalPeriodNotice";
import { WizardDone } from "@/components/wizard/WizardDone";
import { WizardSteps } from "@/components/wizard/WizardSteps";
import { AppShell } from "@/layouts/AppShell";
import {
  EmployeeLeaveApiError,
  getEmployeeLeaveSummary,
  previewAnnualLeave,
  submitAnnualLeave,
  type AnnualLeavePreview,
  type EmployeeLeaveSummary,
} from "@/lib/employeeLeave";
import { useWizardStep } from "@/lib/useWizardStep";

const STEPS = ["isi", "periksa", "selesai"] as const;
const STEP_LABELS = ["Isi tanggal", "Periksa", "Selesai"] as const;

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
  }).format(new Date(`${value}T00:00:00`));
}

/** LEAVE-UX-001: pengajuan Cuti Tahunan sebagai wizard, satu langkah per layar. */
export function EmployeeAnnualLeavePage() {
  const { step, index, goTo } = useWizardStep(STEPS);
  const [summary, setSummary] = useState<EmployeeLeaveSummary | null>(null);
  const [startOn, setStartOn] = useState("");
  const [endOn, setEndOn] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<AnnualLeavePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setSummary(await getEmployeeLeaveSummary());
      } catch (cause) {
        setError(cause instanceof EmployeeLeaveApiError ? cause.message : "Data cuti tidak dapat dimuat.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Langkah lanjutan tidak boleh dibuka tanpa data langkah sebelumnya (mis. setelah refresh).
  useEffect(() => {
    if (step === "periksa" && !preview) goTo("isi", { replace: true });
    if (step === "selesai" && !success) goTo("isi", { replace: true });
  }, [step, preview, success, goTo]);

  const user = useMemo(() => {
    const employee = summary?.employee;
    return {
      name: employee?.fullName ?? "Pegawai",
      initials: initials(employee?.fullName ?? "P"),
      position: employee?.positionName ?? "Pegawai",
      unit: employee?.unitName ?? "Yayasan Sabilul Qur'an",
      ...(summary?.pendingApprovalCount ? { additionalRole: "Approver" } : {}),
    };
  }, [summary]);

  const group = summary?.employee.leaveEntitlementGroup;
  const canApply = group === "non_education";

  const showError = (message: string) => {
    setError(message);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handlePreview = async () => {
    setError(null);
    setPreview(null);
    if (!startOn || !endOn) {
      showError("Pilih tanggal mulai dan selesai terlebih dahulu.");
      return;
    }
    setBusy(true);
    try {
      setPreview(await previewAnnualLeave({ startOn, endOn, reason: reason || null }));
      goTo("periksa");
    } catch (cause) {
      showError(cause instanceof EmployeeLeaveApiError ? cause.message : "Pengajuan belum dapat diperiksa.");
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submitAnnualLeave({
        startOn,
        endOn,
        reason: reason || null,
        idempotencyKey: crypto.randomUUID(),
      });
      setSuccess(`Pengajuan ${result.workingDays} hari kerja berhasil dikirim dan menunggu persetujuan.`);
      setPreview(null);
      setStartOn("");
      setEndOn("");
      setReason("");
      goTo("selesai", { replace: true });
    } catch (cause) {
      showError(cause instanceof EmployeeLeaveApiError ? cause.message : "Pengajuan cuti tidak dapat dikirim.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell user={user} activeItem="Cuti & Izin">
      <a href="/app/leave" className="inline-flex items-center gap-2 text-sm font-semibold text-brand-primary-deep">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Cuti & Izin
      </a>
      <h1 className="mt-3 text-2xl font-bold tracking-[-0.02em] text-brand-heading sm:text-[1.75rem]">
        Ajukan Cuti Tahunan
      </h1>

      <WizardSteps steps={STEP_LABELS} current={index} />

      {error ? (
        <div role="alert" className="mt-5 flex gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      ) : null}

      {step === "isi" ? (
        <section className="mt-5 rounded-3xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)] sm:p-6">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat hak cuti...
            </div>
          ) : group === "education" ? (
            <p className="rounded-2xl bg-surface p-4 text-sm leading-6 text-muted-foreground">
              Anda terdaftar sebagai tenaga pendidikan. Pemenuhan hak tahunan mengikuti Cuti Akhir Semester & Akhir Tahun Pelajaran sesuai kalender akademik Yayasan.
            </p>
          ) : group === null ? (
            <p className="rounded-2xl border border-warning-line bg-warning-soft p-4 text-sm text-warning-ink">
              Kelompok hak cuti belum dikonfigurasi oleh Human Capital.
            </p>
          ) : (
            <>
              {summary?.annualLeave ? (
                <div className="rounded-2xl bg-brand-primary-pale/45 px-4 py-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-muted-foreground">Tersedia pada periode saat ini</p>
                    <p className="text-lg font-bold text-brand-heading">{summary.annualLeave.availableNowDays} hari</p>
                  </div>
                  {/*
                    LEAVE-003 R2: the employee is told the boundary before picking dates, because a
                    request that crosses one is refused rather than split.
                  */}
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {summary.annualLeave.quotaScheme === "SEMESTER"
                      ? `${summary.annualLeave.currentPeriodLimitDays} hari kerja per semester. Satu pengajuan harus berada dalam satu semester: tanggal yang melewati 30 Juni-1 Juli atau pergantian tahun diajukan terpisah.`
                      : `${summary.annualLeave.currentPeriodLimitDays} hari kerja per periode tiga bulan. Satu pengajuan harus berada dalam satu periode: tanggal setelah batas periode diajukan terpisah.`}
                  </p>
                </div>
              ) : null}
              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                Sistem akan memeriksa H-7, masa kerja, kuota periode, hari kerja, dan siapa yang perlu menyetujui.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-sm font-semibold">
                  Mulai cuti
                  <input
                    type="date"
                    value={startOn}
                    onChange={(event) => {
                      setStartOn(event.target.value);
                      setPreview(null);
                    }}
                    className="mt-2 h-11 w-full rounded-xl border border-border bg-surface-raised px-3 font-normal outline-none focus:border-brand-primary"
                  />
                </label>
                <label className="text-sm font-semibold">
                  Selesai cuti
                  <input
                    type="date"
                    value={endOn}
                    min={startOn || undefined}
                    onChange={(event) => {
                      setEndOn(event.target.value);
                      setPreview(null);
                    }}
                    className="mt-2 h-11 w-full rounded-xl border border-border bg-surface-raised px-3 font-normal outline-none focus:border-brand-primary"
                  />
                </label>
              </div>
              <label className="mt-4 block text-sm font-semibold">
                Keterangan <span className="font-normal text-muted-foreground">(opsional)</span>
                <textarea
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setPreview(null);
                  }}
                  rows={3}
                  maxLength={1000}
                  className="mt-2 w-full rounded-xl border border-border bg-surface-raised px-3 py-2.5 font-normal outline-none focus:border-brand-primary"
                />
              </label>
            </>
          )}

          <div className="mt-6 flex justify-end">
            <button
              type="button"
              disabled={busy || !canApply}
              onClick={() => void handlePreview()}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand-primary px-5 text-sm font-bold text-brand-foreground shadow-[var(--shadow-button)] disabled:opacity-50 sm:w-auto"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Lanjutkan
              {busy ? null : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
            </button>
          </div>
        </section>
      ) : null}

      {step === "periksa" && preview ? (
        <section className="mt-5 rounded-3xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)] sm:p-6">
          <h2 className="text-base font-bold text-brand-heading">Periksa sebelum dikirim</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDate(startOn)} – {formatDate(endOn)}
          </p>
          {reason ? <p className="mt-2 text-xs leading-5 text-muted-foreground">“{reason}”</p> : null}

          <div className="mt-4 grid grid-cols-3 gap-2">
            {[
              ["Hari kerja", preview.requestedWorkingDays],
              ["Tersedia sebelum", preview.availableDaysBeforeRequest],
              ["Tersisa setelah", preview.availableDaysAfterRequest],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl bg-surface p-3">
                <p className="text-[11px] leading-4 text-muted-foreground">{label}</p>
                <p className="mt-1 text-xl font-bold text-brand-heading">{value}</p>
              </div>
            ))}
          </div>

          <div className="mt-5">
            <p className="text-xs font-semibold text-muted-foreground">Alur persetujuan</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {preview.approvalChain.map((approver, position) => (
                <div key={approver.employeeId} className="flex items-center gap-2">
                  {position > 0 ? <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /> : null}
                  <span className="rounded-full bg-brand-primary-pale/60 px-3 py-1.5 text-xs font-semibold text-brand-heading">
                    {approver.name}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <CriticalPeriodNotice periods={preview.criticalPeriods} />

          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <button
              type="button"
              disabled={busy}
              onClick={() => goTo("isi")}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface-raised px-4 text-sm font-semibold disabled:opacity-50"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Ubah tanggal
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleSubmit()}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-brand-primary px-5 text-sm font-bold text-brand-foreground shadow-[var(--shadow-button)] disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
              Kirim pengajuan
            </button>
          </div>
        </section>
      ) : null}

      {step === "selesai" && success ? (
        <WizardDone title="Pengajuan terkirim" message={success}>
          <a
            href="/app/leave"
            className="inline-flex h-11 items-center justify-center rounded-xl bg-brand-primary px-5 text-sm font-bold text-brand-foreground"
          >
            Lihat status pengajuan
          </a>
        </WizardDone>
      ) : null}
    </AppShell>
  );
}
