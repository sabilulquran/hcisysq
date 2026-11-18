// TRIP-002 detail shared by the employee and Finance/HC screens: trip, advance, settlement,
// transactions, claims, approval steps and history. Every action is passed in; this component
// decides nothing and computes no amount — the API sends the totals.

import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import { claimStatusLabel } from "@/lib/reimbursements";
import {
  advanceEventLabel,
  advanceStatusLabel,
  approverRoleLabel,
  balanceLabel,
  formatRupiah,
  formatTimestamp,
  METHOD_LABELS,
  TRANSACTION_LABELS,
  type AdvanceDetail,
} from "@/lib/tripAdvances";

const STEP_LABELS: Record<string, string> = {
  waiting: "Menunggu giliran",
  pending: "Sedang diputuskan",
  approved: "Disetujui",
  rejected: "Ditolak",
  cancelled: "Tidak dijalankan",
};

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-surface px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-bold tabular-nums text-brand-heading">{value}</dd>
    </div>
  );
}

export function TripAdvanceDetailPanel({ advance, actions }: { advance: AdvanceDetail; actions?: ReactNode }) {
  const settled = advance.settlementBalance !== null;
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold text-muted-foreground">{advanceStatusLabel(advance.status)}</p>
        <h3 className="mt-1 text-lg font-bold text-brand-heading">{advance.tripDestination}</h3>
        <p className="mt-1 text-sm text-foreground">
          {advance.employeeName} · {advance.employeeNumber}{advance.unitName ? ` · ${advance.unitName}` : ""}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {advance.tripStartOn} – {advance.tripEndOn} · {advance.wilayahLabel}
        </p>
        {advance.overdue ? (
          <p className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-danger-ink">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Terlambat dipertanggungjawabkan (tenggat {advance.dueOn})
          </p>
        ) : advance.status === "DISBURSED" ? (
          <p className="mt-2 text-sm text-muted-foreground">Tenggat pertanggungjawaban: {advance.dueOn}</p>
        ) : null}
        {advance.rejectReason ? (
          <p className="mt-2 text-sm text-danger-ink">
            {advance.rejectedBy === "FINANCE" ? "Ditolak Keuangan" : "Ditolak penyetuju"}: {advance.rejectReason}
          </p>
        ) : null}
        {advance.cancelReason ? <p className="mt-2 text-sm text-danger-ink">Alasan pembatalan: {advance.cancelReason}</p> : null}
        <p className="mt-2 whitespace-pre-line text-sm text-foreground">{advance.purpose}</p>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        <Figure label={advance.amount === 0 ? "Uang muka (hanya uang harian)" : "Uang muka"} value={formatRupiah(advance.amount)} />
        {settled ? (
          <>
            <Figure
              label={`Uang harian (${advance.perDiemDays} hari × ${formatRupiah(advance.perDiemRate ?? 0)}${advance.perDiemGolonganLabel ? ` · ${advance.perDiemGolonganLabel}` : ""})`}
              value={formatRupiah(advance.perDiemAmount ?? 0)}
            />
            <Figure label="Klaim diperhitungkan" value={formatRupiah(advance.claimsTotal ?? 0)} />
            <Figure label={`Selisih · ${balanceLabel(advance.settlementBalance)}`} value={formatRupiah(Math.abs(advance.settlementBalance ?? 0))} />
            {advance.settlementBalance !== null && advance.settlementBalance < 0 ? (
              <Figure label="Sisa yang harus dikembalikan" value={formatRupiah(advance.refundOutstanding)} />
            ) : null}
          </>
        ) : null}
      </dl>
      {advance.settlementFinanceNote ? <p className="text-sm text-muted-foreground">Catatan Keuangan: {advance.settlementFinanceNote}</p> : null}
      {/* D-21: siapa yang menyatakan adalah fakta audit, jadi pernyataan pegawai dan penetapan
          Keuangan tidak pernah ditulis sebagai hal yang sama. */}
      {advance.organizerPerDiemDeclared ? (
        <p className="text-sm text-muted-foreground">
          Pegawai menyatakan uang saku untuk penugasan ini sudah diterima dari penyelenggara.
        </p>
      ) : null}
      {advance.organizerPerDiemSource === "FINANCE" ? (
        <p className="text-sm text-muted-foreground">
          Keuangan {advance.organizerPerDiemApplied ? "menetapkan" : "mengoreksi menjadi"} uang saku
          {advance.organizerPerDiemApplied ? " sudah" : " belum"} diterima dari penyelenggara
          {advance.organizerPerDiemOverrideReason ? `: ${advance.organizerPerDiemOverrideReason}` : ""}.
        </p>
      ) : null}
      {advance.perDiemWaiveReason ? (
        <p className="text-sm text-muted-foreground">Alasan uang harian ditahan: {advance.perDiemWaiveReason}</p>
      ) : null}

      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}

      {advance.transactions.length > 0 ? (
        <section>
          <h4 className="text-sm font-bold text-brand-heading">Transaksi</h4>
          <ul className="mt-2 divide-y divide-border/70 rounded-2xl border border-border/70">
            {advance.transactions.map((transaction) => (
              <li key={transaction.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>
                  <span className="font-semibold text-brand-heading">{TRANSACTION_LABELS[transaction.kind]}</span>
                  <span className="block text-xs text-muted-foreground">
                    {transaction.transactedOn} · {METHOD_LABELS[transaction.method]}{transaction.reference ? ` · ${transaction.reference}` : ""}
                    {transaction.recordedByName ? ` · dicatat ${transaction.recordedByName}` : ""}
                  </span>
                </span>
                <span className="font-bold tabular-nums">{formatRupiah(transaction.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h4 className="text-sm font-bold text-brand-heading">Klaim biaya perjalanan ini</h4>
        {advance.settledClaims.length > 0 ? (
          <ul className="mt-2 divide-y divide-border/70 rounded-2xl border border-border/70">
            {advance.settledClaims.map((claim) => (
              <li key={claim.claimId} className="flex justify-between gap-2 px-3 py-2 text-sm">
                <span>{claim.title} <span className="text-xs text-muted-foreground">· diperhitungkan</span></span>
                <span className="font-bold tabular-nums">{formatRupiah(claim.verifiedTotal)}</span>
              </li>
            ))}
          </ul>
        ) : advance.linkedClaims.length > 0 ? (
          <ul className="mt-2 divide-y divide-border/70 rounded-2xl border border-border/70">
            {advance.linkedClaims.map((claim) => (
              <li key={claim.id} className="flex flex-wrap justify-between gap-2 px-3 py-2 text-sm">
                <span>{claim.title} <span className="text-xs text-muted-foreground">· {claimStatusLabel(claim.status)}</span></span>
                <span className="font-bold tabular-nums">{formatRupiah(claim.verifiedTotal ?? claim.claimedTotal)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">Belum ada klaim Reimbursement yang ditautkan ke perjalanan ini.</p>
        )}
      </section>

      <section>
        <h4 className="text-sm font-bold text-brand-heading">Persetujuan</h4>
        <ol className="mt-2 space-y-2">
          {advance.steps.map((step) => (
            <li key={step.id} className="rounded-xl border border-border/70 bg-surface px-3 py-2 text-sm">
              <span className="font-semibold text-brand-heading">{step.order}. {step.approverName}</span>
              <span className="ml-2 text-xs text-muted-foreground">{approverRoleLabel(step.sources)} · {STEP_LABELS[step.status] ?? step.status}</span>
              {step.decisionNote ? <p className="mt-1 text-xs text-foreground">{step.decisionNote}</p> : null}
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h4 className="text-sm font-bold text-brand-heading">Riwayat</h4>
        <ol className="mt-2 space-y-1.5 text-sm">
          {advance.events.map((event) => (
            <li key={event.id}>
              <span className="font-semibold text-brand-heading">{advanceEventLabel(event.eventType)}</span>
              <span className="text-xs text-muted-foreground"> · {formatTimestamp(event.occurredAt)}{event.actorName ? ` · ${event.actorName}` : ""}</span>
              {event.note ? <p className="text-xs text-foreground">{event.note}</p> : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
