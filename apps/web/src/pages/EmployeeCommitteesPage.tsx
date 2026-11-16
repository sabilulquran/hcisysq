// ORG-012 "Kepanitiaan Saya": committees I am on now and those I was on, each with its line-up
// and SK. Membership is the access rule; the API answers 404 for anything else (D-15).
// Spec: docs/domain/committees.md §10.

import { Loader2, UsersRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { CommitteeDetailPanel } from "@/components/committees/CommitteeDetailPanel";
import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { DialogLoading, DialogMessages } from "@/components/DetailDialogParts";
import { PaginationBar } from "@/components/PaginationBar";
import { AppShell } from "@/layouts/AppShell";
import {
  CATEGORY_LABELS,
  CommitteeRequestError,
  formatPeriod,
  getMyCommittee,
  listMyCommittees,
  roleLabel,
  STATUS_LABELS,
  type CommitteeDetail,
  type MyCommittee,
  type Pagination,
} from "@/lib/committees";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";
import { cn } from "@/lib/utils";

type Scope = "current" | "history";

export function EmployeeCommitteesPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [scope, setScope] = useState<Scope>("current");
  const [items, setItems] = useState<MyCommittee[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [selected, setSelected] = useState<CommitteeDetail | null>(null);
  // The open committee lives in ?committee=<id> (notification links use it too) and shows as a pop-up.
  const [committeeId, showCommittee, closeCommittee] = useDialogParam("committee");
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const user = useMemo(() => employeeShellUser(employee), [employee]);

  const load = async (nextScope: Scope, page = 1) => {
    setLoading(true);
    setError(null);
    try {
      const result = await listMyCommittees(nextScope, page);
      setItems(result.items);
      setPaging(result.pagination);
    } catch (cause) {
      if (cause instanceof CommitteeRequestError && cause.status === 403) setForbidden(true);
      else setError(cause instanceof Error ? cause.message : "Kepanitiaan tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  const open = async (id: string) => {
    setOpening(true);
    setError(null);
    try {
      setSelected(await getMyCommittee(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kepanitiaan tidak dapat dibuka.");
    } finally {
      setOpening(false);
    }
  };

  useEffect(() => {
    void getEmployeeLeaveSummary().then((value) => setEmployee(value.employee)).catch(() => undefined);
    void load("current");
  }, []);

  useEffect(() => {
    if (committeeId) void open(committeeId);
    else setSelected(null);
  }, [committeeId]);

  const switchScope = (next: Scope) => {
    setScope(next);
    void load(next);
  };

  const card = "rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]";

  return (
    <AppShell user={user} activeItem="Kepanitiaan">
      <section className="mx-auto max-w-5xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Kinerja &amp; Pengembangan</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Kepanitiaan Saya</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Kepanitiaan yang Anda ikuti, susunan panitianya, dan SK penetapannya. Kepanitiaan dicatat oleh Human Capital;
          bila ada yang belum tercatat, hubungi Human Capital.
        </p>

        {forbidden ? (
          <div role="alert" className="mt-5 rounded-2xl border border-warning-line bg-warning-soft p-4 text-sm text-warning-ink">
            Akun Anda belum terhubung ke data pegawai aktif, jadi kepanitiaan belum dapat ditampilkan.
          </div>
        ) : null}
        {error && !committeeId ? <div role="alert" className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}

        <div className="mt-6 flex gap-2" role="group" aria-label="Pilih daftar kepanitiaan">
          {([["current", "Berjalan"], ["history", "Riwayat"]] as const).map(([key, label]) => (
            <button key={key} type="button" aria-pressed={scope === key} onClick={() => switchScope(key)}
              className={cn("min-h-11 rounded-xl border px-4 text-sm font-bold",
                scope === key ? "border-brand-primary bg-brand-primary text-brand-foreground" : "border-border text-brand-heading")}>
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4">
          <section className={`${card} overflow-hidden`} aria-busy={loading}>
            {loading ? (
              <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
            ) : items.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted-foreground">
                {scope === "current" ? "Anda sedang tidak menjadi panitia kegiatan apa pun." : "Belum ada riwayat kepanitiaan."}
              </p>
            ) : (
              <ul className="divide-y divide-border/70">
                {items.map((item) => (
                  <li key={item.id}>
                    <button type="button" onClick={() => showCommittee(item.id)}
                      className={cn("flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-muted/50", committeeId === item.id && "bg-muted/60")}>
                      <UsersRound className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary-deep" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-brand-heading">{item.name}</span>
                        <span className="block text-xs text-muted-foreground">{formatPeriod(item.startOn, item.endOn)} · {CATEGORY_LABELS[item.category]}</span>
                        <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
                          {roleLabel(item.role, item.section)}
                          {item.status !== "ACTIVE" ? ` · ${STATUS_LABELS[item.status]}` : ""}
                          {item.decreeNumber ? ` · SK ${item.decreeNumber}` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {paging && paging.total > 0 ? (
              <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total}
                onPageChange={(page) => void load(scope, page)} />
            ) : null}
          </section>

          {committeeId ? (
            <DetailDialog title="Detail kepanitiaan" onClose={closeCommittee} wide>
              <DialogMessages error={error} />
              {selected?.id === committeeId && !opening ? (
                <CommitteeDetailPanel detail={selected} />
              ) : error ? null : <DialogLoading label="Membuka..." />}
            </DetailDialog>
          ) : null}
        </div>
      </section>
    </AppShell>
  );
}
