import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AdmsManagementNav } from "@/components/attendance/adms/AdmsManagementNav";
import { AdminShell } from "@/layouts/AdminShell";
import { listAdmsManagementHealth, type AdmsManagementHealth } from "@/lib/admsManagement";

function fmt(value: string | null) {
  if (!value) return "Belum pernah";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

const alertLabels: Record<string, string> = {
  device_offline: "Mesin offline",
  connectivity_unknown: "Koneksi belum diketahui",
  unmapped_pin: "PIN belum termap",
  failed_job: "Ada perintah gagal",
  reconciliation_stale: "Rekonsiliasi terlambat",
  source_ip_anomaly: "Perubahan IP perlu ditinjau",
};

export function AdminAdmsHealthPage() {
  const [items, setItems] = useState<AdmsManagementHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems((await listAdmsManagementHealth()).items);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Health ADMS tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const alertCount = useMemo(() => items.reduce((total, item) => total + item.alertCodes.length, 0), [items]);

  return (
    <AdminShell active="attendance-adms" title="Manajemen ADMS" description="Kesehatan fleet berdasarkan evidence koneksi, mapping, perintah, rekonsiliasi, dan source IP.">
      <AdmsManagementNav active="health" />
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className={"rounded-xl border px-3 py-2 text-sm font-semibold " + (alertCount ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-800")}>
          {alertCount ? alertCount + " alert aktif" : "Tidak ada alert aktif"}
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-10 items-center gap-2 rounded-xl border border-border px-3 text-sm font-semibold disabled:opacity-60">
          <RefreshCw className={"h-4 w-4 " + (loading ? "animate-spin" : "")} />Muat ulang
        </button>
      </div>
      {error ? <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}
      <div className="grid gap-3">
        {items.map((item) => (
          <article key={item.deviceId} className="rounded-2xl border border-border/70 bg-white p-4 shadow-[var(--shadow-soft)]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <a href={"/admin/attendance/devices/" + item.deviceId} className="font-bold text-brand-heading hover:underline">{item.deviceName || item.serialNumber}</a>
                <div className="mt-1 font-mono text-xs text-muted-foreground">{item.serialNumber} · {item.connectivityStatus} · {item.lifecycle}</div>
              </div>
              <div className="text-right text-xs text-muted-foreground">Terakhir terlihat<br /><span className="font-semibold text-brand-heading">{fmt(item.lastSeenAt)}</span></div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {item.alertCodes.length ? item.alertCodes.map((code) => (
                <span key={code} className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900">
                  <AlertTriangle className="h-3.5 w-3.5" />{alertLabels[code] || code}
                </span>
              )) : (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4" />Sehat menurut evidence saat ini</span>
              )}
            </div>
            <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
              <span>PIN belum termap: <strong className="text-brand-heading">{item.unmappedPinCount}</strong></span>
              <span>Perintah gagal 24 jam: <strong className="text-brand-heading">{item.failedJob24hCount}</strong></span>
              <span>Source IP 24 jam: <strong className="text-brand-heading">{item.sourceIp24hCount}</strong></span>
            </div>
          </article>
        ))}
        {!loading && items.length === 0 ? <div className="rounded-2xl border border-border/70 bg-white p-8 text-center text-sm text-muted-foreground">Belum ada mesin terdaftar.</div> : null}
      </div>
    </AdminShell>
  );
}
