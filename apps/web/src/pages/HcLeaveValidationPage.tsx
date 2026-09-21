import {
  CheckCircle2,
  ChevronDown,
  FileText,
  Loader2,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import {
  AttendanceResolutionApiError,
  decideLeaveAdministration,
  type HcAdministrationQueue,
} from "@/lib/attendanceResolution";
import { resolveHcAdministrationQueue, type HcQueueState } from "@/lib/hcQueueState";
import { hcEvidenceDownloadHref } from "@/lib/specialLeave";

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

function shortDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Jakarta",
  }).format(new Date(`${value}T00:00:00+07:00`));
}

export function HcLeaveValidationPage() {
  const [queueState, setQueueState] = useState<HcQueueState<HcAdministrationQueue>>({ status: "loading" });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [selectedDates, setSelectedDates] = useState<Record<string, string[]>>({});
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = async () => {
    setQueueState({ status: "loading" });
    setActionError(null);
    setQueueState(await resolveHcAdministrationQueue());
  };

  useEffect(() => {
    void load();
  }, []);

  const queue = queueState.status === "ready" ? queueState.queue : null;
  const error = actionError ?? (queueState.status === "error" ? queueState.message : null);

  const user = useMemo(
    () => ({
      name: queue?.actor.fullName ?? "Human Capital",
      initials: initials(queue?.actor.fullName ?? "HC"),
      position: queue?.actor.positionName ?? "Human Capital",
      unit: queue?.actor.unitName ?? "Yayasan Sabilul Qur'an",
    }),
    [queue],
  );

  const runDecision = async (
    taskId: string,
    input: {
      action: "validate_all" | "request_correction" | "validate_partial" | "not_validated";
      note: string | null;
      validatedDates?: string[];
    },
  ) => {
    setBusyTask(taskId);
    setActionError(null);
    setSuccess(null);
    try {
      const result = await decideLeaveAdministration(taskId, input);
      setNotes((current) => ({ ...current, [taskId]: "" }));
      setExpandedTask(null);
      if (result.resolutionCaseId) {
        setSuccess(
          `${result.unresolvedDates?.length ?? 0} hari belum terselesaikan dan sudah masuk antrean Penyelesaian Ketidakhadiran.`,
        );
      } else if (input.action === "request_correction") {
        setSuccess("Permintaan kelengkapan dikirim ke pegawai.");
      } else {
        setSuccess("Administrasi cuti sudah selesai divalidasi.");
      }
      await load();
    } catch (cause) {
      setActionError(
        cause instanceof AttendanceResolutionApiError
          ? cause.message
          : "Hasil validasi tidak dapat disimpan.",
      );
    } finally {
      setBusyTask(null);
    }
  };

  const validateAll = (taskId: string) =>
    runDecision(taskId, {
      action: "validate_all",
      note: notes[taskId]?.trim() || null,
    });

  const requestCorrection = (taskId: string) => {
    const note = notes[taskId]?.trim() || null;
    if (!note) {
      setActionError("Tuliskan dengan jelas apa yang perlu dilengkapi oleh pegawai.");
      return;
    }
    void runDecision(taskId, { action: "request_correction", note });
  };

  const openPartial = (taskId: string, workingDates: string[]) => {
    setExpandedTask((current) => (current === taskId ? null : taskId));
    setSelectedDates((current) =>
      current[taskId] ? current : { ...current, [taskId]: [...workingDates] },
    );
    setActionError(null);
  };

  const toggleDate = (taskId: string, date: string) => {
    setSelectedDates((current) => {
      const selected = current[taskId] ?? [];
      return {
        ...current,
        [taskId]: selected.includes(date)
          ? selected.filter((item) => item !== date)
          : [...selected, date].sort(),
      };
    });
  };

  const savePartial = (taskId: string, workingDates: string[]) => {
    const selected = selectedDates[taskId] ?? [];
    const note = notes[taskId]?.trim() || null;
    if (selected.length === workingDates.length) {
      void runDecision(taskId, { action: "validate_all", note });
      return;
    }
    if (!note) {
      setActionError("Tambahkan catatan agar alasan tanggal yang belum terpenuhi jelas.");
      return;
    }
    void runDecision(taskId, {
      action: selected.length === 0 ? "not_validated" : "validate_partial",
      note,
      ...(selected.length > 0 ? { validatedDates: selected } : {}),
    });
  };

  return (
    <AppShell
      user={user}
      activeItem="Validasi Cuti"
    >
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Human Capital</p>
          <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-brand-heading">Validasi administrasi cuti</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Untuk kasus normal cukup pilih “Administrasi sesuai”. Detail tanggal hanya dibuka bila dokumen mencakup sebagian periode atau administrasinya tidak terpenuhi.
          </p>
        </div>
      </section>

      {error ? (
        <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          {success}
        </div>
      ) : null}

      <section className="mt-5 rounded-3xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
            <div>
              <h2 className="text-base font-bold text-brand-heading">Perlu diperiksa</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Kerjakan dari yang paling atas.</p>
            </div>
          </div>
          <span className="rounded-full bg-brand-primary-pale px-3 py-1 text-xs font-bold text-brand-primary-deep">
            {queue?.items.length ?? 0}
          </span>
        </div>

        <div className="divide-y divide-border/70">
          {queueState.status === "loading" ? (
            <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat antrean...
            </div>
          ) : queueState.status === "error" ? (
            <div className="px-5 py-8 text-sm text-muted-foreground">
              <p>Antrean tidak dapat ditampilkan untuk akses ini.</p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-3 inline-flex min-h-10 items-center rounded-xl border border-border bg-white px-4 text-xs font-bold text-brand-heading"
              >
                Coba lagi
              </button>
            </div>
          ) : queueState.queue.items.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <CheckCircle2 className="mx-auto h-8 w-8 text-brand-primary-deep" aria-hidden="true" />
              <p className="mt-3 text-sm font-bold text-brand-heading">Semua sudah diperiksa</p>
              <p className="mt-1 text-xs text-muted-foreground">Tidak ada validasi cuti yang menunggu.</p>
            </div>
          ) : (
            queueState.queue.items.map((item, index) => {
              const selected = selectedDates[item.taskId] ?? item.workingDates;
              const partialOpen = expandedTask === item.taskId;
              return (
                <article key={item.taskId} className="px-5 py-5">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <span className="rounded-full bg-surface px-2.5 py-1 text-[10px] font-bold text-muted-foreground">
                      #{index + 1}
                    </span>
                    <span className="rounded-full bg-brand-primary-pale px-3 py-1 text-[10px] font-bold text-brand-primary-deep">
                      {item.policyName}
                    </span>
                  </div>

                  <div className="grid gap-5 lg:grid-cols-[1fr_0.9fr]">
                    <div>
                      <p className="text-sm font-bold text-brand-heading">{item.requesterName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.employeeNumber} · {item.unitName ?? "Tanpa unit"} · {item.positionName ?? "Tanpa jabatan"}
                      </p>

                      <div className="mt-4 rounded-2xl bg-surface p-4">
                        <p className="text-xs text-muted-foreground">Periode</p>
                        <p className="mt-1 text-sm font-bold text-brand-heading">
                          {formatDate(item.startOn)} – {formatDate(item.endOn)}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">{item.workingDays} hari kerja</p>
                      </div>

                      {item.reason ? (
                        <div className="mt-3">
                          <p className="text-xs font-semibold text-muted-foreground">Keterangan pegawai</p>
                          <p className="mt-1 text-sm leading-6 text-brand-heading">{item.reason}</p>
                        </div>
                      ) : null}

                      <div className="mt-4">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs font-semibold text-muted-foreground">Dokumen pendukung</p>
                          <span className={`text-[10px] font-bold ${item.evidence.length ? "text-brand-primary-deep" : "text-amber-800"}`}>
                            {item.evidence.length ? `${item.evidence.length} tersedia` : "Belum tersedia"}
                          </span>
                        </div>
                        {item.evidence.length === 0 ? (
                          <p className="mt-2 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                            Belum ada dokumen. Jika bukti memang wajib, minta pegawai melengkapinya atau tandai administrasi tidak terpenuhi.
                          </p>
                        ) : (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {item.evidence.map((evidence) => (
                              <a
                                key={evidence.id}
                                href={hcEvidenceDownloadHref(item.requestId, evidence.id)}
                                className="inline-flex items-center gap-2 rounded-xl border border-border bg-white px-3 py-2 text-xs font-semibold"
                                target="_blank"
                                rel="noreferrer"
                              >
                                <FileText className="h-4 w-4" aria-hidden="true" />
                                {evidence.fileName}
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-border/70 bg-surface p-4">
                      <p className="text-sm font-bold text-brand-heading">Apa hasil pemeriksaannya?</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Pilih hasil utama. Catatan wajib bila meminta kelengkapan atau ada tanggal yang belum terpenuhi.
                      </p>

                      <label className="mt-4 block text-xs font-semibold text-muted-foreground">
                        Catatan untuk pegawai
                        <textarea
                          rows={3}
                          value={notes[item.taskId] ?? ""}
                          onChange={(event) =>
                            setNotes((current) => ({
                              ...current,
                              [item.taskId]: event.target.value,
                            }))
                          }
                          placeholder="Contoh: surat dokter hanya mencakup 1–2 September."
                          className="mt-2 w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm font-normal outline-none focus:border-brand-primary"
                        />
                      </label>

                      <div className="mt-4 grid gap-2">
                        <button
                          type="button"
                          disabled={busyTask === item.taskId}
                          onClick={() => void validateAll(item.taskId)}
                          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-white disabled:opacity-50"
                        >
                          {busyTask === item.taskId ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : (
                            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                          )}
                          Administrasi sesuai
                        </button>
                        <button
                          type="button"
                          disabled={busyTask === item.taskId}
                          onClick={() => requestCorrection(item.taskId)}
                          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 text-xs font-bold text-amber-950 disabled:opacity-50"
                        >
                          <RotateCcw className="h-4 w-4" aria-hidden="true" />
                          Minta dilengkapi
                        </button>
                        <button
                          type="button"
                          disabled={busyTask === item.taskId}
                          onClick={() => openPartial(item.taskId, item.workingDates)}
                          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-border bg-white px-4 text-xs font-semibold text-brand-heading disabled:opacity-50"
                        >
                          Sebagian / tidak terpenuhi
                          <ChevronDown className={`h-4 w-4 transition-transform ${partialOpen ? "rotate-180" : ""}`} aria-hidden="true" />
                        </button>
                      </div>

                      {partialOpen ? (
                        <div className="mt-4 rounded-2xl border border-border bg-white p-4">
                          <p className="text-xs font-bold text-brand-heading">Tanggal yang administrasinya terpenuhi</p>
                          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                            Centang tanggal yang didukung dokumen. Hilangkan semua centang bila tidak ada tanggal yang dapat divalidasi.
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {item.workingDates.map((date) => {
                              const checked = selected.includes(date);
                              return (
                                <button
                                  type="button"
                                  key={date}
                                  onClick={() => toggleDate(item.taskId, date)}
                                  className={`rounded-xl border px-3 py-2 text-xs font-semibold ${
                                    checked
                                      ? "border-brand-primary bg-brand-primary-pale text-brand-primary-deep"
                                      : "border-border bg-surface text-muted-foreground"
                                  }`}
                                >
                                  {checked ? "✓ " : ""}{shortDate(date)}
                                </button>
                              );
                            })}
                          </div>
                          <p className="mt-3 text-[11px] font-semibold text-muted-foreground">
                            {selected.length} dari {item.workingDates.length} hari akan dinyatakan tervalidasi.
                          </p>
                          <button
                            type="button"
                            disabled={busyTask === item.taskId}
                            onClick={() => savePartial(item.taskId, item.workingDates)}
                            className="mt-3 inline-flex min-h-10 w-full items-center justify-center rounded-xl bg-brand-heading px-4 text-xs font-bold text-white disabled:opacity-50"
                          >
                            Simpan hasil per tanggal
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </section>
    </AppShell>
  );
}
