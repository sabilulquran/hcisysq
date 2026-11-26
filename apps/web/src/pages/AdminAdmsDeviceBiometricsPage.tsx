import { Fingerprint, Loader2, ShieldCheck, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeviceAdmin } from "@/components/attendance/device-admin/DeviceAdminContext";
import {
  biometricAttentionCount,
  biometricReplicaLabel,
  biometricTemplateRows,
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

/** Only states the operator has to act on are coloured; the settled ones stay quiet. */
function replicaTone(value: BiometricReplicaItem["state"] | null) {
  if (value === "failed" || value === "conflict") return "text-danger-ink";
  if (value === "missing" || value === "stale") return "text-warning-ink";
  if (value === "pending") return "text-muted-foreground";
  return "text-muted-foreground";
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

  /** The count an operator acts on: templates the machine does not hold as HCIS expects. */
  const needsAttention = useMemo(() => biometricAttentionCount(replicas), [replicas]);

  if (loading) return <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Memuat biometrik…</div>;

  return (
    <div className="space-y-5">
      {error ? <div className="rounded-xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">{error}</div> : null}

      {!collectionEnabled ? (
        <section className="rounded-2xl border border-warning-line bg-warning-soft p-5">
          <div className="flex gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 text-warning-ink" /><div><h2 className="font-semibold text-warning-ink">Pengelolaan biometrik belum diaktifkan</h2><p className="mt-1 text-sm leading-6 text-warning-ink/80">Data yang sudah tercatat dapat ditinjau, tetapi pendaftaran, pencadangan, pemulihan, dan penyebaran biometrik tetap ditahan sampai aktivasi keamanan disetujui terpisah.</p></div></div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-2"><Fingerprint className="h-5 w-5 text-brand-primary" /><h2 className="font-semibold text-brand-heading">Biometrik pegawai</h2></div>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Halaman ini membaca keadaan: apa yang HCIS simpan untuk tiap pegawai, dan apa yang mesin ini
          laporkan tentang template yang sama. Isi template biometrik dan data rahasia tidak pernah ditampilkan.
        </p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {/* The four actions of the capability matrix are implemented in the API but not wired to
              any control here, so the page says so once instead of showing buttons that never act. */}
          Pendaftaran, pencadangan, pemulihan, penyebaran ke mesin lain, dan penghapusan biometrik
          <strong className="font-medium text-brand-heading"> belum dapat dijalankan dari HCIS</strong>.
          Pendaftaran sidik jari masih dilakukan di mesin, lalu hasilnya terbaca di sini.
        </p>
        {employees.length > 0 ? (
          <p className="mt-3 text-sm text-brand-heading">
            <span className="sq-nums font-semibold">{replicas.length}</span> template tercatat di mesin ini
            {needsAttention > 0 ? (
              <> · <span className="sq-nums font-semibold text-warning-ink">{needsAttention}</span> perlu diperiksa</>
            ) : null}
          </p>
        ) : null}
      </section>

      {employees.length === 0 ? (
        <div className="rounded-2xl border border-border/70 bg-surface-raised p-8 text-center text-sm text-muted-foreground">Belum ada data biometrik yang tercatat untuk mesin ini.</div>
      ) : employees.map((employee) => {
        const known = biometricTemplateRows(employee.credentials, employee.replicas);
        return (
          <section key={employee.employeeId} className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface"><UserRound className="h-5 w-5 text-brand-primary-deep" /></div>
              <div><h3 className="font-semibold text-brand-heading">{employee.employeeName}</h3><p className="sq-nums text-2xs text-muted-foreground">{employee.employeeNumber}</p></div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {known.length === 0 ? <div className="text-sm text-muted-foreground">Belum ada biometrik.</div> : known.map((item) => (
                <div key={item.key} className="rounded-xl border border-border/60 p-3">
                  <div className="text-sm font-medium text-brand-heading">{item.label}{item.slot !== null ? ` · Slot ${item.slot + 1}` : ""}</div>
                  <div className="mt-1 text-2xs text-muted-foreground">{item.vault}</div>
                  <div className={`mt-0.5 text-2xs ${replicaTone(item.machine)}`}>
                    Di mesin: {item.machine ? biometricReplicaLabel(item.machine) : "Belum diketahui"}
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
