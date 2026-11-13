// REIMB-001 detail shared by the employee, approver and Finance screens: items, receipts,
// verification, payment, approval steps and history. Every action is passed in; this component
// decides nothing and computes no amount — the API sends the totals.

import { AlertTriangle, FileText } from "lucide-react";
import type { ReactNode } from "react";

import {
  approverRoleLabel,
  claimEventLabel,
  claimStatusLabel,
  formatClaimDate,
  formatRupiah,
  formatTimestamp,
  PAYMENT_METHOD_LABELS,
  type ClaimDetail,
  type ClaimReceipt,
} from "@/lib/reimbursements";

const STEP_LABELS: Record<string, string> = {
  waiting: "Menunggu giliran",
  pending: "Sedang diputuskan",
  approved: "Disetujui",
  rejected: "Ditolak",
  cancelled: "Tidak dijalankan",
};

export function ReimbursementDetailPanel({ claim, receiptHref, actions, receiptAction, itemAction }: {
  claim: ClaimDetail;
  /** Where a receipt downloads from; differs per audience (owner, approver, register). */
  receiptHref: (receipt: ClaimReceipt) => string;
  actions?: ReactNode;
  /** Draft only: a control beside each receipt (remove). */
  receiptAction?: (receipt: ClaimReceipt) => ReactNode;
  /** Finance verification: a control beside each item (approved amount). */
  itemAction?: (itemId: string) => ReactNode;
}) {
  const verified = claim.verifiedTotal !== null && claim.verifiedTotal !== undefined;
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold text-muted-foreground">{claimStatusLabel(claim.status)}</p>
        <h3 className="mt-1 text-lg font-bold text-brand-heading">{claim.title}</h3>
        <p className="mt-1 text-sm text-foreground">{claim.employeeName} · {claim.employeeNumber}{claim.unitName ? ` · ${claim.unitName}` : ""}</p>
        {claim.tripDestination ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Perjalanan dinas: {claim.tripDestination}
            {claim.tripStartOn ? ` · ${formatClaimDate(claim.tripStartOn)}${claim.tripEndOn && claim.tripEndOn !== claim.tripStartOn ? ` – ${formatClaimDate(claim.tripEndOn)}` : ""}` : ""}
          </p>
        ) : null}
        {claim.rejectReason ? (
          <p className="mt-2 text-sm text-danger-ink">
            {claim.rejectedBy === "FINANCE" ? "Ditolak Keuangan" : "Ditolak penyetuju"}: {claim.rejectReason}
          </p>
        ) : null}
        {claim.cancelReason && claim.status === "CANCELLED" ? <p className="mt-2 text-sm text-danger-ink">Alasan pembatalan: {claim.cancelReason}</p> : null}
      </div>

      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-xl border border-border/70 bg-surface px-3 py-2">
          <dt className="text-xs text-muted-foreground">Diklaim</dt>
          <dd className="font-bold tabular-nums text-brand-heading">{formatRupiah(claim.claimedTotal)}</dd>
        </div>
        {verified ? (
          <div className="rounded-xl border border-border/70 bg-surface px-3 py-2">
            <dt className="text-xs text-muted-foreground">Disetujui Keuangan</dt>
            <dd className="font-bold tabular-nums text-brand-heading">{formatRupiah(claim.verifiedTotal!)}</dd>
          </div>
        ) : null}
        {claim.payment ? (
          <div className="rounded-xl border border-border/70 bg-surface px-3 py-2">
            <dt className="text-xs text-muted-foreground">Dibayar</dt>
            <dd className="font-bold tabular-nums text-brand-heading">{formatRupiah(claim.payment.amount)}</dd>
          </div>
        ) : null}
      </dl>

      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}

      <section>
        <h4 className="text-sm font-bold text-brand-heading">Rincian biaya</h4>
        <ul className="mt-2 space-y-2">
          {claim.items.map((item) => (
            <li key={item.id} className="rounded-xl border border-border/70 bg-surface px-3 py-2 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-brand-heading">{item.categoryLabel}</p>
                  <p className="text-xs text-muted-foreground">{formatClaimDate(item.expenseDate)} · {item.description}</p>
                </div>
                <div className="text-right tabular-nums">
                  <p className={item.approvedAmount !== null && item.approvedAmount !== undefined && item.approvedAmount < item.amount
                    ? "text-muted-foreground line-through" : "font-semibold text-brand-heading"}>
                    {formatRupiah(item.amount)}
                  </p>
                  {item.approvedAmount !== null && item.approvedAmount !== undefined && item.approvedAmount < item.amount ? (
                    <p className="font-semibold text-brand-heading">{formatRupiah(item.approvedAmount)}</p>
                  ) : null}
                </div>
              </div>
              {itemAction ? <div className="mt-2">{itemAction(item.id)}</div> : null}
            </li>
          ))}
        </ul>
        {claim.verificationNote ? <p className="mt-2 text-xs text-foreground">Catatan Keuangan: {claim.verificationNote}</p> : null}
      </section>

      <section>
        <h4 className="text-sm font-bold text-brand-heading">Bukti pembayaran</h4>
        {claim.receipts.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">Belum ada bukti.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {claim.receipts.map((receipt, index) => (
              <li key={receipt.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-surface px-3 py-2 text-sm">
                <a href={receiptHref(receipt)} className="inline-flex min-h-9 items-center gap-2 font-semibold text-brand-primary-deep underline-offset-2 hover:underline">
                  <FileText className="h-4 w-4" aria-hidden="true" />
                  Bukti {index + 1} ({receipt.contentType === "application/pdf" ? "PDF" : "gambar"}, {Math.max(1, Math.round(receipt.byteSize / 1024))} KB)
                </a>
                {receipt.duplicateClaims ? (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-danger-ink">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> Berkas yang sama ada di {receipt.duplicateClaims} klaim lain
                  </span>
                ) : null}
                {receiptAction ? receiptAction(receipt) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {claim.payment ? (
        <section>
          <h4 className="text-sm font-bold text-brand-heading">Pembayaran</h4>
          <p className="mt-1 text-sm text-foreground">
            {formatClaimDate(claim.payment.paidOn)} · {PAYMENT_METHOD_LABELS[claim.payment.method]}
            {claim.payment.payrollMonth ? ` ${claim.payment.payrollMonth}` : ""}
            {claim.payment.reference ? ` · ${claim.payment.reference}` : ""}
            {claim.payment.recordedByName ? ` · dicatat ${claim.payment.recordedByName}` : ""}
          </p>
          {claim.payment.note ? <p className="mt-1 text-xs text-foreground">{claim.payment.note}</p> : null}
        </section>
      ) : null}

      {claim.steps.length > 0 ? (
        <section>
          <h4 className="text-sm font-bold text-brand-heading">Tahap persetujuan</h4>
          <ol className="mt-2 space-y-2">
            {claim.steps.map((step) => (
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
      ) : null}

      {claim.events && claim.events.length > 0 ? (
        <section>
          <h4 className="text-sm font-bold text-brand-heading">Riwayat</h4>
          <ol className="mt-2 space-y-1.5 border-l border-border pl-4">
            {claim.events.map((event) => (
              <li key={event.id} className="text-sm">
                <p className="font-semibold text-brand-heading">{claimEventLabel(event.eventType)}</p>
                <p className="text-xs text-muted-foreground">
                  {formatTimestamp(event.occurredAt)}{event.actorName ? ` · ${event.actorName}` : ""}
                </p>
                {event.note ? <p className="text-xs text-foreground">{event.note}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
