import { Activity, ClipboardList, Fingerprint, HeartPulse, History, Link2, ServerCog } from "lucide-react";
import { cn } from "@/lib/utils";

export type AdmsManagementSection =
  | "dashboard"
  | "devices"
  | "users"
  | "jobs"
  | "transactions"
  | "health"
  | "audit";

const items: Array<{
  key: AdmsManagementSection;
  label: string;
  href: string;
  icon: typeof ServerCog;
}> = [
  { key: "dashboard", label: "Dashboard", href: "/admin/attendance/adms", icon: ServerCog },
  { key: "devices", label: "Perangkat", href: "/admin/attendance/devices", icon: Fingerprint },
  { key: "users", label: "Pegawai & Mapping", href: "/admin/attendance/adms/users", icon: Link2 },
  { key: "jobs", label: "Sinkronisasi & Perintah", href: "/admin/attendance/adms/jobs", icon: ClipboardList },
  { key: "transactions", label: "Transaksi", href: "/admin/attendance/adms/transactions", icon: History },
  { key: "health", label: "Kesehatan & Alert", href: "/admin/attendance/adms/health", icon: HeartPulse },
  { key: "audit", label: "Audit", href: "/admin/attendance/adms/audit", icon: Activity },
];

export function AdmsManagementNav({ active }: { active: AdmsManagementSection }) {
  return (
    <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-border/80" aria-label="Bagian Manajemen ADMS">
      {items.map((item) => {
        const Icon = item.icon;
        const selected = item.key === active;
        return (
          <a
            key={item.key}
            href={item.href}
            aria-current={selected ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-sm font-semibold transition-colors",
              selected
                ? "border-brand-primary text-brand-primary-deep"
                : "border-transparent text-muted-foreground hover:text-brand-heading",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
