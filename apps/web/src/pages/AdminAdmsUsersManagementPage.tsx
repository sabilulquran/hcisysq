import { AlertTriangle, CheckCircle2, Link2, Loader2, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AdmsManagementNav } from "@/components/attendance/adms/AdmsManagementNav";
import { AdminShell } from "@/layouts/AdminShell";
import { listEmployees, type AdminEmployeeListItem } from "@/lib/adminEmployees";
import { listAdmsUserSync, type AdmsUserSyncItem, type AdmsUserSyncState } from "@/lib/admsManagement";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import { createAdmsMapping } from "@/lib/attendance";
import type { AuthSession } from "@/types/hcis";

const stateLabels: Record<AdmsUserSyncState, string> = {
  synced: "Sinkron",
  unmapped: "Belum termap",
  missing_on_device: "Belum terlihat di mesin",
  name_drift: "Nama berbeda",
  review_required: "Perlu ditinjau",
};

function stateClass(state: AdmsUserSyncState) {
  if (state === "synced") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (state === "unmapped") return "border-amber-200 bg-amber-50 text-amber-800";
  if (state === "review_required") return "border-red-200 bg-red-50 text-red-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

export function AdminAdmsUsersManagementPage() {
  const [items, setItems] = useState<AdmsUserSyncItem[]>([]);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [state, setState] = useState<AdmsUserSyncState | "">("unmapped");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mappingItem, setMappingItem] = useState<AdmsUserSyncItem | null>(null);
  const [employeeQ, setEmployeeQ] = useState("");
  const [employees, setEmployees] = useState<AdminEmployeeListItem[]>([]);
  const [employeeLoading, setEmployeeLoading] = useState(false);
  const [mappingBusy, setMappingBusy] = useState<string | null>(null);

  const canOperate = hasPermission(session, "attendance.devices.operate");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listAdmsUserSync({ state: state || undefined, q: q.trim() || undefined, limit: 250 });
      setItems(result.items);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Data mapping ADMS tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  }, [q, state]);

  useEffect(() => { void getCurrentSession().then(setSession); }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!mappingItem) return;
    let active = true;
    setEmployeeLoading(true);
    const timer = window.setTimeout(() => {
      void listEmployees({ q: employeeQ.trim() || undefined, status: "active", pageSize: 25 })
        .then((result) => { if (active) setEmployees(result.items); })
        .catch(() => { if (active) setEmployees([]); })
        .finally(() => { if (active) setEmployeeLoading(false); });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [mappingItem, employeeQ]);

  const counts = useMemo(() => {
    const result = { unmapped: 0, review: 0, drift: 0, missing: 0, synced: 0 };
    for (const item of items) {
      if (item.state === "unmapped") result.unmapped += 1;
      else if (item.state === "review_required") result.review += 1;
      else if (item.state === "name_drift") result.drift += 1;
      else if (item.state === "missing_on_device") result.missing += 1;
      else result.synced += 1;
    }
    return result;
  }, [items]);

  async function connect(employee: AdminEmployeeListItem) {
    if (!mappingItem) return;
    setMappingBusy(employee.id);
    try {
      await createAdmsMapping(mappingItem.deviceId, { pin: mappingItem.pin, employeeId: employee.id });
      setMappingItem(null);
      setEmployeeQ("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PIN tidak dapat dihubungkan.");
    } finally {
      setMappingBusy(null);
    }
  }

  return (
    <AdminShell
      active="attendance-adms"
      title="Manajemen ADMS"
      description="Kelola hubungan pegawai dan data pengguna mesin dari satu antrean lintas perangkat."
    >
      <AdmsManagementNav active="users" />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ["Belum termap", counts.unmapped],
          ["Perlu ditinjau", counts.review],
          ["Nama berbeda", counts.drift],
          ["Belum terlihat", counts.missing],
          ["Sinkron", counts.synced],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-2xl border border-border/70 bg-white p-4 shadow-[var(--shadow-soft)]">
            <p className="text-xs font-semibold text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-bold text-brand-heading">{value}</p>
          </div>
        ))}
      </section>

      <section className="mt-5 overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <div className="flex flex-col gap-3 border-b border-border/70 p-4 md:flex-row md:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <input
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Cari PIN, nama, NIP, atau mesin"
              className="h-10 w-full rounded-xl border border-border pl-9 pr-3 text-sm"
            />
          </div>
          <select value={state} onChange={(event) => setState(event.target.value as AdmsUserSyncState | "")} className="h-10 rounded-xl border border-border px-3 text-sm">
            <option value="">Semua status</option>
            {Object.entries(stateLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border px-3 text-sm font-semibold disabled:opacity-60">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Muat ulang
          </button>
        </div>

        {error ? <div className="m-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</div> : null}
        {loading ? <div className="p-8 text-center text-sm text-muted-foreground">Memuat sinkronisasi pengguna...</div> : items.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Tidak ada data pada filter ini.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="bg-surface text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Mesin</th>
                  <th className="px-4 py-3">PIN</th>
                  <th className="px-4 py-3">Terlihat di mesin</th>
                  <th className="px-4 py-3">Pegawai HCIS</th>
                  <th className="px-4 py-3">Tindakan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {items.map((item) => (
                  <tr key={`${item.deviceId}:${item.pin}`}>
                    <td className="px-4 py-3"><span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold ${stateClass(item.state)}`}>{stateLabels[item.state]}</span></td>
                    <td className="px-4 py-3">
                      <a href={`/admin/attendance/devices/${item.deviceId}`} className="font-semibold text-brand-heading hover:underline">{item.deviceName || item.serialNumber}</a>
                      <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{item.serialNumber}</div>
                    </td>
                    <td className="px-4 py-3 font-mono font-semibold">{item.pin}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-brand-heading">{item.observedName || "Nama belum terbaca"}</div>
                      <div className="text-xs text-muted-foreground">{item.observedCardNumber ? `Kartu ${item.observedCardNumber}` : "Tanpa nomor kartu teramati"}</div>
                    </td>
                    <td className="px-4 py-3">
                      {item.employeeId ? (
                        <>
                          <div className="font-semibold text-brand-heading">{item.employeeName}</div>
                          <div className="text-xs text-muted-foreground">{item.employeeNumber} · {item.employeeStatus}</div>
                        </>
                      ) : <span className="text-muted-foreground">Belum dihubungkan</span>}
                    </td>
                    <td className="px-4 py-3">
                      {item.state === "unmapped" && canOperate ? (
                        <button type="button" onClick={() => setMappingItem(item)} className="inline-flex h-9 items-center gap-2 rounded-xl bg-brand-primary px-3 text-xs font-bold text-white">
                          <Link2 className="h-3.5 w-3.5" /> Hubungkan
                        </button>
                      ) : item.state === "synced" ? (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4" /> Sesuai</span>
                      ) : (
                        <a href={`/admin/attendance/devices/${item.deviceId}/users`} className="text-xs font-semibold text-brand-primary-deep hover:underline">Tinjau di mesin</a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {mappingItem ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-labelledby="mapping-title">
          <div className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="mapping-title" className="font-bold text-brand-heading">Hubungkan PIN {mappingItem.pin}</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Pilih pegawai secara eksplisit. HCIS tidak membuat mapping otomatis dari kemiripan nama.</p>
              </div>
              <button type="button" onClick={() => setMappingItem(null)} className="rounded-lg p-2 hover:bg-surface" aria-label="Tutup"><X className="h-4 w-4" /></button>
            </div>
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Teramati sebagai <strong>{mappingItem.observedName || "nama tidak tersedia"}</strong> pada {mappingItem.deviceName || mappingItem.serialNumber}.</div>
            </div>
            <input value={employeeQ} onChange={(event) => setEmployeeQ(event.target.value)} placeholder="Cari nama, NIP, atau email pegawai aktif" className="mt-4 h-10 w-full rounded-xl border border-border px-3 text-sm" />
            <div className="mt-3 space-y-2">
              {employeeLoading ? <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Memuat pegawai...</div> : employees.map((employee) => (
                <button key={employee.id} type="button" disabled={mappingBusy !== null} onClick={() => void connect(employee)} className="flex w-full items-center justify-between gap-3 rounded-xl border border-border p-3 text-left hover:bg-surface disabled:opacity-60">
                  <div>
                    <div className="font-semibold text-brand-heading">{employee.fullName}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{employee.employeeNumber} · {employee.unitName || "Unit belum diisi"}</div>
                  </div>
                  {mappingBusy === employee.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <span className="text-xs font-bold text-brand-primary-deep">Pilih</span>}
                </button>
              ))}
              {!employeeLoading && employees.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Pegawai aktif tidak ditemukan.</p> : null}
            </div>
          </div>
        </div>
      ) : null}
    </AdminShell>
  );
}
