import { Loader2, RefreshCw, Search, Send, UsersRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AdmsManagementNav } from "@/components/attendance/adms/AdmsManagementNav";
import { AdminShell } from "@/layouts/AdminShell";
import { listEmployees, type AdminEmployeeListItem, type ReferenceOption } from "@/lib/adminEmployees";
import { listAdmsManagementJobs, listAdmsUserSync, type AdmsManagementJob, type AdmsUserSyncItem } from "@/lib/admsManagement";
import { getAdmsOperations } from "@/lib/admsOperations";
import { pushUserProfile } from "@/lib/admsPhysicalParity";
import { listAdmsDevices, type AdmsDevice } from "@/lib/attendance";
import { commandStatusLabel } from "@/lib/admsAdmin";

type CapabilityState = "available" | "not_verified" | "blocked";

function fmt(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

function stateLabel(value: string) {
  if (value === "synced") return "Sinkron";
  if (value === "missing_on_device") return "Belum ada di mesin";
  if (value === "name_drift") return "Nama berbeda";
  if (value === "review_required") return "Perlu ditinjau";
  return "Belum terhubung";
}

export function AdminAdmsJobsPage() {
  const [employees, setEmployees] = useState<AdminEmployeeListItem[]>([]);
  const [units, setUnits] = useState<ReferenceOption[]>([]);
  const [devices, setDevices] = useState<AdmsDevice[]>([]);
  const [syncRows, setSyncRows] = useState<AdmsUserSyncItem[]>([]);
  const [capabilities, setCapabilities] = useState<Record<string, CapabilityState>>({});
  const [history, setHistory] = useState<AdmsManagementJob[]>([]);
  const [unitId, setUnitId] = useState("");
  const [query, setQuery] = useState("");
  const [selectedEmployees, setSelectedEmployees] = useState<Set<string>>(new Set());
  const [selectedDevices, setSelectedDevices] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [employeeResult, deviceResult, syncResult, jobs] = await Promise.all([
        listEmployees({ page: 1, pageSize: 100, status: "active", unitId: unitId || undefined, q: query.trim() || undefined }),
        listAdmsDevices(),
        listAdmsUserSync({ limit: 1000 }),
        listAdmsManagementJobs({ limit: 100 }),
      ]);
      const activeDevices = deviceResult.items.filter((item) => item.lifecycle === "active");
      const capabilityEntries = await Promise.all(activeDevices.map(async (item) => {
        try {
          const operations = await getAdmsOperations(item.id);
          return [item.id, operations.capabilities.find((capability) => capability.key === "user_profile_upsert")?.state ?? "not_verified"] as const;
        } catch {
          return [item.id, "not_verified"] as const;
        }
      }));
      setEmployees(employeeResult.items);
      setUnits(employeeResult.filters.units);
      setDevices(activeDevices);
      setSyncRows(syncResult.items);
      setHistory(jobs.items);
      setCapabilities(Object.fromEntries(capabilityEntries));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Data sinkronisasi tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  }, [query, unitId]);

  useEffect(() => { void load(); }, [load]);

  const matrix = useMemo(() => {
    const rowMap = new Map(syncRows.filter((item) => item.employeeId).map((item) => [`${item.employeeId}:${item.deviceId}`, item]));
    return employees.filter((employee) => selectedEmployees.has(employee.id)).flatMap((employee) =>
      devices.filter((device) => selectedDevices.has(device.id)).map((device) => {
        const current = rowMap.get(`${employee.id}:${device.id}`) ?? null;
        const capability = capabilities[device.id] ?? "not_verified";
        let action: "skip" | "sync" | "blocked" = "blocked";
        let reason = "Hubungkan pegawai ke PIN mesin lebih dulu.";
        if (capability !== "available") {
          reason = capability === "blocked" ? "Tidak didukung mesin ini." : "Perlu pengujian perangkat.";
        } else if (current?.state === "synced") {
          action = "skip";
          reason = "Sudah sinkron.";
        } else if (current?.state === "missing_on_device" || current?.state === "name_drift") {
          action = "sync";
          reason = current.state === "missing_on_device" ? "Pegawai akan dikirim ke mesin." : "Data pegawai akan diperbarui di mesin.";
        } else if (current?.state === "review_required") {
          reason = "Hubungan pegawai perlu ditinjau sebelum sinkronisasi.";
        }
        return { employee, device, current, capability, action, reason };
      }),
    );
  }, [capabilities, devices, employees, selectedDevices, selectedEmployees, syncRows]);

  const actionable = matrix.filter((item) => item.action === "sync");

  function toggleEmployee(id: string) {
    setSelectedEmployees((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleDevice(id: string) {
    setSelectedDevices((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function execute() {
    if (actionable.length === 0) return;
    if (!window.confirm(`Sinkronkan ${actionable.length} perubahan pegawai ke mesin yang dipilih? Hanya hubungan eksplisit dan mesin yang sudah lolos pengujian yang akan diproses.`)) return;
    setExecuting(true);
    setProgress({ done: 0, total: actionable.length, failed: 0 });
    let failed = 0;
    for (let index = 0; index < actionable.length; index += 1) {
      const item = actionable[index];
      try {
        await pushUserProfile(
          item.device.id,
          item.employee.id,
          1,
          `UPSERT USER ${item.device.serialNumber} ${item.employee.id}`,
          "execute",
        );
      } catch {
        failed += 1;
      }
      setProgress({ done: index + 1, total: actionable.length, failed });
    }
    setExecuting(false);
    setNotice(failed === 0 ? "Semua perubahan sudah dijadwalkan. Pantau hasilnya pada riwayat proses." : `${actionable.length - failed} perubahan dijadwalkan; ${failed} perlu ditinjau.`);
    await load();
  }

  return (
    <AdminShell active="attendance-adms" title="Manajemen ADMS" description="Sinkronkan data pegawai dari HCIS ke mesin secara terarah, dengan preview dan pengujian capability per perangkat.">
      <AdmsManagementNav active="jobs" />

      {notice ? <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div> : null}
      {error ? <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-2"><UsersRound className="h-5 w-5 text-brand-primary" /><h2 className="font-bold text-brand-heading">Sinkronisasi pegawai</h2></div>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">Pilih pegawai atau unit, lalu mesin target. HCIS membandingkan data master dengan data yang teramati pada tiap mesin. Tidak ada penyalinan mesin-ke-mesin dan tidak ada mapping otomatis.</p>

        <div className="mt-4 grid gap-3 lg:grid-cols-[14rem_minmax(0,1fr)_auto]">
          <select value={unitId} onChange={(e) => { setUnitId(e.target.value); setSelectedEmployees(new Set()); }} className="h-10 rounded-xl border border-border bg-white px-3 text-sm"><option value="">Semua unit</option>{units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select>
          <label className="relative"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cari pegawai" className="h-10 w-full rounded-xl border border-border pl-9 pr-3 text-sm" /></label>
          <button type="button" disabled={loading} onClick={() => void load()} className="inline-flex h-10 items-center gap-2 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Muat ulang</button>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border/70">
            <div className="flex items-center justify-between border-b border-border/60 p-3"><span className="text-xs font-bold text-brand-heading">Pegawai</span><button type="button" onClick={() => setSelectedEmployees(new Set(employees.map((item) => item.id)))} className="text-xs font-semibold text-brand-primary-deep">Pilih semua hasil</button></div>
            <div className="max-h-72 overflow-auto p-2">{loading ? <div className="p-4 text-xs text-muted-foreground">Memuat pegawai…</div> : employees.map((item) => <label key={item.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface"><input type="checkbox" checked={selectedEmployees.has(item.id)} onChange={() => toggleEmployee(item.id)} /><span className="min-w-0"><span className="block truncate text-sm font-semibold text-brand-heading">{item.fullName}</span><span className="block truncate text-xs text-muted-foreground">{item.employeeNumber} · {item.unitName ?? "Unit belum terisi"}</span></span></label>)}</div>
          </div>
          <div className="rounded-xl border border-border/70">
            <div className="border-b border-border/60 p-3 text-xs font-bold text-brand-heading">Mesin target</div>
            <div className="max-h-72 overflow-auto p-2">{devices.map((item) => <label key={item.id} className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-surface"><input type="checkbox" className="mt-1" checked={selectedDevices.has(item.id)} onChange={() => toggleDevice(item.id)} /><span className="min-w-0"><span className="block truncate text-sm font-semibold text-brand-heading">{item.displayName || item.serialNumber}</span><span className="block text-xs text-muted-foreground">{capabilities[item.id] === "available" ? "Siap sinkronisasi" : capabilities[item.id] === "blocked" ? "Tidak didukung mesin ini" : "Perlu pengujian perangkat"}</span></span></label>)}</div>
          </div>
        </div>
      </section>

      {matrix.length > 0 ? (
        <section className="mt-5 overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 p-4"><div><h2 className="font-bold text-brand-heading">Preview perubahan</h2><p className="mt-1 text-xs text-muted-foreground">{actionable.length} perubahan dapat dijalankan; item lain dilewati dengan alasan.</p></div><button type="button" disabled={executing || actionable.length === 0} onClick={() => void execute()} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-primary px-4 text-xs font-bold text-white disabled:opacity-50">{executing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Sinkronkan yang belum sesuai</button></div>
          {progress ? <div className="border-b border-border/60 bg-surface px-4 py-2 text-xs text-muted-foreground">Diproses {progress.done}/{progress.total} · {progress.failed} perlu ditinjau</div> : null}
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-surface text-[11px] uppercase tracking-[.08em] text-muted-foreground"><tr><th className="px-4 py-3">Pegawai HCIS</th><th className="px-4 py-3">Mesin</th><th className="px-4 py-3">Kondisi saat ini</th><th className="px-4 py-3">Rencana</th></tr></thead><tbody className="divide-y divide-border/60">{matrix.map((item) => <tr key={`${item.employee.id}:${item.device.id}`}><td className="px-4 py-3"><div className="font-semibold text-brand-heading">{item.employee.fullName}</div><div className="text-xs text-muted-foreground">{item.employee.employeeNumber}</div></td><td className="px-4 py-3"><div className="font-semibold">{item.device.displayName || item.device.serialNumber}</div></td><td className="px-4 py-3">{item.current ? stateLabel(item.current.state) : "Belum terhubung"}</td><td className="px-4 py-3"><span className={item.action === "sync" ? "font-semibold text-brand-primary-deep" : "text-muted-foreground"}>{item.reason}</span></td></tr>)}</tbody></table></div>
        </section>
      ) : null}

      <section className="mt-5 overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <div className="border-b border-border/70 p-4"><h2 className="font-bold text-brand-heading">Riwayat proses</h2><p className="mt-1 text-xs text-muted-foreground">Status sinkronisasi dan tindakan mesin terbaru dalam bahasa operasional.</p></div>
        {history.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">Belum ada proses sinkronisasi.</div> : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-surface text-[11px] uppercase tracking-[.08em] text-muted-foreground"><tr><th className="px-4 py-3">Aksi</th><th className="px-4 py-3">Mesin</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Dibuat</th><th className="px-4 py-3">Selesai</th></tr></thead><tbody className="divide-y divide-border/70">{history.map((item) => <tr key={item.id}><td className="px-4 py-3 font-semibold text-brand-heading">{item.action}</td><td className="px-4 py-3"><a className="font-semibold hover:underline" href={`/admin/attendance/devices/${item.deviceId}`}>{item.deviceName || item.serialNumber}</a></td><td className="px-4 py-3 font-semibold">{commandStatusLabel(item.status)}</td><td className="px-4 py-3 text-muted-foreground">{fmt(item.createdAt)}</td><td className="px-4 py-3 text-muted-foreground">{fmt(item.completedAt)}</td></tr>)}</tbody></table></div>}
      </section>
    </AdminShell>
  );
}
