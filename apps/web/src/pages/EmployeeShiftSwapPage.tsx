import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Loader2,
  Send,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import { getMyWorkforceAttendance } from "@/lib/workforceAttendance";
import {
  cancelShiftSwap,
  createShiftSwap,
  decideShiftSwapAsCounterpart,
  getMyShiftSwaps,
  getShiftSwapCandidates,
  type ShiftSwapCandidate,
  type ShiftSwapItem,
  type ShiftSwapStatus,
} from "@/lib/shiftSwap";

function shiftDate(value: string, days: number) {
  const date = new Date(value + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function todayJakarta() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

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

function statusClass(status: ShiftSwapStatus) {
  if (status === "approved") return "bg-emerald-50 text-emerald-700";
  if (status.startsWith("rejected") || status === "cancelled") return "bg-red-50 text-red-700";
  return "bg-amber-50 text-amber-800";
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

export function EmployeeShiftSwapPage() {
  const [user, setUser] = useState({ name: "Pegawai", initials: "P", position: "Pegawai", unit: "Yayasan Sabilul Qur'an" });
  const [employeeId, setEmployeeId] = useState("");
  const [workDate, setWorkDate] = useState(() => shiftDate(todayJakarta(), 1));
  const [requesterSchedule, setRequesterSchedule] = useState<{ scheduledStartAt: string; scheduledEndAt: string } | null>(null);
  const [candidates, setCandidates] = useState<ShiftSwapCandidate[]>([]);
  const [counterpartEmployeeId, setCounterpartEmployeeId] = useState("");
  const [note, setNote] = useState("");
  const [items, setItems] = useState<ShiftSwapItem[]>([]);
  const [requesterHasActiveSwap, setRequesterHasActiveSwap] = useState(false);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadRequests = async () => {
    const result = await getMyShiftSwaps("all");
    setEmployeeId(result.employeeId);
    setItems(result.items);
  };

  const loadCandidates = async (date: string) => {
    setLoadingCandidates(true);
    try {
      const result = await getShiftSwapCandidates(date);
      setRequesterSchedule(result.requesterSchedule);
      setCandidates(result.items);
      setRequesterHasActiveSwap(result.requesterHasActiveSwap);
      setCounterpartEmployeeId((current) =>
        result.items.some((item) => item.id === current) ? current : result.items[0]?.id ?? "",
      );
      setError(null);
    } catch (cause) {
      setRequesterSchedule(null);
      setCandidates([]);
      setCounterpartEmployeeId("");
      setRequesterHasActiveSwap(false);
      setError(cause instanceof Error ? cause.message : "Kandidat tukar shift tidak dapat dimuat.");
    } finally {
      setLoadingCandidates(false);
    }
  };

  useEffect(() => {
    void Promise.all([
      getMyWorkforceAttendance(),
      loadRequests(),
    ]).then(([snapshot]) => {
      setUser({
        name: snapshot.employee.fullName,
        initials: initials(snapshot.employee.fullName),
        position: "Pegawai",
        unit: "Yayasan Sabilul Qur'an",
      });
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Data tukar shift tidak dapat dimuat."));
  }, []);

  useEffect(() => {
    void loadCandidates(workDate);
  }, [workDate]);

  const submit = async () => {
    if (!counterpartEmployeeId) return;
    setBusy("submit");
    setError(null);
    setNotice(null);
    try {
      await createShiftSwap({
        counterpartEmployeeId,
        workDate,
        note: note.trim() || null,
      });
      setNote("");
      setNotice("Pengajuan dikirim. Rekan Anda perlu menyetujui sebelum masuk ke Human Capital.");
      await Promise.all([loadRequests(), loadCandidates(workDate)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pengajuan tukar shift gagal.");
    } finally {
      setBusy(null);
    }
  };

  const counterpartDecision = async (item: ShiftSwapItem, decision: "accept" | "reject") => {
    const decisionNote = decision === "reject"
      ? window.prompt("Alasan penolakan (opsional):")?.trim() || null
      : null;
    setBusy(item.id);
    setError(null);
    setNotice(null);
    try {
      await decideShiftSwapAsCounterpart(item.id, decision, decisionNote);
      setNotice(decision === "accept"
        ? "Tukar shift diterima dan diteruskan ke Human Capital."
        : "Pengajuan tukar shift ditolak.");
      await loadRequests();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Keputusan tukar shift gagal disimpan.");
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (item: ShiftSwapItem) => {
    if (!window.confirm("Batalkan pengajuan tukar shift ini?")) return;
    setBusy(item.id);
    setError(null);
    setNotice(null);
    try {
      await cancelShiftSwap(item.id);
      setNotice("Pengajuan tukar shift dibatalkan.");
      await Promise.all([loadRequests(), loadCandidates(workDate)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pengajuan tidak dapat dibatalkan.");
    } finally {
      setBusy(null);
    }
  };

  const incoming = useMemo(
    () => items.filter((item) => item.counterpartEmployeeId === employeeId && item.status === "awaiting_counterpart"),
    [items, employeeId],
  );
  const history = useMemo(
    () => items.filter((item) => !incoming.some((incomingItem) => incomingItem.id === item.id)),
    [items, incoming],
  );
  const selectedCandidate = candidates.find((item) => item.id === counterpartEmployeeId) ?? null;

  return (
    <AppShell user={user} activeItem="Tukar Shift">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Waktu & Kehadiran</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Tukar Shift</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Tukar shift dengan rekan satu unit pada tanggal yang sama. Rekan harus menyetujui lebih dulu, kemudian Human Capital memberi keputusan final.
        </p>
      </section>

      {error ? (
        <div className="mt-5 flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      ) : null}
      {notice ? (
        <div className="mt-5 flex gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
        </div>
      ) : null}

      {incoming.length > 0 ? (
        <section className="mt-6 rounded-[2rem] border border-amber-200 bg-amber-50/50 p-5">
          <h2 className="text-base font-bold text-brand-heading">Menunggu keputusan Anda</h2>
          <p className="mt-1 text-xs text-muted-foreground">Anda diminta menjadi rekan tukar shift.</p>
          <div className="mt-4 space-y-3">
            {incoming.map((item) => (
              <article key={item.id} className="rounded-2xl border border-amber-200 bg-white p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="font-bold text-brand-heading">{item.requesterName}</p>
                    <p className="mt-1 text-sm">{dateLabel(item.workDate)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Shift Anda {time(item.counterpartScheduledStartAt)}–{time(item.counterpartScheduledEndAt)}
                      {" "}→ shift rekan {time(item.requesterScheduledStartAt)}–{time(item.requesterScheduledEndAt)}
                    </p>
                    {item.note ? <p className="mt-2 text-sm">{item.note}</p> : null}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void counterpartDecision(item, "reject")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl border border-red-200 px-3 text-xs font-bold text-red-700 disabled:opacity-50"
                    >
                      <XCircle className="h-4 w-4" /> Tolak
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void counterpartDecision(item, "accept")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-3 text-xs font-bold text-white disabled:opacity-50"
                    >
                      {busy === item.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                      Setujui
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="mt-6 grid gap-5 lg:grid-cols-[1fr_1.2fr]">
        <article className="rounded-[2rem] border border-border/80 bg-white p-5 shadow-[var(--shadow-soft)]">
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5 text-brand-primary-deep" />
            <h2 className="font-bold text-brand-heading">Pengajuan baru</h2>
          </div>
          <label className="mt-4 block text-xs font-semibold text-muted-foreground">
            Tanggal kerja
            <input
              type="date"
              min={todayJakarta()}
              value={workDate}
              onChange={(event) => setWorkDate(event.target.value)}
              className="mt-1 h-11 w-full rounded-xl border border-border px-3 text-sm"
            />
          </label>

          {loadingCandidates ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Memeriksa jadwal…</div>
          ) : requesterSchedule ? (
            <div className="mt-4 rounded-2xl bg-surface p-4">
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Shift Anda</p>
              <p className="mt-1 text-lg font-bold text-brand-heading">{time(requesterSchedule.scheduledStartAt)}–{time(requesterSchedule.scheduledEndAt)}</p>
            </div>
          ) : null}

          <label className="mt-4 block text-xs font-semibold text-muted-foreground">
            Rekan satu unit
            <select
              value={counterpartEmployeeId}
              onChange={(event) => setCounterpartEmployeeId(event.target.value)}
              disabled={loadingCandidates || requesterHasActiveSwap}
              className="mt-1 h-11 w-full rounded-xl border border-border px-3 text-sm disabled:bg-surface"
            >
              <option value="">Pilih rekan</option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.fullName} · {time(candidate.schedule.scheduledStartAt)}–{time(candidate.schedule.scheduledEndAt)}
                </option>
              ))}
            </select>
          </label>

          {selectedCandidate ? (
            <div className="mt-3 rounded-2xl border border-border/70 p-4 text-sm">
              <p className="font-bold text-brand-heading">{selectedCandidate.fullName}</p>
              <p className="mt-1 text-xs text-muted-foreground">{selectedCandidate.employeeNumber} · {selectedCandidate.unitName ?? "Unit sama"}</p>
              <p className="mt-2">Shift {time(selectedCandidate.schedule.scheduledStartAt)}–{time(selectedCandidate.schedule.scheduledEndAt)}</p>
            </div>
          ) : null}

          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Catatan untuk rekan / Human Capital (opsional)"
            className="mt-3 min-h-24 w-full rounded-xl border border-border p-3 text-sm"
          />

          {requesterHasActiveSwap ? (
            <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
              Anda sudah mempunyai tukar shift aktif pada tanggal ini. Selesaikan atau batalkan pengajuan tersebut terlebih dahulu.
            </p>
          ) : null}
          {!loadingCandidates && !requesterHasActiveSwap && candidates.length === 0 ? (
            <p className="mt-3 rounded-xl bg-surface p-3 text-xs text-muted-foreground">
              Tidak ada rekan satu unit dengan shift berbeda yang eligible pada tanggal ini.
            </p>
          ) : null}

          <button
            type="button"
            disabled={busy !== null || requesterHasActiveSwap || !counterpartEmployeeId}
            onClick={() => void submit()}
            className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-white disabled:opacity-50"
          >
            {busy === "submit" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Ajukan tukar shift
          </button>
        </article>

        <article className="rounded-[2rem] border border-border/80 bg-white p-5 shadow-[var(--shadow-soft)]">
          <h2 className="font-bold text-brand-heading">Riwayat pengajuan</h2>
          <div className="mt-4 space-y-3">
            {history.map((item) => {
              const requester = item.requesterEmployeeId === employeeId;
              const otherName = requester ? item.counterpartName : item.requesterName;
              const myStart = requester ? item.requesterScheduledStartAt : item.counterpartScheduledStartAt;
              const myEnd = requester ? item.requesterScheduledEndAt : item.counterpartScheduledEndAt;
              const targetStart = requester ? item.counterpartScheduledStartAt : item.requesterScheduledStartAt;
              const targetEnd = requester ? item.counterpartScheduledEndAt : item.requesterScheduledEndAt;
              const cancellable = requester && ["awaiting_counterpart", "awaiting_hc"].includes(item.status);
              return (
                <div key={item.id} className="rounded-2xl border border-border/70 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-bold text-brand-heading">{dateLabel(item.workDate)} · {otherName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {time(myStart)}–{time(myEnd)} → {time(targetStart)}–{time(targetEnd)}
                      </p>
                    </div>
                    <span className={"rounded-full px-2.5 py-1 text-[11px] font-bold " + statusClass(item.status)}>
                      {statusLabel(item.status)}
                    </span>
                  </div>
                  {item.note ? <p className="mt-2 text-sm">{item.note}</p> : null}
                  {item.counterpartDecisionNote ? <p className="mt-2 text-xs text-muted-foreground">Catatan rekan: {item.counterpartDecisionNote}</p> : null}
                  {item.hcDecisionNote ? <p className="mt-1 text-xs text-muted-foreground">Catatan HC: {item.hcDecisionNote}</p> : null}
                  {cancellable ? (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void cancel(item)}
                      className="mt-3 h-9 rounded-xl border border-red-200 px-3 text-xs font-bold text-red-700 disabled:opacity-50"
                    >
                      Batalkan pengajuan
                    </button>
                  ) : null}
                </div>
              );
            })}
            {history.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada riwayat tukar shift.</p> : null}
          </div>
        </article>
      </section>
    </AppShell>
  );
}
