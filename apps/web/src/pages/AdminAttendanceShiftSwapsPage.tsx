import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Loader2,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import {
  decideShiftSwapAsHc,
  listShiftSwapsForHc,
  type ShiftSwapItem,
  type ShiftSwapStatus,
} from "@/lib/shiftSwap";

function time(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value + "T00:00:00+07:00"));
}

function statusLabel(status: ShiftSwapStatus) {
  const labels: Record<ShiftSwapStatus, string> = {
    awaiting_counterpart: "Menunggu rekan",
    awaiting_hc: "Menunggu Human Capital",
    approved: "Disetujui",
    rejected_by_counterpart: "Ditolak rekan",
    rejected_by_hc: "Ditolak Human Capital",
    cancelled: "Dibatalkan",
  };
  return labels[status];
}

export function AdminAttendanceShiftSwapsPage() {
  const [status, setStatus] = useState<"all" | ShiftSwapStatus>("awaiting_hc");
  const [items, setItems] = useState<ShiftSwapItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    const result = await listShiftSwapsForHc(status);
    setItems(result.items);
  };

  useEffect(() => {
    void load().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Pengajuan tukar shift tidak dapat dimuat."),
    );
  }, [status]);

  const decide = async (item: ShiftSwapItem, decision: "approve" | "reject") => {
    const note = window.prompt(
      decision === "approve"
        ? "Catatan persetujuan (opsional):"
        : "Alasan penolakan (opsional):",
    )?.trim() || null;
    setBusy(item.id);
    setError(null);
    setNotice(null);
    try {
      const result = await decideShiftSwapAsHc(item.id, decision, note);
      if (decision === "approve") {
        setNotice(
          result.roster
            ? `Tukar shift disetujui. Roster minggu ${result.roster.weekStart} dipublish sebagai versi ${result.roster.version}.`
            : "Tukar shift disetujui.",
        );
      } else {
        setNotice("Pengajuan tukar shift ditolak.");
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Keputusan tukar shift gagal disimpan.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <AttendanceWorkforceShell
      section="shift-swaps"
      title="Tukar Shift"
      description="Keputusan final Human Capital setelah rekan kerja menyetujui pertukaran shift."
    >
      {error ? (
        <div className="mb-4 flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4 flex gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
        </div>
      ) : null}

      <section className="rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <header className="flex flex-col gap-3 border-b border-border/70 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5 text-brand-primary-deep" />
            <div>
              <h2 className="font-bold text-brand-heading">Antrean & riwayat</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Approval akan membuat roster version baru; roster historis tidak diubah.
              </p>
            </div>
          </div>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as "all" | ShiftSwapStatus)}
            className="h-10 rounded-xl border border-border px-3 text-sm"
          >
            <option value="awaiting_hc">Menunggu Human Capital</option>
            <option value="awaiting_counterpart">Menunggu rekan</option>
            <option value="approved">Disetujui</option>
            <option value="rejected_by_counterpart">Ditolak rekan</option>
            <option value="rejected_by_hc">Ditolak Human Capital</option>
            <option value="cancelled">Dibatalkan</option>
            <option value="all">Semua</option>
          </select>
        </header>

        <div className="divide-y divide-border/70">
          {items.map((item) => (
            <article key={item.id} className="p-5">
              <div className="grid gap-4 xl:grid-cols-[1fr_auto] xl:items-start">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-bold text-brand-heading">
                      {item.requesterName} ↔ {item.counterpartName}
                    </h3>
                    <span className="rounded-full bg-surface px-2.5 py-1 text-[11px] font-bold">
                      {statusLabel(item.status)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {dateLabel(item.workDate)} · {item.requesterUnitName ?? item.counterpartUnitName ?? "Unit tidak diketahui"}
                  </p>

                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <div className="rounded-2xl bg-surface p-4">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Requester</p>
                      <p className="mt-1 font-bold text-brand-heading">{item.requesterName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.requesterEmployeeNumber} · {item.requesterScheduleName}
                      </p>
                      <p className="mt-2 text-sm">
                        {time(item.requesterScheduledStartAt)}–{time(item.requesterScheduledEndAt)}
                      </p>
                    </div>
                    <div className="rounded-2xl bg-surface p-4">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Counterpart</p>
                      <p className="mt-1 font-bold text-brand-heading">{item.counterpartName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.counterpartEmployeeNumber} · {item.counterpartScheduleName}
                      </p>
                      <p className="mt-2 text-sm">
                        {time(item.counterpartScheduledStartAt)}–{time(item.counterpartScheduledEndAt)}
                      </p>
                    </div>
                  </div>

                  {item.note ? <p className="mt-3 text-sm">Catatan requester: {item.note}</p> : null}
                  {item.counterpartDecisionNote ? (
                    <p className="mt-1 text-xs text-muted-foreground">Catatan rekan: {item.counterpartDecisionNote}</p>
                  ) : null}
                  {item.hcDecisionNote ? (
                    <p className="mt-1 text-xs text-muted-foreground">Catatan HC: {item.hcDecisionNote}</p>
                  ) : null}
                  {item.publishedRosterId ? (
                    <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                      published roster: {item.publishedRosterId}
                    </p>
                  ) : null}
                </div>

                {item.status === "awaiting_hc" ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void decide(item, "reject")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl border border-red-200 px-3 text-xs font-bold text-red-700 disabled:opacity-50"
                    >
                      <XCircle className="h-4 w-4" /> Tolak
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void decide(item, "approve")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-3 text-xs font-bold text-white disabled:opacity-50"
                    >
                      {busy === item.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                      Setujui & publish roster
                    </button>
                  </div>
                ) : null}
              </div>
            </article>
          ))}
          {items.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              Tidak ada pengajuan tukar shift pada filter ini.
            </div>
          ) : null}
        </div>
      </section>
    </AttendanceWorkforceShell>
  );
}
