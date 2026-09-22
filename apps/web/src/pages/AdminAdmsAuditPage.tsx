import { useEffect, useState } from "react";

import { AdmsManagementNav } from "@/components/attendance/adms/AdmsManagementNav";
import { AdminShell } from "@/layouts/AdminShell";
import { listAdmsManagementAudit, type AdmsManagementAudit } from "@/lib/admsManagement";

function fmt(value: string) {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

const actionLabels: Record<string, string> = {
  device_registered: "Mesin didaftarkan",
  device_updated: "Mesin diperbarui",
  mapping_created: "PIN dihubungkan",
  mapping_ended: "Hubungan PIN diakhiri",
  device_claimed: "Mesin diklaim",
  command_requested: "Perintah dibuat",
  command_cancelled: "Perintah dibatalkan",
  transfer_requested: "Sinkronisasi diminta",
  device_retired: "Mesin dipensiunkan",
};

export function AdminAdmsAuditPage() {
  const [items, setItems] = useState<AdmsManagementAudit[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listAdmsManagementAudit(200)
      .then((result) => setItems(result.items))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Audit ADMS tidak dapat dimuat."));
  }, []);

  return (
    <AdminShell active="attendance-adms" title="Manajemen ADMS" description="Riwayat perubahan administratif ADMS yang tersimpan append-only.">
      <AdmsManagementNav active="audit" />
      {error ? <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}
      <section className="overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        {items.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">Belum ada audit ADMS.</div> : (
          <div className="divide-y divide-border/70">
            {items.map((item) => (
              <div key={item.id} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="font-semibold text-brand-heading">{actionLabels[item.action] || item.action}</div>
                  <div className="text-xs text-muted-foreground">{item.deviceName || item.serialNumber || "Lintas perangkat"} · {item.actorEmail || "Aktor sistem"}</div>
                </div>
                <time className="text-xs text-muted-foreground">{fmt(item.createdAt)}</time>
              </div>
            ))}
          </div>
        )}
      </section>
    </AdminShell>
  );
}
