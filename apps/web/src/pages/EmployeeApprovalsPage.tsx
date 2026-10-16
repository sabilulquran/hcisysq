import {
  CheckCircle2,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import {
  decideLeaveApproval,
  EmployeeLeaveApiError,
  getEmployeeLeaveSummary,
  getLeaveApprovalInbox,
  type EmployeeLeaveSummary,
  type LeaveApprovalInboxItem,
} from "@/lib/employeeLeave";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(new Date(`${value}T00:00:00+07:00`));
}

export function EmployeeApprovalsPage() {
  const [summary, setSummary] = useState<EmployeeLeaveSummary | null>(null);
  const [items, setItems] = useState<LeaveApprovalInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [nextSummary, inbox] = await Promise.all([
        getEmployeeLeaveSummary(),
        getLeaveApprovalInbox(),
      ]);
      setSummary(nextSummary);
      setItems(inbox.items);
    } catch (cause) {
      setError(
        cause instanceof EmployeeLeaveApiError
          ? cause.message
          : "Antrean approval tidak dapat dimuat.",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const user = useMemo(() => {
    const employee = summary?.employee;
    return {
      name: employee?.fullName ?? "Pegawai",
      initials: initials(employee?.fullName ?? "P"),
      position: employee?.positionName ?? "Pegawai",
      unit: employee?.unitName ?? "Yayasan Sabilul Qur'an",
      additionalRole: "Approver",
    };
  }, [summary]);

  const decide = async (item: LeaveApprovalInboxItem, decision: "approve" | "reject") => {
    const note =
      decision === "reject"
        ? window.prompt("Alasan penolakan (opsional):")
        : null;
    setActing(item.stepId);
    setError(null);
    try {
      await decideLeaveApproval(item.stepId, {
        decision,
        note: note?.trim() || null,
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof EmployeeLeaveApiError
          ? cause.message
          : "Keputusan approval tidak dapat disimpan.",
      );
    } finally {
      setActing(null);
    }
  };

  return (
    <AppShell user={user} activeItem="Persetujuan">
      <section>
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
          Manajemen
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-brand-heading sm:text-[1.75rem]">
          Persetujuan Cuti
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Hanya tahap approval yang sedang aktif yang muncul di sini. Rantai approver sudah disnapshot saat pegawai mengajukan cuti.
        </p>
      </section>

      {error ? (
        <div className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
          {error}
        </div>
      ) : null}

      <section className="mt-5 overflow-hidden rounded-3xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-3 border-b border-border/70 px-5 py-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-yellow/15 text-warning-ink">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-base font-bold text-brand-heading">Antrean saya</h2>
            <p className="text-xs text-muted-foreground">{items.length} pengajuan menunggu keputusan.</p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 px-5 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat antrean...
          </div>
        ) : items.length === 0 ? (
          <p className="px-5 py-10 text-sm text-muted-foreground">Tidak ada approval yang menunggu.</p>
        ) : (
          <div className="divide-y divide-border/70">
            {items.map((item) => (
              <article key={item.stepId} className="p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-brand-heading">{item.requesterName}</p>
                    <p className="mt-1 text-sm text-foreground">
                      {formatDate(item.startOn)} – {formatDate(item.endOn)} · {item.workingDays} hari kerja
                    </p>
                    {item.reason ? (
                      <p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">{item.reason}</p>
                    ) : null}
                    <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {item.sources.includes("DIRECT_MANAGER") ? "Atasan langsung" : ""}
                      {item.sources.includes("DIRECT_MANAGER") && item.sources.includes("UNIT_APPROVER") ? " + " : ""}
                      {item.sources.includes("UNIT_APPROVER") ? "Approver unit" : ""}
                    </p>
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
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}
