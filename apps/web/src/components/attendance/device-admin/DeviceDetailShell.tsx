import { ArrowLeft, RefreshCw, Wrench } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { canAccessAdminPath } from "@/lib/authorization";
import type { AuthSession } from "@/types/hcis";
import { connectivityLabel, type AdmsConnectivityStatus } from "@/lib/admsAdmin";
import { cn } from "@/lib/utils";

import { useDeviceAdmin } from "./DeviceAdminContext";

export type DeviceAdminSection =
  | "overview"
  | "users"
  | "biometrics"
  | "transactions"
  | "commands"
  | "operations"
  | "settings"
  | "diagnostics";

const tabs: Array<{ key: Exclude<DeviceAdminSection, "diagnostics">; label: string; suffix: string }> = [
  { key: "overview", label: "Ringkasan", suffix: "" },
  { key: "users", label: "Pengguna", suffix: "/users" },
  { key: "biometrics", label: "Biometrik", suffix: "/biometrics" },
  { key: "transactions", label: "Transaksi", suffix: "/transactions" },
  { key: "commands", label: "Perintah", suffix: "/commands" },
  { key: "operations", label: "Operasional", suffix: "/operations" },
  { key: "settings", label: "Pengaturan", suffix: "/settings" },
];

function fmt(value: string | null) {
  if (!value) return "Belum pernah";
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

function lifecycleLabel(value: string | undefined) {
  if (value === "active") return "Aktif";
  if (value === "disabled") return "Dinonaktifkan";
  if (value === "quarantined") return "Karantina";
  return value ?? "Belum diketahui";
}

function connectivityClass(status: AdmsConnectivityStatus | undefined) {
  if (status === "online") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "offline") return "bg-red-50 text-red-700 border-red-200";
  return "bg-slate-100 text-slate-600 border-slate-200";
}

export function DeviceDetailShell({ section, children }: { section: DeviceAdminSection; children: ReactNode }) {
  const { deviceId, detail, health, loading, refreshing, error, refresh } = useDeviceAdmin();
  const [session, setSession] = useState<AuthSession | null>(null);

  useEffect(() => {
    let active = true;
    void getCurrentSession().then((value) => {
      if (active) setSession(value);
    }).catch(() => {
      if (active) setSession(null);
    });
    return () => { active = false; };
  }, []);
  const device = detail?.item ?? null;
  const baseHref = `/admin/attendance/devices/${deviceId}`;
  const visibleTabs = tabs.filter((tab) => canAccessAdminPath(session, `${baseHref}${tab.suffix}`));
  const canOpenDiagnostics = canAccessAdminPath(session, `${baseHref}/diagnostics`);
  const title = device?.displayName?.trim() || device?.serialNumber || "Detail mesin fingerprint";
  const description = device
    ? `${connectivityLabel(health?.connectivityStatus ?? "unknown")} · ${device.serialNumber} · Terakhir terhubung ${fmt(health?.lastSuccessfulRequestAt ?? device.lastSuccessfulRequestAt)}`
    : "Memuat informasi mesin fingerprint.";

  return (
    <AdminShell active="attendance-devices" title={title} description={description}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <a
          href="/admin/attendance/devices"
          className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-brand-primary-deep"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Semua mesin
        </a>
        <div className="flex items-center gap-2">
          {device ? (
            <span className="hidden rounded-full border border-border bg-white px-3 py-1.5 text-xs font-semibold text-muted-foreground sm:inline-flex">
              {lifecycleLabel(device.lifecycle)}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing || loading}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-white px-3 text-xs font-semibold text-brand-heading hover:bg-surface disabled:opacity-60"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} aria-hidden="true" />
            {refreshing ? "Memuat..." : "Muat ulang"}
          </button>
        </div>
      </div>

      <div className="mb-6 flex flex-col gap-3 border-b border-border/80 sm:flex-row sm:items-end sm:justify-between">
        <nav className="flex flex-wrap gap-1" aria-label="Bagian mesin fingerprint">
          {visibleTabs.map((tab) => {
            const selected = section === tab.key;
            return (
              <a
                key={tab.key}
                href={`${baseHref}${tab.suffix}`}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "shrink-0 border-b-2 px-3 py-3 text-sm font-semibold transition-colors",
                  selected
                    ? "border-brand-primary text-brand-primary-deep"
                    : "border-transparent text-muted-foreground hover:text-brand-heading",
                )}
              >
                {tab.label}
              </a>
            );
          })}
        </nav>
        {canOpenDiagnostics ? (
          <a
            href={`${baseHref}/diagnostics`}
            className={cn(
              "mb-2 inline-flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-semibold",
              section === "diagnostics"
                ? "bg-slate-900 text-white"
                : "text-muted-foreground hover:bg-surface hover:text-brand-heading",
            )}
          >
            <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
            Diagnostik teknis
          </a>
        ) : null}
      </div>

      {error ? (
        <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      ) : null}

      {loading && !detail ? (
        <div className="rounded-2xl border border-border/70 bg-white p-6 text-sm text-muted-foreground shadow-[var(--shadow-soft)]">
          Memuat detail mesin...
        </div>
      ) : (
        children
      )}
    </AdminShell>
  );
}

export { connectivityClass, fmt };
