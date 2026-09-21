import {
  BarChart3, CalendarRange, ClipboardCheck, Clock3, MapPin, Radio,
  Smartphone, TimerReset, ArrowLeftRight, UserCog,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { canAccessAdminPath } from "@/lib/authorization";
import type { AuthSession } from "@/types/hcis";
import { cn } from "@/lib/utils";

export type AttendanceWorkforceSection =
  | "overview" | "locations" | "schedules" | "assignments" | "roster"
  | "clarifications" | "mobile" | "overtime" | "shift-swaps" | "reports";

const tabs: Array<{ key: AttendanceWorkforceSection; label: string; href: string; icon: typeof Clock3 }> = [
  { key: "overview", label: "Ringkasan", href: "/admin/attendance/workforce", icon: Clock3 },
  { key: "locations", label: "Lokasi", href: "/admin/attendance/workforce/locations", icon: MapPin },
  { key: "schedules", label: "Jadwal", href: "/admin/attendance/workforce/schedules", icon: CalendarRange },
  { key: "assignments", label: "Assignment", href: "/admin/attendance/workforce/assignments", icon: UserCog },
  { key: "roster", label: "Roster", href: "/admin/attendance/workforce/roster", icon: CalendarRange },
  { key: "clarifications", label: "Klarifikasi", href: "/admin/attendance/workforce/clarifications", icon: ClipboardCheck },
  { key: "mobile", label: "Evidence Mobile", href: "/admin/attendance/workforce/mobile", icon: Smartphone },
  { key: "overtime", label: "Lembur", href: "/admin/attendance/workforce/overtime", icon: TimerReset },
  { key: "shift-swaps", label: "Tukar Shift", href: "/admin/attendance/workforce/shift-swaps", icon: ArrowLeftRight },
  { key: "reports", label: "Laporan", href: "/admin/attendance/workforce/reports", icon: BarChart3 },
];

export function AttendanceWorkforceNavigation({ section, session }: {
  section: AttendanceWorkforceSection;
  session: AuthSession | null;
}) {
  const visibleTabs = tabs.filter((tab) => canAccessAdminPath(session, tab.href));
  return (
    <nav className="mb-6 flex flex-wrap gap-2 border-b border-border/80 pb-3" aria-label="Navigasi operasional kehadiran">
      {visibleTabs.map(({ key, label, href, icon: Icon }) => (
        <a key={key} href={href} aria-current={key === section ? "page" : undefined}
          className={cn("inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            key === section ? "border-brand-primary/40 bg-brand-primary-pale text-brand-primary-deep" : "border-border bg-white text-muted-foreground hover:text-brand-heading")}>
          <Icon className="h-4 w-4" aria-hidden="true" />{label}
        </a>
      ))}
    </nav>
  );
}

export function AttendanceWorkforceShell({ section, children, title, description }: {
  section: AttendanceWorkforceSection;
  children: ReactNode;
  title: string;
  description: string;
}) {
  const [session, setSession] = useState<AuthSession | null>(null);
  useEffect(() => {
    let active = true;
    void getCurrentSession().then((value) => { if (active) setSession(value); }).catch(() => { if (active) setSession(null); });
    return () => { active = false; };
  }, []);
  const canOpenAdms = canAccessAdminPath(session, "/admin/attendance/adms");
  return (
    <AdminShell active={section === "shift-swaps" ? "attendance-shift-swaps" : "attendance-workforce"} title={title} description={description}>
      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        {canOpenAdms ? (
          <a href="/admin/attendance/adms" className="rounded-2xl border border-border/70 bg-white p-4 shadow-[var(--shadow-soft)] transition hover:border-brand-primary/40">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground"><Radio className="h-4 w-4" />Back Office ADMS</div>
            <p className="mt-1 text-sm font-semibold text-brand-heading">Mesin, mapping pegawai, transaksi, perintah & pemulihan</p>
          </a>
        ) : (
          <div className="rounded-2xl border border-border/70 bg-surface p-4 text-xs leading-5 text-muted-foreground">
            <p className="font-bold text-brand-heading">Back Office ADMS</p>
            <p>{session ? "Modul sudah terpasang. Akun ini belum memiliki izin perangkat; hubungi pengelola akses." : "Memeriksa izin perangkat..."}</p>
          </div>
        )}
        <div className="rounded-2xl border border-brand-primary/30 bg-brand-primary-pale p-4">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-brand-primary-deep"><Clock3 className="h-4 w-4" />Operasional Kehadiran</div>
          <p className="mt-1 text-sm font-semibold text-brand-heading">Jadwal, roster, tukar shift, evidence, klarifikasi & laporan</p>
        </div>
      </div>
      <AttendanceWorkforceNavigation section={section} session={session} />
      {children}
    </AdminShell>
  );
}
