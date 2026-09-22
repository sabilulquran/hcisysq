import { AlertTriangle, Fingerprint, HeartPulse, Link2, Loader2, RefreshCw, ServerCog, Workflow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AdmsManagementNav } from "@/components/attendance/adms/AdmsManagementNav";
import { AdminShell } from "@/layouts/AdminShell";
import { getAdmsManagementSummary, type AdmsManagementSummary } from "@/lib/admsManagement";

const emptySummary: AdmsManagementSummary = {
  fleet: { total: 0, active: 0, disabled: 0, quarantined: 0, retired: 0 },
  detectedCount: 0,
  unmappedPinCount: 0,
  reviewRequiredCount: 0,
  pendingJobCount: 0,
  failedJob24hCount: 0,
};

export function AdminAdmsBackOfficePage() {
  const [summary, setSummary] = useState<AdmsManagementSummary>(emptySummary);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await getAdmsManagementSummary());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dashboard ADMS tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const attention = summary.unmappedPinCount + summary.reviewRequiredCount + summary.failedJob24hCount + summary.detectedCount;

  return (
    <AdminShell
      active="attendance-adms"
      title="Manajemen ADMS"
      description="Satu ruang kerja untuk mesin fingerprint, pegawai, sinkronisasi, transaksi, kesehatan, dan audit."
    >
      <AdmsManagementNav active="dashboard" />

      {error ? <div className="mb-5 flex gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div> : null}

      <div className="mb-5 flex items-center justify-between gap-3">
        <div className={"rounded-xl border px-3 py-2 text-sm font-semibold " + (attention ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-800")}>
          {attention ? attention + " item perlu perhatian" : "Tidak ada item operasional yang perlu perhatian"}
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-white px-3 text-sm font-semibold disabled:opacity-60">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Muat ulang
        </button>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Total mesin", summary.fleet.total, Fingerprint, "/admin/attendance/devices"],
          ["PIN belum termap", summary.unmappedPinCount, Link2, "/admin/attendance/adms/users"],
          ["Perintah berjalan", summary.pendingJobCount, Workflow, "/admin/attendance/adms/jobs"],
          ["Perintah gagal 24 jam", summary.failedJob24hCount, HeartPulse, "/admin/attendance/adms/health"],
        ].map(([label, value, Icon, href]) => {
          const CardIcon = Icon as typeof ServerCog;
          return (
            <a key={String(label)} href={String(href)} className="rounded-2xl border border-border/70 bg-white p-4 shadow-[var(--shadow-soft)] transition hover:border-brand-primary/40">
              <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground"><CardIcon className="h-4 w-4" />{String(label)}</div>
              <p className="mt-2 text-2xl font-bold text-brand-heading">{String(value)}</p>
            </a>
          );
        })}
      </section>

      <section className="mt-5 grid gap-4 lg:grid-cols-2">
        <article className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
          <h2 className="font-bold text-brand-heading">Status armada</h2>
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            {[
              ["Aktif", summary.fleet.active],
              ["Dinonaktifkan", summary.fleet.disabled],
              ["Karantina", summary.fleet.quarantined],
              ["Dipensiunkan", summary.fleet.retired],
            ].map(([label, value]) => <div key={String(label)} className="rounded-xl bg-surface p-3"><div className="text-xs text-muted-foreground">{String(label)}</div><div className="mt-1 text-xl font-bold text-brand-heading">{String(value)}</div></div>)}
          </div>
          {summary.detectedCount ? <a href="/admin/attendance/devices" className="mt-4 block rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-900">{summary.detectedCount} mesin baru terdeteksi dan belum diklaim.</a> : null}
        </article>

        <article className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
          <h2 className="font-bold text-brand-heading">Hubungan pegawai</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Mesin hanya replica. Pegawai HCIS tetap sumber data utama dan hubungan PIN dibuat secara eksplisit.</p>
          <div className="mt-4 space-y-2">
            <a href="/admin/attendance/adms/users" className="flex items-center justify-between rounded-xl border border-border p-3 text-sm font-semibold text-brand-heading hover:bg-surface"><span>Kelola PIN belum termap</span><span>{summary.unmappedPinCount}</span></a>
            <a href="/admin/attendance/adms/users" className="flex items-center justify-between rounded-xl border border-border p-3 text-sm font-semibold text-brand-heading hover:bg-surface"><span>Hubungan perlu ditinjau</span><span>{summary.reviewRequiredCount}</span></a>
          </div>
        </article>
      </section>
    </AdminShell>
  );
}
