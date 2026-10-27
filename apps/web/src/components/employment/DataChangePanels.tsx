// EMP-003 P2-4 screens (spec §7.3, §7.4), presentational only so the tests
// can render them with data. Every refusal, and whether an accepted proposal
// can still be written, comes from the API.

import type { ReactNode } from "react";

import { formatDate, type EmploymentView } from "@/lib/employment";
import {
  STATE_LABEL,
  TARGET_LABEL,
  payloadLines,
  type DataChangeRequest,
  type DataChangeState,
} from "@/lib/employeeDataChanges";

const card = "rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]";
const quietButton = "rounded-xl border border-border/70 px-3 py-1.5 text-xs font-bold text-muted-foreground";
const primaryButton = "rounded-xl bg-brand-primary-deep px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60";

const STATE_TONE: Record<DataChangeState, string> = {
  DIAJUKAN: "bg-surface text-muted-foreground",
  DITERIMA: "bg-success-soft text-success-ink",
  DITOLAK: "bg-warning-soft text-warning-ink",
  DIBATALKAN: "bg-surface text-muted-foreground",
};

export function StateBadge({ state }: { state: DataChangeState }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATE_TONE[state]}`}>
      {STATE_LABEL[state]}
    </span>
  );
}

/** What the employee proposed, spelled out field by field. */
export function ProposalSummary({ request }: { request: DataChangeRequest }) {
  const lines = payloadLines(request.payload, request.target);
  if (lines.length === 0) return <p className="text-xs text-muted-foreground">Usulan ini tidak memuat nilai.</p>;
  return (
    <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
      {lines.map((line) => (
        <div key={line.label} className="flex gap-1">
          <dt className="font-bold text-brand-heading">{line.label}:</dt>
          <dd className="text-muted-foreground">{line.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ViewStates({ view, children }: { view: EmploymentView<unknown>; children: ReactNode }) {
  if (view.kind === "loading") return <p className="text-sm text-muted-foreground">Memuat data…</p>;
  if (view.kind === "forbidden") {
    return <p className="text-sm text-muted-foreground">Akun ini tidak berhak melihat usulan perubahan data.</p>;
  }
  if (view.kind === "disabled") return <p className="text-sm text-muted-foreground">Bagian ini belum diaktifkan.</p>;
  if (view.kind === "error") return <p role="alert" className="text-sm text-danger-ink">{view.message}</p>;
  return <>{children}</>;
}

/** §7.3: the employee's own proposals and where each one stands. */
export function MyDataChanges({ view, busy, onCancel }: {
  view: EmploymentView<DataChangeRequest[]>;
  busy?: boolean;
  onCancel: (requestId: string) => void;
}) {
  return (
    <article className={card}>
      <h2 className="text-base font-bold text-brand-heading">Usulan perubahan data saya</h2>
      <ViewStates view={view}>
        {view.kind === "ready" ? (
          view.data.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">Belum ada usulan.</p>
          ) : (
            <ul className="mt-4 grid gap-3">
              {view.data.map((row) => (
                <li key={row.id} className="rounded-xl border border-border/70 bg-surface p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm text-brand-heading">{TARGET_LABEL[row.target]}</strong>
                    <StateBadge state={row.state} />
                    <span className="text-xs text-muted-foreground">Diajukan {formatDate(row.createdAt.slice(0, 10))}</span>
                  </div>
                  <ProposalSummary request={row} />
                  {row.state === "DITOLAK" && row.decisionNote ? (
                    <p className="mt-2 text-xs text-warning-ink">Alasan penolakan: {row.decisionNote}</p>
                  ) : null}
                  {row.state === "DIAJUKAN" ? (
                    <button type="button" className={`${quietButton} mt-3`} disabled={busy} onClick={() => onCancel(row.id)}>
                      Batalkan usulan
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </ViewStates>
    </article>
  );
}

export interface WorklistActions {
  canDecide: boolean;
  busy?: boolean;
  onAccept: (requestId: string) => void;
  onReject: (requestId: string) => void;
}

/** §7.4: HC's queue, longest waiting first. */
export function DataChangeWorklistView({ view, actions, employeeHref }: {
  view: EmploymentView<{ rows: DataChangeRequest[]; total: number; state: DataChangeState }>;
  actions: WorklistActions;
  employeeHref: (employeeId: string) => string;
}) {
  return (
    <ViewStates view={view}>
      {view.kind === "ready" ? (
        view.data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Tidak ada usulan berstatus {STATE_LABEL[view.data.state].toLowerCase()}.
          </p>
        ) : (
          <ul className="grid gap-3">
            {view.data.rows.map((row) => (
              <li key={row.id} className={card}>
                <div className="flex flex-wrap items-center gap-2">
                  <a className="text-sm font-bold text-brand-primary-deep" href={employeeHref(row.employeeId)}>
                    {row.fullName}
                  </a>
                  <span className="text-xs text-muted-foreground">{row.employeeNumber}</span>
                  {row.unitName ? <span className="text-xs text-muted-foreground">· {row.unitName}</span> : null}
                  <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-bold">{TARGET_LABEL[row.target]}</span>
                  <StateBadge state={row.state} />
                  <span className="text-xs text-muted-foreground">Diajukan {formatDate(row.createdAt.slice(0, 10))}</span>
                </div>
                <ProposalSummary request={row} />
                {row.decisionNote ? (
                  <p className="mt-2 text-xs text-muted-foreground">Catatan keputusan: {row.decisionNote}</p>
                ) : null}
                {actions.canDecide && row.state === "DIAJUKAN" ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" className={primaryButton} disabled={actions.busy} onClick={() => actions.onAccept(row.id)}>
                      Terima
                    </button>
                    <button type="button" className={quietButton} disabled={actions.busy} onClick={() => actions.onReject(row.id)}>
                      Tolak
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </ViewStates>
  );
}
