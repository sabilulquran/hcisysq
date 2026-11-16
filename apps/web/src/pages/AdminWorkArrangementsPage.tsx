// ATT-015 Human Capital surface: the tugas luar, WFH/WFA and schedule change register, applying an
// approved schedule change, and cancellation. Spec: docs/domain/attendance-remote-and-schedule-requests.md.
// The API authorizes every call.

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { ArrangementDetailPanel } from "@/components/arrangements/ArrangementDetailPanel";
import { EmployeeSearchField, type PickedEmployee } from "@/components/attendance/workforce/EmployeeSearchField";
import { DetailDialog, useDialogParam } from "@/components/DetailDialog";
import { PaginationBar } from "@/components/PaginationBar";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  applyScheduleChange,
  ARRANGEMENT_STATUS_LABELS,
  ARRANGEMENT_TYPE_LABELS,
  arrangementStatusLabel,
  arrangementSubject,
  cancelArrangementAsHc,
  formatArrangementRange,
  getAdminArrangement,
  getAdminArrangements,
  WorkArrangementApiError,
  type ArrangementDetail,
  type ArrangementStatus,
  type ArrangementSummary,
  type ArrangementType,
  type Pagination,
} from "@/lib/workArrangements";
import type { AuthSession } from "@/types/hcis";

export function AdminWorkArrangementsPage() {
  const [items, setItems] = useState<ArrangementSummary[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<ArrangementStatus | "">("");
  const [type, setType] = useState<ArrangementType | "">("");
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  // The open request lives in the URL (`?pengajuan=<id>`), so a link opens it and Back closes it.
  const [arrangementId, openArrangement, closeArrangement] = useDialogParam("pengajuan");
  const [selected, setSelected] = useState<ArrangementDetail | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Applying and cancelling need attendance.arrangements.manage; the register needs .read only.
  const canManage = hasPermission(session, "attendance.arrangements.manage");
  // The employee search reads the employee register, which the arrangement permission alone does not open.
  const canSearchEmployees = hasPermission(session, "employees.manage");

  const load = async () => {
    setLoading(true);
    try {
      const result = await getAdminArrangements({ page, status, type, employeeId: employee?.id });
      setItems(result.items);
      setPaging(result.pagination);
      setError(null);
    } catch (cause) {
      if (cause instanceof WorkArrangementApiError && cause.status === 403) setForbidden(true);
      setError(cause instanceof Error ? cause.message : "Register tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, status, type, employee?.id]);
  useEffect(() => {
    void getCurrentSession().then(setSession).catch(() => {
      setSession(null);
      setError("Izin akun tidak dapat dibaca, sehingga tombol tindakan disembunyikan. Muat ulang halaman.");
    });
  }, []);

  const open = async (id: string) => {
    try {
      setSelected(await getAdminArrangement(id));
      setOpenError(null);
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : "Pengajuan tidak dapat dibuka.");
    }
  };

  useEffect(() => {
    setSelected(null);
    setOpenError(null);
    if (arrangementId) void open(arrangementId);
  }, [arrangementId]);

  const run = async (action: () => Promise<string>, item: ArrangementDetail) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      setNotice(await action());
      await Promise.all([load(), open(item.id)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tindakan belum dapat diselesaikan.");
    } finally {
      setBusy(false);
    }
  };

  const apply = (item: ArrangementDetail) => void run(async () => {
    await applyScheduleChange(item.id);
    return "Jadwal pegawai diubah dan roster baru diterbitkan.";
  }, item);

  const cancel = (item: ArrangementDetail) => {
    const reason = window.prompt(item.status === "APPROVED" && item.type !== "SCHEDULE_CHANGE"
      ? "Alasan pembatalan (minimal 10 karakter). Hari yang sudah lewat dihitung ulang dari scan saja."
      : "Alasan pembatalan (minimal 10 karakter)");
    if (!reason || reason.trim().length < 10) return;
    void run(async () => {
      await cancelArrangementAsHc(item.id, reason.trim());
      return "Pengajuan dibatalkan.";
    }, item);
  };

  const select = "mt-1 h-11 w-full rounded-xl border bg-surface px-3 text-sm text-foreground";

  return (
    <AdminShell active="services" title="Tugas Luar, WFH & Ubah Jadwal"
      description="Register pengajuan tugas luar, WFH/WFA, dan ubah jadwal pegawai beserta riwayat persetujuannya.">
      {error ? <div className="mb-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
      {notice ? <div className="mb-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

      {forbidden ? null : (
        <div>
          <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
            <div className="grid gap-3 p-5 sm:grid-cols-3">
              <label className="text-xs font-semibold text-muted-foreground">
                Jenis
                <select value={type} onChange={(event) => { setPage(1); setType(event.target.value as ArrangementType | ""); }} className={select}>
                  <option value="">Semua jenis</option>
                  {(Object.keys(ARRANGEMENT_TYPE_LABELS) as ArrangementType[]).map((key) => <option key={key} value={key}>{ARRANGEMENT_TYPE_LABELS[key]}</option>)}
                </select>
              </label>
              <label className="text-xs font-semibold text-muted-foreground">
                Status
                <select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value as ArrangementStatus | ""); }} className={select}>
                  <option value="">Semua status</option>
                  {(Object.keys(ARRANGEMENT_STATUS_LABELS) as ArrangementStatus[]).map((key) => <option key={key} value={key}>{ARRANGEMENT_STATUS_LABELS[key]}</option>)}
                </select>
              </label>
              {canSearchEmployees ? (
                <EmployeeSearchField value={employee} onChange={(next) => { setPage(1); setEmployee(next); }} />
              ) : null}
            </div>

            {loading ? (
              <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat register...</div>
            ) : items.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted-foreground">Tidak ada pengajuan pada filter ini.</p>
            ) : (
              <ul className="divide-y divide-border/70 border-t border-border/70">
                {items.map((item) => (
                  <li key={item.id}>
                    <button type="button" onClick={() => { setNotice(null); openArrangement(item.id); }}
                      className={`w-full px-5 py-3 text-left hover:bg-muted/50 ${arrangementId === item.id ? "bg-muted/60" : ""}`}>
                      <span className="block font-semibold text-brand-heading">
                        {item.employeeName} · {ARRANGEMENT_TYPE_LABELS[item.type]}: {arrangementSubject(item)}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {item.employeeNumber}{item.unitName ? ` · ${item.unitName}` : ""} · {formatArrangementRange(item.startOn, item.endOn)}
                      </span>
                      <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
                        {arrangementStatusLabel(item.status, item.type)}
                        {item.currentApproverName ? ` · menunggu ${item.currentApproverName}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {paging && paging.total > 0 ? (
              <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={setPage} />
            ) : null}
          </section>
        </div>
      )}

      {!forbidden && arrangementId ? (
        <DetailDialog title="Detail pengajuan"
          description={selected ? `${selected.employeeName} · ${ARRANGEMENT_TYPE_LABELS[selected.type]}` : undefined} onClose={closeArrangement}>
          {error ? <div className="mb-4 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
          {notice ? <div className="mb-4 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}
          {openError ? (
            <p className="text-sm text-danger-ink">{openError}</p>
          ) : selected?.id === arrangementId ? (
            <ArrangementDetailPanel
              item={selected}
              actions={canManage ? (
                <>
                  {selected.type === "SCHEDULE_CHANGE" && selected.status === "APPROVED" ? (
                    <button type="button" disabled={busy} onClick={() => apply(selected)}
                      className="min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50">
                      Terapkan ke jadwal
                    </button>
                  ) : null}
                  {["IN_REVIEW", "APPROVED"].includes(selected.status) ? (
                    <button type="button" disabled={busy} onClick={() => cancel(selected)}
                      className="min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50">
                      Batalkan pengajuan
                    </button>
                  ) : null}
                </>
              ) : null}
            />
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat pengajuan...</div>
          )}
        </DetailDialog>
      ) : null}
    </AdminShell>
  );
}
