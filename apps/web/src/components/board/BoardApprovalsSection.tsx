import { AlertTriangle, CheckCircle2, Inbox, Loader2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import {
  decideLeaveApproval,
  EmployeeLeaveApiError,
  getLeaveApprovalInbox,
  type LeaveApprovalInboxItem,
} from "@/lib/employeeLeave";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(new Date(`${value}T00:00:00+07:00`));
}

/**
 * ORG-013-3 (v1, DRAFT): the leave steps snapshotted to this Foundation Board account, decided
 * through the existing `/leave/approvals` routes with the cookie session. Until the Portal Organ
 * Yayasan exists this is the only place an organ account can decide. An account without the
 * governance approver role gets 403 and sees nothing.
 */
export function BoardApprovalsSection() {
  const [items, setItems] = useState<LeaveApprovalInboxItem[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const inbox = await getLeaveApprovalInbox();
      setItems(inbox.items);
      setError(null);
    } catch (cause) {
      if (cause instanceof EmployeeLeaveApiError && cause.status === 403) {
        setHidden(true);
        return;
      }
      setError(cause instanceof EmployeeLeaveApiError ? cause.message : "Daftar persetujuan tidak dapat dimuat.");
      setItems([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const decide = async (item: LeaveApprovalInboxItem, decision: "approve" | "reject") => {
    const note = decision === "reject" ? window.prompt("Alasan penolakan (opsional):") : null;
    if (decision === "reject" && note === null) return;
    setActing(item.stepId);
    setError(null);
    try {
      await decideLeaveApproval(item.stepId, { decision, note: note?.trim() || null });
      await load();
    } catch (cause) {
      setError(cause instanceof EmployeeLeaveApiError ? cause.message : "Keputusan tidak dapat disimpan.");
    } finally {
      setActing(null);
    }
  };

  if (hidden) return null;

  return (
    <section className="mt-6 overflow-hidden rounded-3xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
      <div className="border-b border-border/70 px-5 py-4">
        <h2 className="text-base font-bold text-brand-heading">Menunggu keputusan Anda</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Pengajuan cuti yang rantai persetujuannya jatuh ke jabatan Anda di struktur yayasan.
        </p>
      </div>
      {error ? (
        <div className="m-5 flex gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {error}
        </div>
      ) : null}
      {items === null ? (
        <div className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat pengajuan...
        </div>
      ) : items.length === 0 ? (
        <div className="flex items-center gap-3 p-5 text-sm text-muted-foreground">
          <Inbox className="h-5 w-5" aria-hidden="true" /> Tidak ada pengajuan yang menunggu keputusan Anda.
        </div>
      ) : (
        <div className="divide-y divide-border/70">
          {items.map((item) => (
            <article key={item.stepId} className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-bold text-brand-heading">{item.requesterName}</p>
                <p className="mt-1 text-sm text-foreground">
                  {formatDate(item.startOn)} – {formatDate(item.endOn)} · {item.workingDays} hari kerja
                </p>
                {item.reason ? (
                  <p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">{item.reason}</p>
                ) : null}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={acting === item.stepId}
                  onClick={() => void decide(item, "reject")}
                  className="inline-flex h-10 items-center gap-2 rounded-xl border border-danger-line bg-surface-raised px-4 text-sm font-semibold text-danger-ink hover:bg-danger-soft disabled:opacity-60"
                >
                  <XCircle className="h-4 w-4" aria-hidden="true" /> Tolak
                </button>
                <button
                  type="button"
                  disabled={acting === item.stepId}
                  onClick={() => void decide(item, "approve")}
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground shadow-[var(--shadow-button)] disabled:opacity-60"
                >
                  {acting === item.stepId ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  )}
                  Setujui
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
