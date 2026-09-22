import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AdmsManagementNav } from "@/components/attendance/adms/AdmsManagementNav";
import { AdminShell } from "@/layouts/AdminShell";
import { listAdmsManagementJobs, type AdmsManagementJob } from "@/lib/admsManagement";

function fmt(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

export function AdminAdmsJobsPage() {
  const [items, setItems] = useState<AdmsManagementJob[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listAdmsManagementJobs({ status: status || undefined, limit: 200 });
      setItems(result.items);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Perintah ADMS tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  return (
    <AdminShell active="attendance-adms" title="Manajemen ADMS" description="Pantau sinkronisasi dan perintah lintas mesin tanpa membuka protokol mentah.">
      <AdmsManagementNav active="jobs" />
      <section className="overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 p-4">
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-10 rounded-xl border border-border px-3 text-sm">
            <option value="">Semua status</option>
            {["pending", "delivered", "acknowledged", "succeeded", "failed", "expired", "cancelled"].map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-10 items-center gap-2 rounded-xl border border-border px-3 text-sm font-semibold disabled:opacity-60">
            <RefreshCw className={"h-4 w-4 " + (loading ? "animate-spin" : "")} />Muat ulang
          </button>
        </div>
        {error ? <div className="m-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}
        {loading ? <div className="p-8 text-center text-sm text-muted-foreground">Memuat perintah...</div> : items.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Belum ada perintah pada filter ini.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="bg-surface text-[11px] uppercase tracking-[.08em] text-muted-foreground">
                <tr><th className="px-4 py-3">Aksi</th><th className="px-4 py-3">Mesin</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Percobaan</th><th className="px-4 py-3">Dibuat</th><th className="px-4 py-3">Selesai</th></tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="px-4 py-3"><div className="font-semibold text-brand-heading">{item.action}</div><div className="text-xs text-muted-foreground">C:{item.commandNumber}</div></td>
                    <td className="px-4 py-3"><a className="font-semibold hover:underline" href={"/admin/attendance/devices/" + item.deviceId + "/commands"}>{item.deviceName || item.serialNumber}</a><div className="font-mono text-[11px] text-muted-foreground">{item.serialNumber}</div></td>
                    <td className="px-4 py-3 font-semibold">{item.status}</td><td className="px-4 py-3">{item.attemptCount}</td><td className="px-4 py-3 text-muted-foreground">{fmt(item.createdAt)}</td><td className="px-4 py-3 text-muted-foreground">{fmt(item.completedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AdminShell>
  );
}
