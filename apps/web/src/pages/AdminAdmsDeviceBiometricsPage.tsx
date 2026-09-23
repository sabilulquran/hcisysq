import { Fingerprint, Loader2, ShieldCheck, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeviceAdmin } from "@/components/attendance/device-admin/DeviceAdminContext";
import {
  biometricModalityLabel,
  getBiometricControlPlane,
  listBiometricCredentials,
  listBiometricReplicaInventory,
  type BiometricCredentialItem,
  type BiometricReplicaItem,
} from "@/lib/admsBiometrics";

type EmployeeBiometrics = {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  credentials: BiometricCredentialItem[];
  replicas: BiometricReplicaItem[];
};

function replicaLabel(value: BiometricReplicaItem["state"]) {
  if (value === "present" || value === "succeeded") return "Tersimpan";
  if (value === "pending") return "Sedang disinkronkan";
  if (value === "failed" || value === "conflict") return "Perlu ditinjau";
  if (value === "missing") return "Belum ada";
  if (value === "stale") return "Perlu diperbarui";
  return "Belum diketahui";
}

export function AdminAdmsDeviceBiometricsPage() {
  const { deviceId } = useDeviceAdmin();
  const [credentials, setCredentials] = useState<BiometricCredentialItem[]>([]);
  const [replicas, setReplicas] = useState<BiometricReplicaItem[]>([]);
  const [collectionEnabled, setCollectionEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [summary, credentialPage, inventory] = await Promise.all([
      getBiometricControlPlane(deviceId),
      listBiometricCredentials({ deviceId, page: 1, pageSize: 100 }),
      listBiometricReplicaInventory(deviceId),
    ]);
    setCollectionEnabled(summary.collection.effectiveEnabled);
    setCredentials(credentialPage.items);
    setReplicas(inventory.items);
  }, [deviceId]);

  useEffect(() => {
    setLoading(true);
    void load().then(() => setError(null)).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Data biometrik tidak dapat dimuat.");
    }).finally(() => setLoading(false));
  }, [load]);

  const employees = useMemo(() => {
    const map = new Map<string, EmployeeBiometrics>();
    for (const item of credentials) {
      const current = map.get(item.employeeId) ?? { employeeId: item.employeeId, employeeName: item.employeeName, employeeNumber: item.employeeNumber, credentials: [], replicas: [] };
      current.credentials.push(item);
      map.set(item.employeeId, current);
    }
    for (const item of replicas) {
      const current = map.get(item.employeeId) ?? { employeeId: item.employeeId, employeeName: item.employeeName, employeeNumber: item.employeeNumber, credentials: [], replicas: [] };
      current.replicas.push(item);
      map.set(item.employeeId, current);
    }
    return Array.from(map.values()).sort((a, b) => a.employeeName.localeCompare(b.employeeName, "id"));
  }, [credentials, replicas]);

  if (loading) return <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Memuat biometrik…</div>;

  return (
    <div className="space-y-5">
      {error ? <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}

      {!collectionEnabled ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <div className="flex gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 text-amber-700" /><div><h2 className="font-bold text-amber-900">Pengelolaan biometrik belum diaktifkan</h2><p className="mt-1 text-sm leading-6 text-amber-900/80">Data yang sudah tercatat dapat ditinjau, tetapi pendaftaran, pencadangan, pemulihan, dan penyebaran biometrik tetap ditahan sampai aktivasi keamanan disetujui terpisah.</p></div></div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-2"><Fingerprint className="h-5 w-5 text-brand-primary" /><h2 className="font-bold text-brand-heading">Biometrik pegawai</h2></div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Tampilan ini berpusat pada pegawai. Isi template biometrik dan data rahasia tidak pernah ditampilkan.</p>
      </section>

      {employees.length === 0 ? (
        <div className="rounded-2xl border border-border/70 bg-white p-8 text-center text-sm text-muted-foreground">Belum ada data biometrik yang tercatat untuk mesin ini.</div>
      ) : employees.map((employee) => {
        const known = [...employee.credentials.map((item) => ({
          key: item.id,
          label: biometricModalityLabel(item.modality),
          slot: item.slotIndex,
          state: item.lifecycle === "active" ? "Tersimpan" : "Tidak aktif",
        })), ...employee.replicas.filter((replica) => !employee.credentials.some((credential) => credential.id === replica.credentialId)).map((item) => ({
          key: `${item.credentialId}:${item.state}`,
          label: biometricModalityLabel(item.modality as "fingerprint" | "face" | "palm" | "bio_photo"),
          slot: item.slotIndex,
          state: replicaLabel(item.state),
        }))];
        return (
          <section key={employee.employeeId} className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface"><UserRound className="h-5 w-5 text-brand-primary-deep" /></div><div><h3 className="font-bold text-brand-heading">{employee.employeeName}</h3><p className="text-xs text-muted-foreground">{employee.employeeNumber}</p></div></div>
              <button type="button" disabled={!collectionEnabled} className="h-9 rounded-xl border border-border px-3 text-xs font-semibold disabled:opacity-50">Daftarkan sidik jari</button>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {known.length === 0 ? <div className="text-sm text-muted-foreground">Belum ada biometrik.</div> : known.map((item) => <div key={item.key} className="rounded-xl border border-border/60 p-3"><div className="text-sm font-semibold text-brand-heading">{item.label}{item.slot !== null ? ` · Slot ${item.slot + 1}` : ""}</div><div className="mt-1 text-xs text-muted-foreground">{item.state}</div></div>)}
            </div>
            <div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled className="h-8 rounded-lg border border-border px-3 text-xs font-semibold opacity-50">Cadangkan</button><button type="button" disabled className="h-8 rounded-lg border border-border px-3 text-xs font-semibold opacity-50">Pulihkan</button><button type="button" disabled className="h-8 rounded-lg border border-border px-3 text-xs font-semibold opacity-50">Sinkronkan ke mesin lain</button><button type="button" disabled className="h-8 rounded-lg border border-border px-3 text-xs font-semibold opacity-50">Hapus biometrik terpilih</button></div>
          </section>
        );
      })}
    </div>
  );
}
