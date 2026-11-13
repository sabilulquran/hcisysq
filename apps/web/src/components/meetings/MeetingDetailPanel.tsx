// CAL-001 §12 meeting detail: participants with their answers and flags, Hadir/Berhalangan for
// attendees, Ubah/Batalkan for the organizer. What the viewer may do comes from the API
// (`canEdit`, `canCancel`, `canRespond`); the flags shown only to the organizer arrive as null
// for everyone else.

import { CalendarClock, Lock, MapPin, UserRound } from "lucide-react";

import {
  formatMeetingRange,
  meetingEventLabel,
  RESPONSE_LABELS,
  type MeetingDetail,
  type ParticipantResponse,
} from "@/lib/meetings";

const responseTone: Record<ParticipantResponse, string> = {
  PENDING: "border-border bg-surface text-muted-foreground",
  ACCEPTED: "border-success-line bg-success-soft text-success-ink",
  DECLINED: "border-warning-line bg-warning-soft text-warning-ink",
};

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

export function MeetingDetailPanel({
  meeting,
  busy,
  whatsappActive,
  onRespond,
  onEdit,
  onCancel,
}: {
  meeting: MeetingDetail;
  busy: boolean;
  whatsappActive: boolean;
  onRespond: (response: "ACCEPTED" | "DECLINED") => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const cancelled = meeting.status === "CANCELLED";
  const organizer = meeting.me.role === "ORGANIZER";
  const counts = meeting.participants.reduce<Record<ParticipantResponse, number>>(
    (total, participant) => ({ ...total, [participant.response]: total[participant.response] + 1 }),
    { PENDING: 0, ACCEPTED: 0, DECLINED: 0 },
  );

  return (
    // Shown inside a DetailDialog whose header carries the meeting title and the close button.
    <article>
      {cancelled || meeting.confidential ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {cancelled ? <span className="rounded-full border border-danger-line bg-danger-soft px-2 py-0.5 text-[11px] font-bold text-danger-ink">Dibatalkan</span> : null}
          {meeting.confidential ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-bold text-muted-foreground">
              <Lock className="h-3 w-3" aria-hidden="true" />Rahasia
            </span>
          ) : null}
        </div>
      ) : null}

      <dl className="space-y-2 text-sm text-brand-heading">
        <div className="flex gap-2"><CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary-deep" aria-hidden="true" /><dd>{formatMeetingRange(meeting.startAt, meeting.endAt)}</dd></div>
        {meeting.location ? <div className="flex gap-2"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary-deep" aria-hidden="true" /><dd>{meeting.location}</dd></div> : null}
        <div className="flex gap-2"><UserRound className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary-deep" aria-hidden="true" /><dd>Penyelenggara: {meeting.organizerName}</dd></div>
      </dl>
      {cancelled && meeting.cancelReason ? (
        <p className="mt-3 rounded-2xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">Alasan batal: {meeting.cancelReason}</p>
      ) : null}
      {meeting.description ? <p className="mt-3 whitespace-pre-line rounded-2xl bg-surface p-3 text-sm text-brand-heading">{meeting.description}</p> : null}

      {!organizer ? (
        <div className="mt-4">
          <p className="text-sm text-muted-foreground">
            Jawaban Anda: <span className="font-semibold text-brand-heading">{RESPONSE_LABELS[meeting.me.response]}</span>
            {meeting.me.responseNote ? ` — ${meeting.me.responseNote}` : ""}
          </p>
          {meeting.canRespond ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" disabled={busy || meeting.me.response === "ACCEPTED"} onClick={() => onRespond("ACCEPTED")}
                className="min-h-11 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
                Hadir
              </button>
              <button type="button" disabled={busy || meeting.me.response === "DECLINED"} onClick={() => onRespond("DECLINED")}
                className="min-h-11 rounded-xl border border-border px-4 text-sm font-bold text-brand-heading disabled:opacity-50">
                Berhalangan
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {meeting.canEdit || meeting.canCancel ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {meeting.canEdit ? (
            <button type="button" disabled={busy} onClick={onEdit}
              className="min-h-11 rounded-xl border border-border px-4 text-sm font-bold text-brand-heading disabled:opacity-50">
              Ubah
            </button>
          ) : null}
          {meeting.canCancel ? (
            <button type="button" disabled={busy} onClick={onCancel}
              className="min-h-11 rounded-xl border border-danger-line px-4 text-sm font-bold text-danger-ink disabled:opacity-50">
              Batalkan rapat
            </button>
          ) : null}
        </div>
      ) : null}

      <section className="mt-5">
        <h3 className="text-sm font-bold text-brand-heading">
          Peserta ({meeting.participants.length}) · {counts.ACCEPTED} hadir · {counts.DECLINED} berhalangan · {counts.PENDING} belum menjawab
        </h3>
        <ul className="mt-2 divide-y divide-border/70 rounded-2xl border border-border/70">
          {meeting.participants.map((participant) => (
            <li key={participant.employeeId} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="font-semibold text-brand-heading">
                  {participant.name}{participant.role === "ORGANIZER" ? " (penyelenggara)" : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  {participant.unitName ?? "Tanpa unit"}
                  {participant.unavailableReason === "LEAVE" ? " · berhalangan (cuti)" : ""}
                  {participant.unavailableReason === "TRIP" ? " · berhalangan (dinas)" : ""}
                  {participant.hasAccount === false ? " · belum punya akun" : ""}
                  {whatsappActive && participant.hasWhatsApp === false ? " · tanpa nomor WA" : ""}
                </p>
                {participant.responseNote ? <p className="mt-0.5 text-xs text-brand-heading">"{participant.responseNote}"</p> : null}
              </div>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${responseTone[participant.response]}`}>
                {RESPONSE_LABELS[participant.response]}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {meeting.events.length > 0 ? (
        <section className="mt-5">
          <h3 className="text-sm font-bold text-brand-heading">Riwayat</h3>
          <ol className="mt-2 space-y-1 text-xs text-muted-foreground">
            {meeting.events.map((event) => (
              <li key={event.id}>
                {formatTimestamp(event.occurredAt)} · {meetingEventLabel(event.eventType)}{event.actorName ? ` oleh ${event.actorName}` : ""}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </article>
  );
}
