// TRIP-001 detail shared by the employee and Human Capital screens: approval steps, history,
// and the printable surat tugas. Every action is passed in; this component decides nothing.

import { Printer } from "lucide-react";
import type { ReactNode } from "react";

import {
  approverRoleLabel,
  formatTimestamp,
  formatTripDate,
  formatTripRange,
  tripEventLabel,
  tripStatusLabel,
  type AssignmentLetter,
  type TripDetail,
} from "@/lib/trips";

const STEP_LABELS: Record<string, string> = {
  waiting: "Menunggu giliran",
  pending: "Sedang diputuskan",
  approved: "Disetujui",
  rejected: "Ditolak",
  cancelled: "Tidak dijalankan",
};

function AssignmentLetterPaper({ letter }: { letter: AssignmentLetter }) {
  const content = letter.content;
  const rows: Array<[string, string | null | undefined]> = [
    ["Nama", content.fullName],
    ["NIP", content.employeeNumber],
    ["Jabatan", content.positionTitle],
    ["Unit", content.unitName],
    ["Tujuan", content.destination],
    ["Keperluan", content.purpose],
    ["Tanggal", content.tripStartOn && content.tripEndOn ? formatTripRange(content.tripStartOn, content.tripEndOn) : null],
  ];
  return (
    <article className="trip-letter-paper sq-paper rounded-2xl border border-border bg-white p-6 text-sm text-slate-900">
      <p className="text-center text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">Yayasan Sabilul Qur&apos;an</p>
      <h3 className="mt-2 text-center text-lg font-bold">SURAT TUGAS</h3>
      <p className="text-center text-xs">Nomor: {letter.documentNumber}</p>
      {letter.status === "REVOKED" ? (
        <p className="mt-3 rounded-lg border border-red-300 bg-red-50 p-2 text-center text-xs font-bold text-red-700">DICABUT — surat ini tidak berlaku</p>
      ) : null}
      <p className="mt-5">Yang bertanda tangan di bawah ini menugaskan:</p>
      <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-slate-600">{label}</dt>
            <dd className="font-medium">{value ?? "-"}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4">Demikian surat tugas ini dibuat untuk dilaksanakan dengan penuh tanggung jawab.</p>
      <div className="mt-8 ml-auto w-56 text-center">
        <p>{formatTripDate(letter.issuedAt.slice(0, 10))}</p>
        <p className="mt-1">{letter.signer.title ?? ""}</p>
        <p className="mt-14 font-bold underline">{letter.signer.name ?? "-"}</p>
      </div>
    </article>
  );
}

export function TripDetailPanel({ trip, actions }: { trip: TripDetail; actions?: ReactNode }) {
  return (
    <div className="space-y-5">
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 18mm; }
          body * { visibility: hidden !important; }
          .trip-letter-paper, .trip-letter-paper * { visibility: visible !important; }
          .trip-letter-paper { position: absolute !important; inset: 0 auto auto 0 !important; width: 100% !important; border: 0 !important; }
        }
      `}</style>
      <div>
        <p className="text-xs font-semibold text-muted-foreground">{tripStatusLabel(trip.status)}</p>
        <h3 className="mt-1 text-lg font-bold text-brand-heading">{trip.destination}</h3>
        <p className="mt-1 text-sm text-foreground">{formatTripRange(trip.startOn, trip.endOn)} · {trip.employeeName}</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{trip.purpose}</p>
        {trip.cancelReason ? <p className="mt-2 text-sm text-danger-ink">Alasan pembatalan: {trip.cancelReason}</p> : null}
        {trip.completionReport ? <p className="mt-2 text-sm text-foreground">Laporan: {trip.completionReport}</p> : null}
      </div>

      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}

      <section>
        <h4 className="text-sm font-bold text-brand-heading">Tahap persetujuan</h4>
        <ol className="mt-2 space-y-2">
          {trip.steps.map((step) => (
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

      {trip.assignmentLetter ? (
        <section>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-bold text-brand-heading">Surat tugas</h4>
            {trip.assignmentLetter.status === "ISSUED" ? (
              <button type="button" onClick={() => window.print()}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading">
                <Printer className="h-4 w-4" aria-hidden="true" /> Cetak
              </button>
            ) : null}
          </div>
          <div className="mt-2 overflow-x-auto">
            <AssignmentLetterPaper letter={trip.assignmentLetter} />
          </div>
        </section>
      ) : null}

      <section>
        <h4 className="text-sm font-bold text-brand-heading">Riwayat</h4>
        <ol className="mt-2 space-y-1.5 border-l border-border pl-4">
          {trip.events.map((event) => (
            <li key={event.id} className="text-sm">
              <p className="font-semibold text-brand-heading">{tripEventLabel(event.eventType)}</p>
              <p className="text-xs text-muted-foreground">
                {formatTimestamp(event.occurredAt)}{event.actorName ? ` · ${event.actorName}` : ""}
                {typeof event.metadata.documentNumber === "string" ? ` · ${event.metadata.documentNumber}` : ""}
              </p>
              {event.note ? <p className="text-xs text-foreground">{event.note}</p> : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
