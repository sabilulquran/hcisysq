import { useEffect, useState } from "react";
import { getCurrentSession } from "@/lib/auth";
import { canAccessAdminPath, canAccessEmployeeHcPath } from "@/lib/authorization";
import { getMyNotifications } from "@/lib/notifications";
import type { ReactNode } from "react";
import type { AuthSession } from "@/types/hcis";
import {
  ArrowLeftRight,
  Bell,
  CalendarDays,
  Camera,
  ClipboardCheck,
  Clock3,
  Grid2X2,
  Home,
  ShieldCheck,
  WalletCards,
} from "lucide-react";

import ysqMark from "@/assets/brand/ysq-mark.png";
import { AccountMenu } from "@/components/hcis/AccountMenu";
import { EmployeeAttendanceNavigation } from "@/components/attendance/EmployeeAttendanceNavigation";
import { cn } from "@/lib/utils";

interface AppShellUser {
  name: string;
  initials: string;
  position: string;
  unit: string;
  additionalRole?: string;
}

interface AppShellProps {
  children: ReactNode;
  user: AppShellUser;
  activeItem?: string;
  capabilities?: {
    humanCapitalOrganization?: boolean;
  };
}

const employeeNavigation = [
  { label: "Beranda", href: "/app", icon: Home },
  { label: "Kehadiran", href: "/app/attendance", icon: Clock3 },
  { label: "Clock In/Out", href: "/app/attendance/clock", icon: Camera },
  { label: "Tukar Shift", href: "/app/attendance/shift-swap", icon: ArrowLeftRight },
  { label: "Cuti & Izin", href: "/app/leave", icon: CalendarDays },
  { label: "Slip Gaji", href: "/app/payslips", icon: WalletCards },
  { label: "Semua Layanan", href: "/app/services", icon: Grid2X2 },
];

const managementNavigation = [
  { label: "Persetujuan", href: "/app/approvals", icon: ClipboardCheck },
];

const humanCapitalNavigation = [
  { label: "Validasi Cuti", href: "/app/hc/leave", icon: ShieldCheck },
  { label: "Cuti Terencana", href: "/app/hc/planned-leave", icon: CalendarDays },
  { label: "Penyelesaian Kehadiran", href: "/app/hc/attendance-resolution", icon: Clock3 },
] as const;

const mobileNavigation = [
  { label: "Beranda", activeLabel: "Beranda", href: "/app", icon: Home },
  { label: "Hadir", activeLabel: "Kehadiran", href: "/app/attendance", icon: Clock3 },
  { label: "Cuti", activeLabel: "Cuti & Izin", href: "/app/leave", icon: CalendarDays },
  { label: "Approval", activeLabel: "Persetujuan", href: "/app/approvals", icon: ClipboardCheck },
  { label: "Lainnya", activeLabel: "Lainnya", href: "/app/services", icon: Grid2X2 },
];

function NavigationLink({
  label,
  href,
  icon: Icon,
  active = false,
}: {
  label: string;
  href: string;
  icon: typeof Home;
  active?: boolean;
}) {
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-brand-primary-pale text-brand-primary-deep"
          : "text-muted-foreground hover:bg-white hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
          active
            ? "bg-white text-brand-primary shadow-[var(--shadow-soft)]"
            : "bg-muted/70 text-muted-foreground group-hover:bg-brand-primary-pale",
        )}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </a>
  );
}

export function EmployeeHumanCapitalNavigation({
  session,
  activeItem,
  mobile = false,
}: {
  session: AuthSession | null;
  activeItem: string;
  mobile?: boolean;
}) {
  const items = humanCapitalNavigation.filter((item) => canAccessEmployeeHcPath(session, item.href));
  if (!items.length) return null;

  if (mobile) {
    return (
      <nav aria-label="Tugas Human Capital" className="mb-5 rounded-2xl border border-border/80 bg-white p-3 shadow-[var(--shadow-soft)] lg:hidden">
        <div className="mb-2 flex items-center gap-2 px-1">
          <ShieldCheck className="h-4 w-4 text-brand-primary-deep" aria-hidden="true" />
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand-heading">Human Capital</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {items.map(({ label, href, icon: Icon }) => (
            <a
              key={href}
              href={href}
              aria-current={activeItem === label ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                activeItem === label
                  ? "border-brand-primary/40 bg-brand-primary-pale text-brand-primary-deep"
                  : "border-border bg-surface text-muted-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {label}
            </a>
          ))}
        </div>
      </nav>
    );
  }

  return (
    <>
      {items.map(({ label, href, icon }) => (
        <NavigationLink key={href} label={label} href={href} icon={icon} active={activeItem === label} />
      ))}
    </>
  );
}

export function AppShell({
  children,
  user,
  activeItem = "Beranda",
}: AppShellProps) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [canAdminister, setCanAdminister] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  useEffect(() => {
    let active = true;
    const refreshNotifications = () => {
      void getMyNotifications("unread", 1).then((value) => {
        if (active) setUnreadNotifications(value.unreadCount);
      }).catch(() => {
        if (active) setUnreadNotifications(0);
      });
    };
    void Promise.allSettled([getCurrentSession(), getMyNotifications("unread", 1)]).then(([sessionResult, notificationResult]) => {
      if (!active) return;
      const currentSession = sessionResult.status === "fulfilled" ? sessionResult.value : null;
      setSession(currentSession);
      setCanAdminister(canAccessAdminPath(currentSession, "/admin"));
      setUnreadNotifications(notificationResult.status === "fulfilled" ? notificationResult.value.unreadCount : 0);
    });
    window.addEventListener("hcis:notifications-changed", refreshNotifications);
    return () => {
      active = false;
      window.removeEventListener("hcis:notifications-changed", refreshNotifications);
    };
  }, []);

  const attendanceActive = ["Kehadiran", "Clock In/Out", "Tukar Shift"].includes(activeItem);
  const fallbackPath = activeItem === "Tukar Shift" ? "/app/attendance/shift-swap"
    : activeItem === "Clock In/Out" ? "/app/attendance/clock" : "/app/attendance";
  const currentPath = typeof window !== "undefined" && window.location.pathname.startsWith("/app/attendance")
    ? window.location.pathname : fallbackPath;
  const hasOrganizationHcAccess = humanCapitalNavigation.some((item) => canAccessEmployeeHcPath(session, item.href));
  const managementLabel = hasOrganizationHcAccess ? "Human Capital" : user.additionalRole;

  return (
    <div className="min-h-screen bg-surface text-foreground">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 border-r border-border/80 bg-sidebar/95 lg:flex lg:flex-col">
        <div className="flex items-start gap-3 px-7 py-6">
          <img src={ysqMark} alt="" className="h-10 w-10 shrink-0 object-contain" />
          <div className="min-w-0 pt-0.5">
            <p className="font-display text-sm font-bold leading-[1.25] tracking-[-0.01em] text-brand-heading">HCIS</p>
            <p className="mt-1 text-[10px] font-semibold leading-4 text-muted-foreground">Yayasan Sabilul Qur&apos;an</p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-5 pb-5" aria-label="Navigasi utama pegawai">
          <p className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground/70">Saya</p>
          <div className="space-y-1">
            {employeeNavigation.map((item) => (
              <NavigationLink
                key={item.label} label={item.label} href={item.href} icon={item.icon}
                active={attendanceActive && item.href.startsWith("/app/attendance")
                  ? item.href === currentPath
                  : item.label === activeItem || (item.label === "Semua Layanan" && activeItem === "Lainnya")}
              />
            ))}
          </div>

          {managementLabel ? (
            <div className="pt-6">
              <div className="mb-2 flex items-center justify-between px-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground/70">Tugas</p>
                <span className="rounded-full bg-brand-yellow/18 px-2 py-1 text-[9px] font-bold text-amber-900">{managementLabel}</span>
              </div>
              <div className="space-y-1">
                {user.additionalRole ? managementNavigation.map((item) => (
                  <NavigationLink key={item.label} label={item.label} href={item.href} icon={item.icon} active={item.label === activeItem} />
                )) : null}
                <EmployeeHumanCapitalNavigation session={session} activeItem={activeItem} />
              </div>
            </div>
          ) : null}
        </nav>

        <div className="px-5 pb-5"><AccountMenu user={user} variant="sidebar" /></div>
      </aside>

      <div className="lg:pl-72">
        <header className="sticky top-0 z-20 border-b border-border/70 bg-surface/95 px-4 py-3 backdrop-blur-sm sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-2.5 lg:hidden">
              <img src={ysqMark} alt="" className="h-9 w-9 shrink-0 object-contain" />
              <div className="min-w-0">
                <p className="font-display text-sm font-bold leading-tight text-brand-heading">HCIS</p>
                <p className="mt-0.5 truncate text-[9px] font-semibold text-muted-foreground">Yayasan Sabilul Qur&apos;an</p>
              </div>
            </div>
            <p className="hidden text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground lg:block">Ruang kerja pegawai</p>
            <div className="flex items-center gap-2">
              <a href="/app/notifications" aria-label={unreadNotifications > 0 ? `Notifikasi, ${unreadNotifications} belum dibaca` : "Notifikasi"}
                title="Buka pusat notifikasi"
                className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-border/70 bg-white text-muted-foreground shadow-[var(--shadow-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Bell className="h-[18px] w-[18px]" aria-hidden="true" />
                {unreadNotifications > 0 ? (
                  <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-red-600 px-1.5 py-0.5 text-center text-[10px] font-bold leading-4 text-white">
                    {unreadNotifications > 99 ? "99+" : unreadNotifications}
                  </span>
                ) : null}
              </a>
              {canAdminister ? (
                <a href="/admin" aria-label="Administrasi HCIS" className="inline-flex min-h-10 items-center gap-1 rounded-xl px-2 text-xs font-semibold text-brand-primary-deep">
                  <ShieldCheck className="h-4 w-4 sm:hidden" aria-hidden="true" /><span className="hidden sm:inline">Administrasi HCIS</span>
                </a>
              ) : null}
              <AccountMenu user={user} variant="header" />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 pb-28 pt-5 sm:px-6 sm:pt-7 lg:px-8 lg:pb-10">
          <EmployeeHumanCapitalNavigation session={session} activeItem={activeItem} mobile />
          {attendanceActive ? <EmployeeAttendanceNavigation currentPath={currentPath} /> : null}
          {children}
        </main>
      </div>

      <nav className="fixed inset-x-3 bottom-3 z-40 grid grid-cols-5 rounded-2xl border border-border/80 bg-white/96 p-1.5 shadow-[var(--shadow-raised)] backdrop-blur lg:hidden" aria-label="Navigasi mobile pegawai">
        {mobileNavigation.map((item) => {
          const Icon = item.icon;
          const active = item.activeLabel === activeItem || (attendanceActive && item.activeLabel === "Kehadiran");
          return (
            <a href={item.href} key={item.label} aria-current={active ? "page" : undefined}
              className={cn("flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active ? "bg-brand-primary-pale text-brand-primary-deep" : "text-muted-foreground")}>
              <Icon className="h-[19px] w-[19px]" aria-hidden="true" /><span>{item.label}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}
