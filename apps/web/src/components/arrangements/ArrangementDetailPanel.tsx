// ATT-015 detail shared by the employee and Human Capital screens: approval steps and history.
// Every action is passed in; this component decides nothing.

import type { ReactNode } from "react";

import {
  approverRoleLabel,
  arrangementEventLabel,
  arrangementStatusLabel,
  arrangementTypeLabel,
  formatArrangementRange,
  formatTimestamp,
  type ArrangementDetail,
} from "@/lib/workArrangements";

const STEP_LABELS: Record<string, string> = {
  waiting: "Menunggu giliran",
  pending: "Sedang diputuskan",
  approved: "Disetujui",
  rejected: "Ditolak",
  cancelled: "Tidak dijalankan",
};

export function ArrangementDetailPanel({ item, actions }: { item: ArrangementDetail; actions?: ReactNode }) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold text-muted-foreground">
          {arrangementTypeLabel(item.type)} · {arrangementStatusLabel(item.status, item.type)}
        </p>
        <h3 className="mt-1 text-lg font-bold text-brand-heading">
          {item.type === "SCHEDULE_CHANGE"
            ? `${item.currentScheduleName ?? "Jadwal"} → ${item.requestedScheduleName ?? "-"}`
            : item.location}
        </h3>
        <p className="mt-1 text-sm text-foreground">{formatArrangementRange(item.startOn, item.endOn)} · {item.employeeName}</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.purpose}</p>
        {item.cancelReason ? <p className="mt-2 text-sm text-danger-ink">Alasan pembatalan: {item.cancelReason}</p> : null}
        {item.type !== "SCHEDULE_CHANGE" && item.status === "APPROVED" ? (
          <p className="mt-2 rounded-xl border border-border/70 bg-surface p-2 text-xs text-muted-foreground">
            Hari tanpa scan pada tanggal ini tercatat sebagai {arrangementTypeLabel(item.type)}, bukan Tidak hadir. Jam masuk
            dan pulang tidak diisi otomatis.
          </p>
        ) : null}
      </div>

      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}

      <section>
        <h4 className="text-sm font-bold text-brand-heading">Tahap persetujuan</h4>
        <ol className="mt-2 space-y-2">
          {item.steps.map((step) => (
            <li key={step.id} className="rounded-xl border border-border/70 bg-surface px-3 py-2 text-sm">
              <p className="font-semibold text-brand-heading">{step.order}. {step.approverName}</p>
              <p className="text-xs text-muted-foreground">
                {approverRoleLabel(step.sources)} · {STEP_LABELS[step.status] ?? step.status}
                {step.actedAt ? ` · ${formatTimestamp(step.actedAt)}` : ""}
              </p>
              {step.decisionNote ? <p className="mt-1 text-xs text-foreground">Catatan: {step.decisionNote}</p> : null}
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h4 className="text-sm font-bold text-brand-heading">Riwayat</h4>
        <ol className="mt-2 space-y-1.5 border-l border-border pl-4">
          {item.events.map((event) => (
            <li key={event.id} className="text-sm">
              <p className="font-semibold text-brand-heading">{arrangementEventLabel(event.eventType)}</p>
              <p className="text-xs text-muted-foreground">
                {formatTimestamp(event.occurredAt)}{event.actorName ? ` · ${event.actorName}` : ""}
              </p>
              {event.note ? <p className="text-xs text-foreground">{event.note}</p> : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
