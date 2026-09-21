import {
  AlertTriangle,
  CalendarCheck2,
  CheckCircle2,
  Clock3,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import {
  AttendanceResolutionApiError,
  decideAttendanceResolution,
  type HcAttendanceResolutionQueue,
} from "@/lib/attendanceResolution";
import { resolveHcAttendanceQueue, type HcQueueState } from "@/lib/hcQueueState";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(new Date(`${value}T00:00:00+07:00`));
}

export function HcAttendanceResolutionPage() {
  const [queueState, setQueueState] = useState<HcQueueState<HcAttendanceResolutionQueue>>({ status: "loading" });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyCase, setBusyCase] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = async () => {
    setQueueState({ status: "loading" });
    setActionError(null);
    setQueueState(await resolveHcAttendanceQueue());
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

  const decide = async (
    caseId: string,
    action: "dispensation" | "unpaid_absence" | "manual_review" | "propose_annual_conversion",
  ) => {
    const note = notes[caseId]?.trim() || null;
    if (action !== "propose_annual_conversion" && !note) {
      setActionError("Tambahkan catatan singkat sebelum menetapkan penyelesaian.");
      return;
    }
    setBusyCase(caseId);
    setActionError(null);
    setSuccess(null);
    try {
      const result = await decideAttendanceResolution(caseId, { action, note });
      setNotes((current) => ({ ...current, [caseId]: "" }));
      setSuccess(
        result.status === "awaiting_employee"
          ? "Usulan penggunaan Cuti Tahunan sudah dikirim ke pegawai untuk persetujuan."
          : result.status === "resolved"
            ? "Ketidakhadiran sudah memiliki penyelesaian final."
            : "Kasus ditandai untuk review lanjutan.",
      );
      await load();
    } catch (cause) {
      setActionError(
        cause instanceof AttendanceResolutionApiError
          ? cause.message
          : "Penyelesaian tidak dapat disimpan.",
      );
    } finally {
      setBusyCase(null);
    }
  };

  return (
    <AppShell
      user={user}
      activeItem="Penyelesaian Kehadiran"
    >
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Human Capital</p>
          <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-brand-heading">Penyelesaian ketidakhadiran</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Hanya tanggal yang administrasi cutinya belum terpenuhi yang masuk ke sini. Tentukan klasifikasi akhirnya tanpa mengubah hak cuti tenaga pendidikan.
          </p>
        </div>
      </section>

      {error ? (
        <div className="mt-5 flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {error}
        </div>
      ) : null}
      {success ? (
        <div className="mt-5 flex gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {success}
        </div>
      ) : null}

      <section className="mt-5 rounded-3xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
          <div className="flex items-center gap-3">
            <Clock3 className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
            <div>
              <h2 className="text-base font-bold text-brand-heading">Perlu penyelesaian</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Selesaikan satu kasus dalam satu kartu.</p>
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
              <ShieldCheck className="mx-auto h-8 w-8 text-brand-primary-deep" aria-hidden="true" />
              <p className="mt-3 text-sm font-bold text-brand-heading">Tidak ada kasus terbuka</p>
              <p className="mt-1 text-xs text-muted-foreground">Semua ketidakhadiran sudah memiliki klasifikasi.</p>
            </div>
          ) : (
            queueState.queue.items.map((item) => (
              <article key={item.caseId} className="px-5 py-5">
                <div className="grid gap-5 lg:grid-cols-[1fr_0.95fr]">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-bold text-brand-heading">{item.requesterName}</p>
                      <span className="rounded-full bg-surface px-2.5 py-1 text-[10px] font-bold text-muted-foreground">
                        {item.policyName}
                      </span>
                      <span className="rounded-full bg-brand-primary-pale px-2.5 py-1 text-[10px] font-bold text-brand-primary-deep">
                        {item.entitlementGroup === "education" ? "Tenaga pendidikan" : "Non-pendidikan"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.employeeNumber} · {item.unitName ?? "Tanpa unit"} · {item.positionName ?? "Tanpa jabatan"}
                    </p>

                    <div className="mt-4 rounded-2xl bg-surface p-4">
                      <p className="text-xs font-semibold text-muted-foreground">Tanggal yang belum terselesaikan</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {item.unresolvedDates.map((date) => (
                          <span key={date} className="rounded-xl bg-white px-3 py-2 text-xs font-bold text-brand-heading shadow-sm">
                            {shortDate(date)}
                          </span>
                        ))}
                      </div>
                    </div>

                    {item.entitlementGroup === "education" ? (
                      <p className="mt-3 rounded-2xl border border-brand-primary/20 bg-brand-primary-pale/35 p-3 text-xs leading-5 text-brand-primary-deep">
                        Hak Cuti Akhir Semester/Akhir Tahun Pelajaran tidak dipotong untuk penyelesaian kasus ini.
                      </p>
                    ) : null}

                    {item.status === "awaiting_employee" ? (
                      <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                        <p className="text-xs font-bold text-amber-950">Menunggu keputusan pegawai</p>
                        <p className="mt-1 text-xs leading-5 text-amber-900">
                          Usulan penggunaan Cuti Tahunan sudah dikirim. Jangan menetapkan treatment lain sebelum pegawai menjawab.
                        </p>
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-2xl border border-border/70 bg-surface p-4">
                    <p className="text-sm font-bold text-brand-heading">Pilih penyelesaian</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Ini menetapkan klasifikasi kehadiran. Dampak upah nanti dibaca modul payroll dari hasil final, bukan dihitung di halaman ini.
                    </p>

                    <label className="mt-4 block text-xs font-semibold text-muted-foreground">
                      Catatan keputusan
                      <textarea
                        rows={3}
                        value={notes[item.caseId] ?? ""}
                        onChange={(event) =>
                          setNotes((current) => ({ ...current, [item.caseId]: event.target.value }))
                        }
                        disabled={item.status === "awaiting_employee"}
                        placeholder="Tuliskan dasar singkat penyelesaian."
                        className="mt-2 w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm font-normal outline-none focus:border-brand-primary disabled:bg-muted"
                      />
                    </label>

                    {item.status === "awaiting_employee" ? null : (
                      <div className="mt-4 grid gap-2">
                        {item.annualConversion.available ? (
                          <button
                            type="button"
                            disabled={busyCase === item.caseId}
                            onClick={() => void decide(item.caseId, "propose_annual_conversion")}
                            className="rounded-xl border border-brand-primary/25 bg-brand-primary-pale px-4 py-3 text-left disabled:opacity-50"
                          >
                            <span className="flex items-center gap-2 text-xs font-bold text-brand-primary-deep">
                              <CalendarCheck2 className="h-4 w-4" aria-hidden="true" /> Usulkan pakai Cuti Tahunan
                            </span>
                            <span className="mt-1 block text-[11px] leading-5 text-muted-foreground">
                              {item.annualConversion.requestedDays} hari · sisa periode sebelum konversi {item.annualConversion.remainingDays} hari · perlu persetujuan pegawai
                            </span>
                          </button>
                        ) : item.entitlementGroup === "non_education" ? (
                          <div className="rounded-xl border border-border bg-white p-3 text-[11px] leading-5 text-muted-foreground">
                            Konversi Cuti Tahunan tidak tersedia: {item.annualConversion.reason}
                          </div>
                        ) : null}

                        <button
                          type="button"
                          disabled={busyCase === item.caseId}
                          onClick={() => void decide(item.caseId, "dispensation")}
                          className="min-h-11 rounded-xl border border-border bg-white px-4 text-xs font-bold text-brand-heading disabled:opacity-50"
                        >
                          Tetapkan dispensasi
                        </button>
                        <button
                          type="button"
                          disabled={busyCase === item.caseId}
                          onClick={() => void decide(item.caseId, "unpaid_absence")}
                          className="min-h-11 rounded-xl border border-red-200 bg-red-50 px-4 text-xs font-bold text-red-900 disabled:opacity-50"
                        >
                          Ketidakhadiran tanpa hak
                        </button>
                        <button
                          type="button"
                          disabled={busyCase === item.caseId}
                          onClick={() => void decide(item.caseId, "manual_review")}
                          className="min-h-10 rounded-xl px-4 text-xs font-semibold text-muted-foreground underline-offset-4 hover:underline disabled:opacity-50"
                        >
                          Tahan untuk review administratif
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </AppShell>
  );
}
