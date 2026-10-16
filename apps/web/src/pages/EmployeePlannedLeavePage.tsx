import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileUp,
  Loader2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import {
  getPlannedLeaveSummary,
  PlannedLeaveApiError,
  previewPlannedLeave,
  submitPlannedLeave,
  type PlannedLeaveEvidenceInput,
  type PlannedLeavePreview,
  type PlannedLeaveSummary,
  type SupportedPlannedLeaveKey,
  uploadPlannedLeaveEvidence,
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

function helper(key: SupportedPlannedLeaveKey) {
  const labels: Record<SupportedPlannedLeaveKey, string> = {
    employee_marriage: "Pernikahan pegawai, maksimal 3 hari kerja.",
    child_marriage: "Menikahkan anak, maksimal 2 hari kerja.",
    child_circumcision: "Khitan anak, maksimal 2 hari kerja.",
    hajj: "Ibadah Haji wajib dengan dokumen resmi; hak digunakan satu kali selama bekerja.",
    unpaid: "Cuti Tanpa Gaji. Durasi sampai 3 hari kalender memakai H-7; lebih dari 3 hari kalender memakai H-30.",
  };
  return labels[key];
}

async function fileToEvidence(file: File): Promise<PlannedLeaveEvidenceInput> {
  if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type)) {
    throw new Error("Gunakan PDF, JPG, atau PNG.");
  }
  if (file.size > 2 * 1024 * 1024) {
    throw new Error("Ukuran file maksimal 2 MB.");
  }
  const contentBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("File tidak dapat dibaca."));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const comma = value.indexOf(",");
      if (comma < 0) reject(new Error("File tidak dapat dibaca."));
      else resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
  return {
    fileName: file.name,
    contentType: file.type as PlannedLeaveEvidenceInput["contentType"],
    contentBase64,
  };
}

export function EmployeePlannedLeavePage() {
  const [summary, setSummary] = useState<PlannedLeaveSummary | null>(null);
  const [policyKey, setPolicyKey] = useState<SupportedPlannedLeaveKey | null>(null);
  const [startOn, setStartOn] = useState("");
  const [endOn, setEndOn] = useState("");
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PlannedLeavePreview | null>(null);
  const [correctionFiles, setCorrectionFiles] = useState<Record<string, File | null>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setSummary(await getPlannedLeaveSummary());
    } catch (cause) {
      setError(
        cause instanceof PlannedLeaveApiError
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
    };
  }, [summary]);

  const selectedPolicy = policyKey
    ? summary?.policies.find((policy) => policy.key === policyKey) ?? null
    : null;

  const choosePolicy = (key: SupportedPlannedLeaveKey) => {
    setPolicyKey(key);
    setStartOn("");
    setEndOn("");
    setReason("");
    setFile(null);
    setPreview(null);
    setError(null);
    setSuccess(null);
  };

  const handlePreview = async () => {
    if (!policyKey || !startOn || !endOn) {
      setError("Pilih jenis cuti dan tanggal terlebih dahulu.");
      return;
    }
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(
        await previewPlannedLeave({
          policyKey,
          startOn,
          endOn,
          hasEvidence: file !== null,
        }),
      );
    } catch (cause) {
      setError(
        cause instanceof PlannedLeaveApiError
          ? cause.message
          : "Pengajuan belum dapat diperiksa.",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async () => {
    if (!preview || !policyKey) return;
    setBusy(true);
    setError(null);
    try {
      const evidence = file ? await fileToEvidence(file) : null;
      const result = await submitPlannedLeave({
        policyKey,
        startOn,
        endOn,
        reason: reason || null,
        idempotencyKey: crypto.randomUUID(),
        evidence,
      });
      setSuccess(`${result.policyName} berhasil dikirim. ${result.nextAction}.`);
      setPolicyKey(null);
      setStartOn("");
      setEndOn("");
      setReason("");
      setFile(null);
      setPreview(null);
      await load();
    } catch (cause) {
      setError(
        cause instanceof PlannedLeaveApiError || cause instanceof Error
          ? cause.message
          : "Pengajuan tidak dapat dikirim.",
      );
    } finally {
      setBusy(false);
    }
  };

  const completeEvidence = async (requestId: string) => {
    const correctionFile = correctionFiles[requestId];
    if (!correctionFile) {
      setError("Pilih dokumen tambahan terlebih dahulu.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await uploadPlannedLeaveEvidence(requestId, await fileToEvidence(correctionFile));
      setCorrectionFiles((current) => ({ ...current, [requestId]: null }));
      setSuccess("Dokumen tambahan sudah dikirim. Human Capital akan memeriksa kembali.");
      await load();
    } catch (cause) {
      setError(
        cause instanceof PlannedLeaveApiError || cause instanceof Error
          ? cause.message
          : "Dokumen tambahan tidak dapat dikirim.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell user={user} activeItem="Cuti & Izin">
      <div className="mb-5">
        <a href="/app/leave" className="inline-flex items-center gap-2 text-sm font-semibold text-brand-primary-deep">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Kembali ke Cuti & Izin
        </a>
      </div>

      <section>
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Cuti & izin</p>
        <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-brand-heading sm:text-[1.75rem]">
          Keperluan terencana & Cuti Tanpa Gaji
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Pilih keperluan, cek dampak hari kerja dan durasi kalender, lalu kirim dokumen yang diperlukan.
        </p>
      </section>

      {error ? (
        <div className="mt-5 flex gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {error}
        </div>
      ) : null}
      {success ? (
        <div className="mt-5 flex gap-3 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {success}
        </div>
      ) : null}

      <section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {(summary?.policies ?? []).map((policy) => (
          <button
            type="button"
            key={policy.key}
            onClick={() => choosePolicy(policy.key)}
            className={`rounded-3xl border p-4 text-left shadow-[var(--shadow-soft)] ${
              policyKey === policy.key
                ? "border-brand-primary bg-brand-primary-pale/45"
                : "border-border/70 bg-surface-raised"
            }`}
          >
            <p className="text-sm font-bold text-brand-heading">{policy.name}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{helper(policy.key)}</p>
          </button>
        ))}
      </section>

      {selectedPolicy ? (
        <section className="mt-5 rounded-3xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)] sm:p-6">
          <h2 className="text-base font-bold text-brand-heading">{selectedPolicy.name}</h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-semibold">
              Mulai
              <input type="date" value={startOn} onChange={(event) => { setStartOn(event.target.value); setPreview(null); }} className="mt-2 h-11 w-full rounded-xl border border-border px-3 font-normal" />
            </label>
            <label className="text-sm font-semibold">
              Selesai
              <input type="date" value={endOn} onChange={(event) => { setEndOn(event.target.value); setPreview(null); }} className="mt-2 h-11 w-full rounded-xl border border-border px-3 font-normal" />
            </label>
          </div>
          <label className="mt-4 block text-sm font-semibold">
            Keterangan <span className="font-normal text-muted-foreground">(opsional)</span>
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} className="mt-2 w-full rounded-xl border border-border px-3 py-2.5 font-normal" />
          </label>

          {selectedPolicy.evidenceRequirement === "required" ? (
            <label className="mt-4 block text-sm font-semibold">
              Dokumen pendukung
              <span className="mt-1 block text-xs font-normal text-muted-foreground">PDF/JPG/PNG, maksimal 2 MB.</span>
              <input
                type="file"
                accept="application/pdf,image/jpeg,image/png"
                onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); }}
                className="mt-2 block w-full text-sm"
              />
            </label>
          ) : null}

          <button type="button" disabled={busy} onClick={() => void handlePreview()} className="mt-5 inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface-raised px-4 text-sm font-semibold disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FileUp className="h-4 w-4" aria-hidden="true" />}
            Periksa pengajuan
          </button>

          {preview ? (
            <div className="mt-5 rounded-2xl bg-surface p-4">
              <p className="text-sm font-bold text-brand-heading">Ringkasan sebelum dikirim</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div><p className="text-xs text-muted-foreground">Hari kerja terdampak</p><p className="mt-1 text-xl font-bold">{preview.workingDays}</p></div>
                <div><p className="text-xs text-muted-foreground">Durasi kalender</p><p className="mt-1 text-xl font-bold">{preview.calendarDurationDays}</p></div>
                <div><p className="text-xs text-muted-foreground">Minimal pengajuan</p><p className="mt-1 text-xl font-bold">H-{preview.minimumNoticeDays}</p></div>
              </div>
              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                Berikutnya: {preview.approvalChain.map((step) => step.name).join(" → ")}, kemudian {preview.policy.hcHandling === "approve" ? "keputusan Human Capital" : "pemeriksaan Human Capital"}.
              </p>
              {preview.unpaid ? (
                <p className="mt-2 text-xs leading-5 text-muted-foreground">Cuti ini dicatat sebagai tidak bergaji untuk kebutuhan downstream. Halaman ini tidak menghitung potongan payroll.</p>
              ) : null}
              <button type="button" disabled={busy} onClick={() => void handleSubmit()} className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-primary px-5 text-sm font-bold text-brand-foreground disabled:opacity-50">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                Kirim pengajuan
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="mt-5 overflow-hidden rounded-3xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <div className="border-b border-border/70 px-5 py-4"><h2 className="text-base font-bold text-brand-heading">Pengajuan saya</h2></div>
        <div className="divide-y divide-border/70">
          {loading ? (
            <p className="px-5 py-8 text-sm text-muted-foreground">Memuat pengajuan...</p>
          ) : (summary?.requests ?? []).length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted-foreground">Belum ada pengajuan pada kategori ini.</p>
          ) : (
            summary?.requests.map((item) => (
              <div key={item.id} className="px-5 py-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-sm font-bold text-brand-heading">{item.policyName}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{formatDate(item.startOn)} – {formatDate(item.endOn)} · {item.workingDays} hari kerja · {item.validationSummary.calendarDurationDays ?? "—"} hari kalender</p>
                  </div>
                  <span className="w-fit rounded-full bg-muted px-3 py-1 text-xs font-semibold">{item.status === "approved" ? "Selesai" : item.status === "rejected" ? "Ditolak" : "Diproses"}</span>
                </div>
                <p className="mt-2 text-xs font-semibold text-brand-primary-deep">{item.nextAction}</p>
                {item.hcTaskStatus === "needs_correction" ? (
                  <div className="mt-3 rounded-2xl border border-warning-line bg-warning-soft p-3">
                    <p className="text-xs font-semibold text-warning-ink">Human Capital meminta kelengkapan dokumen.</p>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                      <input
                        type="file"
                        accept="application/pdf,image/jpeg,image/png"
                        onChange={(event) =>
                          setCorrectionFiles((current) => ({
                            ...current,
                            [item.id]: event.target.files?.[0] ?? null,
                          }))
                        }
                        className="block min-w-0 flex-1 text-xs"
                      />
                      <button
                        type="button"
                        disabled={busy || !correctionFiles[item.id]}
                        onClick={() => void completeEvidence(item.id)}
                        className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-brand-foreground disabled:opacity-50"
                      >
                        <FileUp className="h-4 w-4" aria-hidden="true" /> Kirim dokumen
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </section>
    </AppShell>
  );
}
