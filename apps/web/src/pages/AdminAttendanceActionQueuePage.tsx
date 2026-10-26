import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AttendanceDayPanel } from "@/components/attendance/AttendanceDayPanel";
import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { listEmployees } from "@/lib/adminEmployees";
import { ACTION_KIND_LABELS, getActionQueue, type ActionKind, type ActionQueue, type ActionQueueItem } from "@/lib/attendanceActionQueue";
import { clarificationKindLabel, geofenceLabel } from "@/lib/attendanceLabels";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import type { AuthSession } from "@/types/hcis";

function shortDate(value: string) {
  return new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

/** One line telling HC what the item is about, in plain words. */
function itemSummary(item: ActionQueueItem) {
  if (item.kind === "clarification") return `${clarificationKindLabel(item.detail)}${item.reason ? `: ${item.reason}` : ""}`;
  if (item.kind === "mobile_review") return `Absen HP ${item.mode === "check_out" ? "pulang" : "masuk"} · ${geofenceLabel(item.detail)}`;
  if (item.kind === "incomplete") return "Ada scan masuk tanpa pulang, atau sebaliknya";
  return "Pola jadwal bertumpuk atau shift tidak berlaku";
}

/**
 * ATT-011-3 §6.1 "Perlu tindakan": everything that waits for HC in the last 31 days, oldest first. Each
 * row opens the one-day panel, where the actions live.
 */
export function AdminAttendanceActionQueuePage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [units, setUnits] = useState<Array<{ id: string; name: string }>>([]);
  const [unitId, setUnitId] = useState("");
  const [kind, setKind] = useState<ActionKind | "">("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ActionQueue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ employeeId: string; workDate: string } | null>(null);

  useEffect(() => {
    void getCurrentSession().then((value) => {
      setSession(value);
      if (hasPermission(value, "employees.manage")) {
        void listEmployees({ pageSize: 1, status: "active" }).then((result) => setUnits(result.filters.units)).catch(() => undefined);
      }
    }).catch(() => setSession(null));
  }, []);

  const load = useCallback(async () => {
    try {
      setData(await getActionQueue({ unitId, kind, page }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Antrean tidak dapat dimuat.");
    }
  }, [unitId, kind, page]);

  useEffect(() => { void load(); }, [load]);

  const total = data ? Object.values(data.counts).reduce((sum, value) => sum + (value ?? 0), 0) : 0;
  return (
    <AttendanceWorkforceShell tab="queue" title="Perlu Tindakan" description="Yang menunggu Human Capital dalam 31 hari terakhir, tanggal terlama di atas. Pilih baris untuk melihat detail dan menindaklanjuti.">
      {error ? <div className="mb-4 flex gap-2 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink" role="alert"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div> : null}
      <section className="rounded-2xl border border-border/70 bg-surface-raised shadow-[var(--shadow-soft)]">
        <div className="flex flex-wrap items-end gap-3 border-b p-3">
          {units.length > 0 ? (
            <label className="text-xs font-semibold text-muted-foreground">Unit
              <select className="mt-1 h-9 rounded-xl border px-3 text-sm" value={unitId} onChange={(event) => { setUnitId(event.target.value); setPage(1); }}>
                <option value="">Semua unit</option>
                {units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
              </select>
            </label>
          ) : null}
          <div className="flex flex-wrap gap-2" role="group" aria-label="Jenis">
            <button type="button" aria-pressed={kind === ""} onClick={() => { setKind(""); setPage(1); }} className={`h-9 rounded-full border px-3 text-xs font-bold ${kind === "" ? "bg-brand-primary-pale text-brand-primary-deep" : "text-muted-foreground"}`}>Semua ({total})</button>
            {(data?.kinds ?? []).map((key) => (
              <button key={key} type="button" aria-pressed={kind === key} onClick={() => { setKind(key); setPage(1); }} className={`h-9 rounded-full border px-3 text-xs font-bold ${kind === key ? "bg-brand-primary-pale text-brand-primary-deep" : "text-muted-foreground"}`}>
                {ACTION_KIND_LABELS[key]} ({data?.counts[key] ?? 0})
              </button>
            ))}
          </div>
        </div>
        <ul className="divide-y">
          {data?.items.map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <button type="button" onClick={() => setOpen({ employeeId: item.employeeId, workDate: item.workDate })} className="grid w-full gap-1 p-3 text-left hover:bg-surface md:grid-cols-[9rem_minmax(0,1fr)_12rem] md:items-center">
                <span className="text-xs font-semibold tabular-nums">{shortDate(item.workDate)}</span>
                <span>
                  <span className="font-semibold">{item.employeeName}</span> <span className="text-xs text-muted-foreground">{item.employeeNumber}{item.unitName ? ` · ${item.unitName}` : ""}</span>
                  <span className="block text-xs text-muted-foreground">{itemSummary(item)}</span>
                </span>
                <span className="justify-self-start rounded-full bg-surface px-2.5 py-1 text-xs font-bold md:justify-self-end">{ACTION_KIND_LABELS[item.kind]}</span>
              </button>
            </li>
          ))}
          {data && data.items.length === 0 ? <li className="p-8 text-center text-sm text-muted-foreground">Tidak ada yang perlu ditindaklanjuti.</li> : null}
          {!data && !error ? <li className="p-8 text-center text-sm text-muted-foreground">Memuat…</li> : null}
        </ul>
        {data && data.pageCount > 1 ? (
          <footer className="flex items-center justify-between border-t p-3 text-xs text-muted-foreground">
            <span>{data.total} baris · halaman {data.page} dari {data.pageCount}</span>
            <div className="flex gap-2">
              <button type="button" aria-label="Halaman sebelumnya" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)} className="rounded-lg border p-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
              <button type="button" aria-label="Halaman berikutnya" disabled={data.page >= data.pageCount} onClick={() => setPage(data.page + 1)} className="rounded-lg border p-1.5 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
            </div>
          </footer>
        ) : null}
      </section>
      {open ? (
        <AttendanceDayPanel employeeId={open.employeeId} workDate={open.workDate}
          canDecide={hasPermission(session, "attendance.clarification.manage")}
          canCorrect={hasPermission(session, "attendance.records.manage")}
          onClose={() => setOpen(null)} onChanged={() => void load()} />
      ) : null}
    </AttendanceWorkforceShell>
  );
}
