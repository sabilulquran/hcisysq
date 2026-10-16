import {
  AlertTriangle,
  ArrowLeft,
  CalendarCheck2,
  CheckCircle2,
  Clock3,
  Loader2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import {
  AttendanceResolutionApiError,
  decideMyAnnualConversion,
  getMyAttendanceResolutions,
  type AttendanceResolutionItem,
} from "@/lib/attendanceResolution";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";

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

function finalLabel(value: AttendanceResolutionItem["finalResolution"]) {
  if (value === "annual_conversion") return "Diselesaikan dengan Cuti Tahunan";
  if (value === "dispensation") return "Dispensasi";
  if (value === "unpaid_absence") return "Ketidakhadiran tanpa hak";
  return "Selesai";
}

export function EmployeeAttendanceResolutionPage() {
  const [summary, setSummary] = useState<EmployeeLeaveSummary | null>(null);
  const [items, setItems] = useState<AttendanceResolutionItem[] | null>(null);
  const [busyCase, setBusyCase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = async () => {
    try {
      const [employeeSummary, resolutions] = await Promise.all([
        getEmployeeLeaveSummary(),
        getMyAttendanceResolutions(),
      ]);
      setSummary(employeeSummary);
      setItems(resolutions.items);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof AttendanceResolutionApiError || cause instanceof Error
          ? cause.message
          : "Tindak lanjut ketidakhadiran tidak dapat dimuat.",
      );
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
      ...(summary?.pendingApprovalCount ? { additionalRole: "Approver" } : {}),
    };
  }, [summary]);

  const decide = async (caseId: string, decision: "accept" | "reject") => {
    setBusyCase(caseId);
    setError(null);
    setSuccess(null);
    try {
      const result = await decideMyAnnualConversion(caseId, { decision, note: null });
      setSuccess(
        result.decision === "accept"
          ? `${result.convertedDays ?? 0} hari sudah dikonversi secara administratif ke Cuti Tahunan.`
          : "Usulan Cuti Tahunan tidak digunakan. Kasus dikembalikan ke Human Capital untuk penyelesaian lain.",
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof AttendanceResolutionApiError
          ? cause.message
          : "Keputusan tidak dapat disimpan.",
      );
    } finally {
      setBusyCase(null);
    }
  };

  const openItems = (items ?? []).filter((item) => item.status !== "resolved");
  const resolvedItems = (items ?? []).filter((item) => item.status === "resolved").slice(0, 5);

  return (
    <AppShell user={user} activeItem="Cuti & Izin">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Cuti & izin</p>
          <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-brand-heading">Tindak lanjut ketidakhadiran</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Halaman ini hanya muncul saat ada tanggal yang administrasi cutinya belum sepenuhnya terpenuhi. Anda hanya perlu bertindak jika ada kartu yang meminta keputusan.
          </p>
        </div>
        <a
          href="/app/leave"
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-surface-raised px-4 text-sm font-semibold"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Cuti & Izin
        </a>
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

      <section className="mt-5 space-y-3">
        {!items ? (
          <div className="flex items-center gap-2 rounded-3xl border border-border/70 bg-surface-raised p-6 text-sm text-muted-foreground shadow-[var(--shadow-soft)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat tindak lanjut...
          </div>
        ) : openItems.length === 0 ? (
          <div className="rounded-3xl border border-border/70 bg-surface-raised p-8 text-center shadow-[var(--shadow-soft)]">
            <CheckCircle2 className="mx-auto h-8 w-8 text-brand-primary-deep" aria-hidden="true" />
            <p className="mt-3 text-sm font-bold text-brand-heading">Tidak ada yang perlu Anda lakukan</p>
            <p className="mt-1 text-xs text-muted-foreground">Tidak ada penyelesaian ketidakhadiran yang menunggu.</p>
          </div>
        ) : (
          openItems.map((item) => (
            <article key={item.caseId} className="rounded-3xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)] sm:p-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-surface px-3 py-1 text-[10px] font-bold text-muted-foreground">{item.policyName}</span>
                    <span className={`rounded-full px-3 py-1 text-[10px] font-bold ${item.status === "awaiting_employee" ? "bg-brand-yellow/18 text-warning-ink" : "bg-brand-primary-pale text-brand-primary-deep"}`}>
                      {item.status === "awaiting_employee" ? "Perlu keputusan Anda" : "Sedang ditangani HC"}
                    </span>
                  </div>
                  <p className="mt-4 text-sm font-bold text-brand-heading">Tanggal yang perlu penyelesaian</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {item.unresolvedDates.map((date) => (
                      <span key={date} className="rounded-xl bg-surface px-3 py-2 text-xs font-semibold text-brand-heading">
                        {formatDate(date)}
                      </span>
                    ))}
                  </div>
                  {item.note ? <p className="mt-3 text-xs leading-5 text-muted-foreground">Catatan HC: {item.note}</p> : null}
                </div>

                {item.status === "awaiting_employee" && item.proposedResolution === "annual_conversion" ? (
                  <div className="w-full max-w-md rounded-2xl border border-brand-primary/20 bg-brand-primary-pale/35 p-4">
                    <div className="flex items-start gap-3">
                      <CalendarCheck2 className="mt-0.5 h-5 w-5 shrink-0 text-brand-primary-deep" aria-hidden="true" />
                      <div>
                        <p className="text-sm font-bold text-brand-heading">Usulan gunakan Cuti Tahunan</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {item.annualConversion.requestedDays} hari akan memakai kuota periode yang sama. Sisa sebelum konversi: {item.annualConversion.remainingDays} hari.
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                      <button
                        type="button"
                        disabled={busyCase === item.caseId || !item.annualConversion.available}
                        onClick={() => void decide(item.caseId, "accept")}
                        className="min-h-11 rounded-xl bg-brand-primary px-4 text-xs font-bold text-brand-foreground disabled:opacity-50"
                      >
                        Gunakan Cuti Tahunan
                      </button>
                      <button
                        type="button"
                        disabled={busyCase === item.caseId}
                        onClick={() => void decide(item.caseId, "reject")}
                        className="min-h-11 rounded-xl border border-border bg-surface-raised px-4 text-xs font-bold text-brand-heading disabled:opacity-50"
                      >
                        Jangan gunakan
                      </button>
                    </div>
                    {!item.annualConversion.available ? (
                      <p className="mt-3 text-[11px] leading-5 text-danger-ink">{item.annualConversion.reason}</p>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex w-full max-w-sm items-start gap-3 rounded-2xl bg-surface p-4 text-xs leading-5 text-muted-foreground">
                    <Clock3 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    Human Capital sedang menentukan penyelesaian. Anda tidak perlu melakukan apa pun saat ini.
                  </div>
                )}
              </div>
            </article>
          ))
        )}
      </section>

      {resolvedItems.length > 0 ? (
        <section className="mt-6 overflow-hidden rounded-3xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
          <div className="border-b border-border/70 px-5 py-4">
            <h2 className="text-base font-bold text-brand-heading">Riwayat terbaru</h2>
          </div>
          <div className="divide-y divide-border/70">
            {resolvedItems.map((item) => (
              <div key={item.caseId} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-brand-heading">{item.policyName}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{item.unresolvedDates.map(formatDate).join(", ")}</p>
                </div>
                <span className="w-fit rounded-full bg-surface px-3 py-1 text-xs font-semibold text-brand-heading">
                  {finalLabel(item.finalResolution)}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </AppShell>
  );
}
