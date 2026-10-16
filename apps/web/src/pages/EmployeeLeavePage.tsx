import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Loader2,
  ShieldCheck,
  Stethoscope,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import {
  EmployeeLeaveApiError,
  getEmployeeLeaveSummary,
  previewAnnualLeave,
  submitAnnualLeave,
  type AnnualLeavePreview,
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
  return "Dalam persetujuan";
}

export function EmployeeLeavePage() {
  const [summary, setSummary] = useState<EmployeeLeaveSummary | null>(null);
  const [startOn, setStartOn] = useState("");
  const [endOn, setEndOn] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<AnnualLeavePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
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

  const handlePreview = async () => {
    setError(null);
    setSuccess(null);
    setPreview(null);
    if (!startOn || !endOn) {
      setError("Pilih tanggal mulai dan selesai terlebih dahulu.");
      return;
    }
    setPreviewing(true);
    try {
      setPreview(await previewAnnualLeave({ startOn, endOn, reason: reason || null }));
    } catch (cause) {
      setError(
        cause instanceof EmployeeLeaveApiError
          ? cause.message
          : "Pengajuan belum dapat diperiksa.",
      );
    } finally {
      setPreviewing(false);
    }
  };

  const handleSubmit = async () => {
    if (!preview) return;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await submitAnnualLeave({
        startOn,
        endOn,
        reason: reason || null,
        idempotencyKey: crypto.randomUUID(),
      });
      setSuccess(
        `Pengajuan ${result.workingDays} hari kerja berhasil dikirim dan menunggu persetujuan.`,
      );
      setPreview(null);
      setStartOn("");
      setEndOn("");
      setReason("");
      await load();
    } catch (cause) {
      setError(
        cause instanceof EmployeeLeaveApiError
          ? cause.message
          : "Pengajuan cuti tidak dapat dikirim.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const annual = summary?.annualLeave;
  const group = summary?.employee.leaveEntitlementGroup;

  return (
    <AppShell user={user} activeItem="Cuti & Izin">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            Cuti & izin
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-brand-heading sm:text-[1.75rem]">
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
          href="#annual-form"
          className="group rounded-3xl border border-brand-primary/25 bg-brand-primary-pale/45 p-4 shadow-[var(--shadow-soft)] transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-surface-raised text-brand-primary-deep shadow-sm">
              <CalendarDays className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-bold text-brand-heading">Cuti Tahunan</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Untuk tenaga non-pendidikan. Hak tetap ditampilkan 12 hari/tahun dengan batas pemakaian 3 hari per periode.
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

      <section className="mt-5 grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
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
              </div>
              <div className="grid grid-cols-2 gap-2">
                {annual.periods.map((period) => (
                  <div key={period.key} className="rounded-2xl border border-border/70 p-3">
                    <p className="text-xs font-semibold text-brand-heading">{period.label}</p>
                    <p className="mt-1 text-lg font-bold">{period.remainingDays}<span className="ml-1 text-xs font-medium text-muted-foreground">/ 3</span></p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
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
            </div>
          ) : null}
        </article>

        <article id="annual-form" className="scroll-mt-24 rounded-3xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)] sm:p-6">
          <h2 className="text-base font-bold text-brand-heading">Ajukan Cuti Tahunan</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Isi tanggal cuti. Sistem akan memeriksa H-7, masa kerja, kuota periode, hari kerja, dan siapa yang perlu menyetujui.
          </p>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-semibold">
              Mulai cuti
              <input
                type="date"
                value={startOn}
                onChange={(event) => {
                  setStartOn(event.target.value);
                  setPreview(null);
                }}
                disabled={group !== "non_education"}
                className="mt-2 h-11 w-full rounded-xl border border-border bg-surface-raised px-3 font-normal outline-none focus:border-brand-primary disabled:bg-muted"
              />
            </label>
            <label className="text-sm font-semibold">
              Selesai cuti
              <input
                type="date"
                value={endOn}
                onChange={(event) => {
                  setEndOn(event.target.value);
                  setPreview(null);
                }}
                disabled={group !== "non_education"}
                className="mt-2 h-11 w-full rounded-xl border border-border bg-surface-raised px-3 font-normal outline-none focus:border-brand-primary disabled:bg-muted"
              />
            </label>
          </div>
          <label className="mt-4 block text-sm font-semibold">
            Keterangan <span className="font-normal text-muted-foreground">(opsional)</span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={group !== "non_education"}
              rows={3}
              maxLength={1000}
              className="mt-2 w-full rounded-xl border border-border bg-surface-raised px-3 py-2.5 font-normal outline-none focus:border-brand-primary disabled:bg-muted"
            />
          </label>

          <button
            type="button"
            disabled={previewing || group !== "non_education"}
            onClick={() => void handlePreview()}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface-raised px-4 text-sm font-semibold hover:bg-muted/50 disabled:opacity-50"
          >
            {previewing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Clock3 className="h-4 w-4" aria-hidden="true" />}
            Lanjutkan
          </button>

          {preview ? (
            <div className="mt-5 rounded-2xl border border-brand-primary/20 bg-brand-primary-pale/45 p-4">
              <p className="text-sm font-bold text-brand-heading">Periksa sebelum dikirim</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">Hari kerja</p>
                  <p className="mt-1 text-lg font-bold text-brand-heading">{preview.requestedWorkingDays}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Tersedia sebelum</p>
                  <p className="mt-1 text-lg font-bold text-brand-heading">{preview.availableDaysBeforeRequest}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Tersisa setelah</p>
                  <p className="mt-1 text-lg font-bold text-brand-heading">{preview.availableDaysAfterRequest}</p>
                </div>
              </div>
              <div className="mt-4 border-t border-brand-primary/15 pt-4">
                <p className="text-xs font-semibold text-muted-foreground">Alur persetujuan</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {preview.approvalChain.map((step, index) => (
                    <div key={step.employeeId} className="flex items-center gap-2">
                      {index > 0 ? <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /> : null}
                      <span className="rounded-full bg-surface-raised px-3 py-1.5 text-xs font-semibold text-brand-heading shadow-sm">
                        {step.name}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleSubmit()}
                className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-primary px-5 text-sm font-bold text-brand-foreground shadow-[var(--shadow-button)] disabled:opacity-60"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                Kirim pengajuan
              </button>
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
                </div>
                <span className="w-fit rounded-full bg-muted px-3 py-1 text-xs font-semibold">
                  {statusLabel(item.status)}
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </AppShell>
  );
}
