import {
  CheckCircle2,
  FileText,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import {
  decidePlannedHcApproval,
  decidePlannedHcValidation,
  getPlannedHcApprovalQueue,
  getPlannedHcValidationQueue,
  getPlannedLeaveSummary,
  plannedHcEvidenceHref,
  PlannedLeaveApiError,
  type PlannedHcQueue,
  type PlannedLeaveSummary,
} from "@/lib/plannedLeave";

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
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(new Date(`${value}T00:00:00+07:00`));
}

export function HcPlannedLeavePage() {
  const [summary, setSummary] = useState<PlannedLeaveSummary | null>(null);
  const [validationQueue, setValidationQueue] = useState<PlannedHcQueue["items"]>([]);
  const [approvalQueue, setApprovalQueue] = useState<PlannedHcQueue["items"]>([]);
  const [canActualApprove, setCanActualApprove] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextSummary, validation] = await Promise.all([
        getPlannedLeaveSummary(),
        getPlannedHcValidationQueue(),
      ]);
      setSummary(nextSummary);
      setValidationQueue(validation.items);

      try {
        const approval = await getPlannedHcApprovalQueue();
        setApprovalQueue(approval.items);
        setCanActualApprove(true);
      } catch (cause) {
        if (cause instanceof PlannedLeaveApiError && cause.code === "HC_APPROVAL_FORBIDDEN") {
          setApprovalQueue([]);
          setCanActualApprove(false);
        } else {
          throw cause;
        }
      }
    } catch (cause) {
        setError(
        cause instanceof PlannedLeaveApiError
          ? cause.message
          : "Antrean Human Capital tidak dapat dimuat.",
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
      name: employee?.fullName ?? "Human Capital",
      initials: initials(employee?.fullName ?? "HC"),
      position: employee?.positionName ?? "Human Capital",
      unit: employee?.unitName ?? "Yayasan Sabilul Qur'an",
    };
  }, [summary]);

  const validate = async (taskId: string, requestCorrection: boolean) => {
    const note = requestCorrection
      ? window.prompt("Tuliskan dokumen atau informasi yang perlu dilengkapi:")?.trim() || null
      : null;
    if (requestCorrection && !note) return;
    setBusyTask(taskId);
    setError(null);
    setSuccess(null);
    try {
      await decidePlannedHcValidation(taskId, {
        action: requestCorrection ? "request_correction" : "validate",
        note,
      });
      setSuccess(
        requestCorrection
          ? "Permintaan kelengkapan sudah dikirim ke pegawai."
          : "Administrasi sudah divalidasi dan pengajuan selesai.",
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof PlannedLeaveApiError
          ? cause.message
          : "Hasil validasi tidak dapat disimpan.",
      );
    } finally {
      setBusyTask(null);
    }
  };

  const approve = async (taskId: string, decision: "approve" | "reject") => {
    const note =
      decision === "reject"
        ? window.prompt("Alasan penolakan (opsional):")?.trim() || null
        : null;
    setBusyTask(taskId);
    setError(null);
    setSuccess(null);
    try {
      await decidePlannedHcApproval(taskId, { decision, note });
      setSuccess(
        decision === "approve"
          ? "Cuti Tanpa Gaji disetujui oleh Human Capital."
          : "Cuti Tanpa Gaji ditolak oleh Human Capital.",
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof PlannedLeaveApiError
          ? cause.message
          : "Keputusan Human Capital tidak dapat disimpan.",
      );
    } finally {
      setBusyTask(null);
    }
  };

  return (
    <AppShell
      user={user}
      activeItem="Cuti Terencana"
    >
      <section>
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Human Capital</p>
        <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-brand-heading">Cuti terencana & tanpa gaji</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Pemeriksaan administrasi dan persetujuan Cuti Tanpa Gaji ditampilkan terpisah. Validasi dokumen bukan persetujuan diskresioner.
        </p>
      </section>

      {error ? (
        <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>
      ) : null}
      {success ? (
        <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{success}</div>
      ) : null}

      <section className="mt-5 overflow-hidden rounded-3xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-3 border-b border-border/70 px-5 py-4">
          <ShieldCheck className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
          <div>
            <h2 className="text-base font-bold text-brand-heading">Pemeriksaan administrasi</h2>
            <p className="text-xs text-muted-foreground">Pernikahan, menikahkan/khitan anak, dan Haji.</p>
          </div>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat antrean...
          </div>
        ) : validationQueue.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted-foreground">Tidak ada pemeriksaan administrasi yang menunggu.</p>
        ) : (
          <div className="divide-y divide-border/70">
            {validationQueue.map((item) => (
              <article key={item.taskId} className="p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-sm font-bold text-brand-heading">{item.requesterName} · {item.policyName}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDate(item.startOn)} – {formatDate(item.endOn)} · {item.workingDays} hari kerja · {item.validationSummary.calendarDurationDays ?? "—"} hari kalender
                    </p>
                    {item.evidence.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {item.evidence.map((evidence) => (
                          <a
                            key={evidence.id}
                            href={plannedHcEvidenceHref(item.requestId, evidence.id)}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-2 rounded-xl border border-border bg-white px-3 py-2 text-xs font-semibold"
                          >
                            <FileText className="h-4 w-4" aria-hidden="true" /> {evidence.fileName}
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busyTask === item.taskId}
                      onClick={() => void validate(item.taskId, true)}
                      className="inline-flex h-10 items-center rounded-xl border border-amber-300 bg-amber-50 px-4 text-xs font-bold text-amber-950 disabled:opacity-50"
                    >
                      Minta dilengkapi
                    </button>
                    <button
                      type="button"
                      disabled={busyTask === item.taskId}
                      onClick={() => void validate(item.taskId, false)}
                      className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-white disabled:opacity-50"
                    >
                      {busyTask === item.taskId ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                      Administrasi sesuai
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="mt-5 overflow-hidden rounded-3xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <div className="border-b border-border/70 px-5 py-4">
          <h2 className="text-base font-bold text-brand-heading">Persetujuan Cuti Tanpa Gaji</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Ini adalah keputusan Human Capital setelah Kepala Satuan Kerja / Unit Approver menyetujui.
          </p>
        </div>
        {!canActualApprove ? (
          <p className="px-5 py-8 text-sm text-muted-foreground">
            Akun ini memiliki akses validasi, tetapi tidak memiliki mandat actual approval Cuti Tanpa Gaji.
          </p>
        ) : approvalQueue.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted-foreground">Tidak ada Cuti Tanpa Gaji yang menunggu keputusan.</p>
        ) : (
          <div className="divide-y divide-border/70">
            {approvalQueue.map((item) => (
              <article key={item.taskId} className="p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="text-sm font-bold text-brand-heading">{item.requesterName}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDate(item.startOn)} – {formatDate(item.endOn)} · {item.workingDays} hari kerja · {item.validationSummary.calendarDurationDays ?? "—"} hari kalender
                    </p>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      Pengajuan ini dicatat sebagai tidak bergaji untuk downstream. Tidak ada perhitungan potongan payroll pada langkah ini.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busyTask === item.taskId}
                      onClick={() => void approve(item.taskId, "reject")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl border border-red-200 bg-white px-4 text-xs font-bold text-red-700 disabled:opacity-50"
                    >
                      <XCircle className="h-4 w-4" aria-hidden="true" /> Tolak
                    </button>
                    <button
                      type="button"
                      disabled={busyTask === item.taskId}
                      onClick={() => void approve(item.taskId, "approve")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-white disabled:opacity-50"
                    >
                      {busyTask === item.taskId ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                      Setujui
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}
