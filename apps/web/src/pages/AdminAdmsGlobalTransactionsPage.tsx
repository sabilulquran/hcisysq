import { AlertTriangle, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AdmsManagementNav } from "@/components/attendance/adms/AdmsManagementNav";
import { AdminShell } from "@/layouts/AdminShell";
import {
  listAdmsDevices,
  listAdmsGlobalTransactions,
  type AdmsDevice,
  type AdmsGlobalTransaction,
} from "@/lib/attendance";

function fmt(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

function jakartaLocalDateTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

function jakartaStartOfToday() {
  return jakartaLocalDateTime().slice(0, 10) + "T00:00";
}

function toIso(value: string) {
  if (!value) return undefined;
  const date = new Date(value + ":00+07:00");
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function AdminAdmsGlobalTransactionsPage() {
  const [items, setItems] = useState<AdmsGlobalTransaction[]>([]);
  const [devices, setDevices] = useState<AdmsDevice[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [mapping, setMapping] = useState<"all" | "mapped" | "unmapped">("all");
  const [from, setFrom] = useState(jakartaStartOfToday());
  const [to, setTo] = useState(jakartaLocalDateTime());
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listAdmsDevices()
      .then((result) => setDevices(result.items))
      .catch(() => {
        // Transaction feed remains usable even if the device option catalog fails.
      });
  }, []);

  useEffect(() => {
    void listAdmsGlobalTransactions({
      deviceId: deviceId || undefined,
      mapping,
      from: toIso(from),
      to: toIso(to),
    })
      .then((result) => {
        setItems(result.items);
        setError(null);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Transaksi tidak dapat dimuat."));
  }, [deviceId, mapping, from, to]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      [item.pin, item.employeeName ?? "", item.employeeNumber ?? "", item.deviceName ?? "", item.serialNumber]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [items, q]);

  return (
    <AdminShell active="attendance-adms" title="Manajemen ADMS" description="Cari scan fingerprint lintas seluruh mesin tanpa membuka perangkat satu per satu.">
      <AdmsManagementNav active="transactions" />
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <label className="text-xs font-semibold text-muted-foreground">Dari
          <input className="mt-1 block h-10 rounded-xl border px-3 text-sm" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-xs font-semibold text-muted-foreground">Sampai
          <input className="mt-1 block h-10 rounded-xl border px-3 text-sm" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <select className="h-10 rounded-xl border px-3 text-sm" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
          <option value="">Semua mesin</option>
          {devices.map((device) => <option key={device.id} value={device.id}>{device.displayName || device.serialNumber}</option>)}
        </select>
        <select className="h-10 rounded-xl border px-3 text-sm" value={mapping} onChange={(e) => setMapping(e.target.value as typeof mapping)}>
          <option value="all">Semua mapping</option>
          <option value="mapped">Sudah mapping</option>
          <option value="unmapped">Belum mapping</option>
        </select>
        <label className="relative">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <input className="h-10 rounded-xl border pl-9 pr-3 text-sm" placeholder="Cari PIN/pegawai/mesin…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button type="button" className="h-10 rounded-xl border px-3 text-xs font-bold" onClick={() => { setFrom(jakartaStartOfToday()); setTo(jakartaLocalDateTime()); }}>Hari ini</button>
      </div>

      {error ? <div className="mb-4 flex gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><AlertTriangle className="h-4 w-4" />{error}</div> : null}

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-white shadow-[var(--shadow-soft)]">
        <header className="border-b border-border/70 px-4 py-3 text-xs text-muted-foreground">{filtered.length} transaksi pada filter aktif</header>
        <div className="overflow-x-auto">
          <table className="min-w-[1050px] w-full text-left text-sm">
            <thead className="bg-surface text-xs text-muted-foreground">
              <tr><th className="p-3">Waktu mesin</th><th className="p-3">Diterima</th><th className="p-3">Mesin</th><th className="p-3">PIN</th><th className="p-3">Pegawai</th><th className="p-3">Unit</th><th className="p-3">Mapping</th></tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((item) => <tr key={item.id}>
                <td className="p-3">{fmt(item.occurredAt)}</td>
                <td className="p-3">{fmt(item.receivedAt)}</td>
                <td className="p-3"><p className="font-semibold">{item.deviceName || item.serialNumber}</p><p className="font-mono text-xs text-muted-foreground">{item.serialNumber}</p></td>
                <td className="p-3 font-mono">{item.pin}</td>
                <td className="p-3">{item.employeeName ?? "—"}<p className="text-xs text-muted-foreground">{item.employeeNumber ?? ""}</p></td>
                <td className="p-3">{item.unitName ?? "—"}</td>
                <td className="p-3">{item.mappingState === "mapped" ? "Terhubung" : "Belum mapping"}</td>
              </tr>)}
              {filtered.length === 0 ? <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">Tidak ada transaksi pada filter ini.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </AdminShell>
  );
}
