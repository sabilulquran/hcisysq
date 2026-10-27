import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { CorrectionEntryForm } from "@/components/attendance/CorrectionEntryForm";
import { MobileEvidencePanel } from "@/components/attendance/MobileEvidencePanel";
import { getAttendanceDay, requestEmployeeClarification, type AttendanceDay } from "@/lib/attendanceActionQueue";
import { calculationRowStatusLabel, transactionSourceLabel, type AttendanceCalculationRowStatus } from "@/lib/attendanceCalculation";
import { clarificationKindLabel, clarificationModeLabel, requestStatusLabel } from "@/lib/attendanceLabels";
import { decideAttendanceClarification } from "@/lib/workforceAttendance";

function time(value: string | null | undefined) {
  return value ? new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta" }).format(new Date(value)) : "?";
}
function longDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

/**
 * ATT-011-3 §6.2: one employee-day as a side panel. Scans, sessions, leave, clarifications and overtime
 * read-only; actions only for the permission that owns them. A missing time shows "?", never a time
 * from the schedule (I-3, I-4). Technical details stay folded.
 */
export function AttendanceDayPanel({ employeeId, workDate, canDecide, canCorrect, onClose, onChanged }: {
  employeeId: string;
  workDate: string;
  canDecide: boolean;
  canCorrect: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [day, setDay] = useState<AttendanceDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    setDay(null);
    setError(null);
    void getAttendanceDay(employeeId, workDate)
      .then((value) => { if (live) setDay(value); })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : "Detail hari tidak dapat dimuat."); });
    return () => { live = false; };
  }, [employeeId, workDate, version]);

  const refresh = (message: string) => { setNotice(message); setVersion((value) => value + 1); onChanged(); };

  const decide = async (clarificationId: string, decision: "approve" | "reject") => {
    setDeciding(clarificationId);
    setError(null);
    try {
      await decideAttendanceClarification(clarificationId, decision, note.trim() || null);
      setNote("");
      refresh(decision === "approve" ? "Klarifikasi disetujui." : "Klarifikasi ditolak.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Keputusan gagal disimpan.");
    } finally {
      setDeciding(null);
    }
  };

  const askEmployee = async () => {
    setError(null);
    try {
      const outcome = await requestEmployeeClarification(employeeId, workDate);
      setNotice(outcome.notified ? "Permintaan klarifikasi dikirim ke pegawai." : "Pegawai belum punya akun aktif; hubungi langsung.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Permintaan gagal dikirim.");
    }
  };

  const waiting = day?.clarifications.filter((item) => item.status === "submitted") ?? [];
  return (
    <aside className="fixed inset-y-0 right-0 z-40 w-full max-w-lg overflow-y-auto border-l bg-surface-raised p-5 shadow-xl" aria-label="Detail kehadiran satu hari">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-brand-heading">{day?.employee.fullName ?? "…"}</h2>
          <p className="text-xs text-muted-foreground">{longDate(workDate)}{day?.employee.unitName ? ` · ${day.employee.unitName}` : ""}</p>
        </div>
        <button type="button" aria-label="Tutup" onClick={onClose} className="rounded-lg border p-1"><X className="h-4 w-4" /></button>
      </div>
      {error ? <p className="mt-3 flex gap-2 rounded-xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink" role="alert"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</p> : null}
      {notice ? <p className="mt-3 flex gap-2 rounded-xl border border-success-line bg-success-soft p-3 text-sm text-success-ink"><CheckCircle2 className="h-4 w-4 shrink-0" />{notice}</p> : null}
      {!day && !error ? <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat…</p> : null}
      {day ? (
        <div className="mt-4 grid gap-4 text-sm">
          <section>
            <p className="font-semibold">
              {day.schedule.state === "scheduled"
                ? `${day.schedule.name ?? "Shift"} ${time(day.schedule.scheduledStartAt)}–${time(day.schedule.scheduledEndAt)} (toleransi ${day.schedule.lateGraceMinutes} mnt)`
                : day.schedule.state === "off" ? "Tidak ada jadwal kerja" : "Jadwal bermasalah"}
            </p>
            <p className="text-muted-foreground">Status: {day.result ? calculationRowStatusLabel(day.result.status as AttendanceCalculationRowStatus) : "Belum dihitung"}</p>
            {day.result && (day.result.lateMinutes > 0 || day.result.earlyLeaveMinutes > 0) ? (
              <p className="text-xs text-muted-foreground">{[day.result.lateMinutes ? `Terlambat ${day.result.lateMinutes} mnt` : null, day.result.earlyLeaveMinutes ? `Pulang cepat ${day.result.earlyLeaveMinutes} mnt` : null].filter(Boolean).join(" · ")}</p>
            ) : null}
          </section>
          {day.result?.blocks && day.result.blocks.length > 1 ? (
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Blok kerja</h3>
              <ul className="mt-1 grid gap-1 tabular-nums">
                {day.result.blocks.map((block) => (
                  <li key={block.sequence}>
                    Blok {block.sequence} · {time(block.scheduledStartAt)}–{time(block.scheduledEndAt)} · scan {block.firstCheckInAt || block.lastCheckOutAt ? `${time(block.firstCheckInAt)} – ${time(block.lastCheckOutAt)}` : "—"} · {calculationRowStatusLabel(block.status as AttendanceCalculationRowStatus)}
                    {block.lateMinutes ? ` · terlambat ${block.lateMinutes} mnt` : ""}{block.earlyLeaveMinutes ? ` · pulang cepat ${block.earlyLeaveMinutes} mnt` : ""}
                    {block.expectedWorkday !== undefined && block.expectedWorkday !== null ? ` · hari kerja ${block.creditedWorkday ?? "—"} dari ${block.expectedWorkday}` : ""}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Data scan</h3>
            <ul className="mt-1 grid gap-1">
              {day.punches.map((punch) => (
                <li key={`${punch.source}:${punch.id}:${punch.boundary ?? ""}`} className="grid gap-1">
                  <span className="tabular-nums">{time(punch.occurredAt)} · {transactionSourceLabel(punch)}{punch.reviewState === "needs_review" ? " · Perlu ditinjau" : ""}</span>
                  {punch.evidence ? <MobileEvidencePanel evidence={punch.evidence} /> : null}
                </li>
              ))}
              {day.punches.length === 0 ? <li className="text-muted-foreground">Tidak ada scan.</li> : null}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">Data scan asli tetap disimpan; koreksi menambah catatan, tidak mengubahnya.</p>
          </section>
          {day.result?.sessions.length ? (
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Sesi kerja</h3>
              <ul className="mt-1 grid gap-1 tabular-nums">
                {day.result.sessions.map((session) => <li key={session.sequence}>{session.sequence}. {time(session.checkInAt)} – {time(session.checkOutAt)}{session.complete ? "" : " · belum lengkap"}</li>)}
              </ul>
            </section>
          ) : null}
          <section className="grid gap-1 text-xs">
            <p>Cuti/izin: {day.leave.length ? day.leave.map((item) => item.name).join(", ") : "—"}</p>
            <p>Lembur: {day.overtime.length ? day.overtime.map((item) => `${item.approvedMinutes ?? item.requestedMinutes} mnt (${requestStatusLabel(item.status)})`).join(", ") : "—"}</p>
            <p>Klarifikasi: {day.clarifications.length ? day.clarifications.map((item) => `${clarificationKindLabel(item.kind)} · ${requestStatusLabel(item.status)}`).join("; ") : "—"}</p>
          </section>
          {canDecide && waiting.length ? (
            <section className="rounded-xl border p-3">
              {waiting.map((item) => (
                <div key={item.id} className="grid gap-2">
                  <p className="font-semibold">{clarificationKindLabel(item.kind)} · {clarificationModeLabel(item.mode)}</p>
                  <p className="text-xs text-muted-foreground">{item.reason}</p>
                  <input className="h-9 rounded-xl border px-3 text-sm" placeholder="Catatan keputusan (opsional)" value={note} onChange={(event) => setNote(event.target.value)} />
                  <div className="flex gap-2">
                    <button type="button" disabled={deciding !== null} onClick={() => void decide(item.id, "approve")} className="h-9 rounded-xl bg-brand-primary px-3 text-xs font-bold text-brand-foreground disabled:opacity-50">Setujui</button>
                    <button type="button" disabled={deciding !== null} onClick={() => void decide(item.id, "reject")} className="h-9 rounded-xl border px-3 text-xs font-bold disabled:opacity-50">Tolak</button>
                  </div>
                </div>
              ))}
            </section>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {canCorrect && !correcting ? <button type="button" onClick={() => setCorrecting(true)} className="h-9 rounded-xl border px-3 text-xs font-bold">Perbaiki jam</button> : null}
            {canDecide || canCorrect ? <button type="button" onClick={() => void askEmployee()} className="h-9 rounded-xl border px-3 text-xs font-bold">Minta klarifikasi pegawai</button> : null}
            {day.schedule.state === "configuration_error" ? <a href="/admin/attendance/schedules" className="inline-flex h-9 items-center rounded-xl border px-3 text-xs font-bold">Buka di Jadwal</a> : null}
          </div>
          {correcting ? (
            <div className="rounded-xl border p-3">
              <CorrectionEntryForm
                employee={{ id: day.employee.id, fullName: day.employee.fullName, employeeNumber: day.employee.employeeNumber }}
                initialDate={workDate}
                onSaved={() => { setCorrecting(false); refresh("Koreksi disimpan."); }}
                onCancel={() => setCorrecting(false)}
              />
            </div>
          ) : null}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Detail teknis</summary>
            <p className="mt-1">Versi hasil {day.result?.version ?? "—"}{day.result ? `, dihitung ${new Date(day.result.createdAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}` : ""}. Sumber jadwal: {day.schedule.rosterId ? "jadwal per tanggal" : day.schedule.state === "scheduled" ? "pola jadwal" : "—"}.</p>
          </details>
        </div>
      ) : null}
    </aside>
  );
}
