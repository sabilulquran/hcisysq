// LOAN-001 detail shared by the employee and Finance screens: balance, instalment schedule,
// repayments, approval steps and history. Every action is passed in; this component decides
// nothing and computes no amount — the API sends the schedule and the balance.

import type { ReactNode } from "react";

import {
  approverRoleLabel,
  formatLoanDate,
  formatLoanMonth,
  formatRupiah,
  formatTimestamp,
  loanEventLabel,
  loanStatusLabel,
  PAYMENT_METHOD_LABELS,
  type LoanDetail,
  type LoanPayment,
} from "@/lib/loans";

const STEP_LABELS: Record<string, string> = {
  waiting: "Menunggu giliran",
  pending: "Sedang diputuskan",
  approved: "Disetujui",
  rejected: "Ditolak",
  cancelled: "Tidak dijalankan",
};

const INSTALMENT_LABELS = { PAID: "Lunas", PARTIAL: "Sebagian", UNPAID: "Belum dibayar" } as const;

export function LoanDetailPanel({ loan, actions, paymentAction }: {
  loan: LoanDetail;
  actions?: ReactNode;
  /** Finance only: a control shown beside each payment still in force (reversal). */
  paymentAction?: (payment: LoanPayment) => ReactNode;
}) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold text-muted-foreground">{loanStatusLabel(loan.status)}</p>
        <h3 className="mt-1 text-lg font-bold text-brand-heading">
          {formatRupiah(loan.principal)} · {loan.tenorMonths} bulan
        </h3>
        <p className="mt-1 text-sm text-foreground">{loan.employeeName} · {loan.employeeNumber}{loan.unitName ? ` · ${loan.unitName}` : ""}</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{loan.purpose}</p>
        {loan.cancelReason ? <p className="mt-2 text-sm text-danger-ink">Alasan pembatalan: {loan.cancelReason}</p> : null}
      </div>

      {loan.disbursedOn ? (
        <dl className="grid grid-cols-3 gap-2 text-sm">
          {([
            ["Pokok", loan.principal],
            ["Sudah dibayar", loan.paidTotal],
            ["Sisa", loan.outstanding],
          ] as const).map(([label, value]) => (
            <div key={label} className="rounded-xl border border-border/70 bg-surface px-3 py-2">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="font-bold tabular-nums text-brand-heading">{formatRupiah(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}

      {loan.schedule.length > 0 ? (
        <section>
          <h4 className="text-sm font-bold text-brand-heading">Jadwal cicilan</h4>
          <p className="text-xs text-muted-foreground">
            Dicairkan {formatLoanDate(loan.disbursedOn!)} · tanpa bunga · pembayaran melunasi cicilan paling awal lebih dulu.
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[22rem] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr><th className="py-1 pr-2">#</th><th className="py-1 pr-2">Bulan</th><th className="py-1 pr-2 text-right">Cicilan</th><th className="py-1 pr-2 text-right">Terbayar</th><th className="py-1">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {loan.schedule.map((row) => (
                  <tr key={row.sequence}>
                    <td className="py-1.5 pr-2 text-muted-foreground">{row.sequence}</td>
                    <td className="py-1.5 pr-2">{formatLoanMonth(row.dueMonth)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{formatRupiah(row.amount)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{formatRupiah(row.paid)}</td>
                    <td className={`py-1.5 text-xs font-semibold ${row.overdue ? "text-danger-ink" : "text-muted-foreground"}`}>
                      {INSTALMENT_LABELS[row.state]}{row.overdue ? " · lewat bulan" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {loan.payments.length > 0 ? (
        <section>
          <h4 className="text-sm font-bold text-brand-heading">Pembayaran</h4>
          <ul className="mt-2 space-y-2">
            {loan.payments.map((payment) => (
              <li key={payment.id} className="rounded-xl border border-border/70 bg-surface px-3 py-2 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className={`font-semibold tabular-nums ${payment.status === "REVERSED" ? "text-muted-foreground line-through" : "text-brand-heading"}`}>
                      {formatRupiah(payment.amount)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatLoanDate(payment.paidOn)} · {PAYMENT_METHOD_LABELS[payment.method]}
                      {payment.reference ? ` · ${payment.reference}` : ""}
                      {payment.recordedByName ? ` · dicatat ${payment.recordedByName}` : ""}
                    </p>
                    {payment.note ? <p className="mt-1 text-xs text-foreground">{payment.note}</p> : null}
                    {payment.status === "REVERSED" ? (
                      <p className="mt-1 text-xs text-danger-ink">Dikoreksi: {payment.reverseReason}</p>
                    ) : null}
                  </div>
                  {payment.status === "ACTIVE" && paymentAction ? paymentAction(payment) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h4 className="text-sm font-bold text-brand-heading">Tahap persetujuan</h4>
        <ol className="mt-2 space-y-2">
          {loan.steps.map((step) => (
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
          {loan.events.map((event) => (
            <li key={event.id} className="text-sm">
              <p className="font-semibold text-brand-heading">{loanEventLabel(event.eventType)}</p>
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
