import {
  BarChart3,
  CalendarRange,
  ClipboardCheck,
  Clock3,
  MapPin,
  Radio,
  Smartphone,
  UserCog,
} from "lucide-react";
import type { ReactNode } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import { cn } from "@/lib/utils";

export type AttendanceWorkforceSection =
  | "overview"
  | "locations"
  | "schedules"
  | "assignments"
  | "roster"
  | "clarifications"
  | "mobile"
  | "reports";

const tabs: Array<{
  key: AttendanceWorkforceSection;
  label: string;
  href: string;
  icon: typeof Clock3;
}> = [
  { key: "overview", label: "Ringkasan", href: "/admin/attendance/workforce", icon: Clock3 },
  { key: "locations", label: "Lokasi", href: "/admin/attendance/workforce/locations", icon: MapPin },
  { key: "schedules", label: "Jadwal", href: "/admin/attendance/workforce/schedules", icon: CalendarRange },
  { key: "assignments", label: "Assignment", href: "/admin/attendance/workforce/assignments", icon: UserCog },
  { key: "roster", label: "Roster", href: "/admin/attendance/workforce/roster", icon: CalendarRange },
  { key: "clarifications", label: "Klarifikasi", href: "/admin/attendance/workforce/clarifications", icon: ClipboardCheck },
  { key: "mobile", label: "Evidence Mobile", href: "/admin/attendance/workforce/mobile", icon: Smartphone },
  { key: "reports", label: "Laporan", href: "/admin/attendance/workforce/reports", icon: BarChart3 },
];

export function AttendanceWorkforceShell({
  section,
  children,
  title,
  description,
}: {
  section: AttendanceWorkforceSection;
  children: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <AdminShell active="attendance-workforce" title={title} description={description}>
      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        <a
          href="/admin/attendance/adms"
          className="rounded-2xl border border-border/70 bg-white p-4 shadow-[var(--shadow-soft)] transition hover:border-brand-primary/40"
        >
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">
            <Radio className="h-4 w-4" /> Back Office ADMS
          </div>
          <p className="mt-1 text-sm font-semibold text-brand-heading">Perangkat, mapping, transaksi, dan command</p>
        </a>
        <div className="rounded-2xl border border-brand-primary/30 bg-brand-primary-pale p-4">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-brand-primary-deep">
            <Clock3 className="h-4 w-4" /> Operasional Kehadiran
          </div>
          <p className="mt-1 text-sm font-semibold text-brand-heading">Jadwal, roster, evidence, klarifikasi, dan laporan YSQ</p>
        </div>
      </div>

      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-border/80" aria-label="Navigasi operasional kehadiran">
        {tabs.map((tab) => {
          const selected = tab.key === section;
          const Icon = tab.icon;
          return (
            <a
              key={tab.key}
              href={tab.href}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-sm font-semibold",
                selected
                  ? "border-brand-primary text-brand-primary-deep"
                  : "border-transparent text-muted-foreground hover:text-brand-heading",
              )}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </a>
          );
        })}
      </nav>

      {children}
    </AdminShell>
  );
}
