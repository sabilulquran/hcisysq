import { useEffect, useState } from "react";
import { getCurrentSession } from "@/lib/auth";
import { canAccessAdminPath, canAccessEmployeeHcPath } from "@/lib/authorization";
import { getMyNotifications } from "@/lib/notifications";
import type { ReactNode } from "react";
import type { AuthSession } from "@/types/hcis";
import {
  ArrowLeftRight,
  CalendarDays,
  Camera,
  ClipboardCheck,
  Clock3,
  Grid2X2,
  Home,
  ShieldCheck,
  WalletCards,
} from "lucide-react";

import { EmployeeAttendanceNavigation } from "@/components/attendance/EmployeeAttendanceNavigation";
import { CoreShell, type ShellNavGroup, type ShellNavItem, type ShellPreviewMode } from "@/layouts/CoreShell";
import { categoryTileClass, type ServiceCategoryTone } from "@/lib/serviceCategory";
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
  previewMode?: ShellPreviewMode;
}

// `category` paints the icon marker with the service category accent (SQ Core direction C).
const employeeNavigation: { label: string; href: string; icon: typeof Home; category?: ServiceCategoryTone }[] = [
  { label: "Beranda", href: "/app", icon: Home },
  { label: "Kehadiran", href: "/app/attendance", icon: Clock3, category: "attendance" },
  { label: "Clock In/Out", href: "/app/attendance/clock", icon: Camera, category: "attendance" },
  { label: "Tukar Shift", href: "/app/attendance/shift-swap", icon: ArrowLeftRight, category: "attendance" },
  { label: "Cuti & Izin", href: "/app/leave", icon: CalendarDays, category: "leave" },
  { label: "Slip Gaji", href: "/app/payslips", icon: WalletCards, category: "pay" },
  { label: "Semua Layanan", href: "/app/services", icon: Grid2X2, category: "service" },
];

const managementNavigation = [
  { label: "Persetujuan", href: "/app/approvals", icon: ClipboardCheck, category: "task" },
] as const;

const humanCapitalNavigation = [
  { label: "Validasi Cuti", href: "/app/hc/leave", icon: ShieldCheck, category: "task" },
  { label: "Cuti Terencana", href: "/app/hc/planned-leave", icon: CalendarDays, category: "task" },
  { label: "Penyelesaian Kehadiran", href: "/app/hc/attendance-resolution", icon: Clock3, category: "task" },
] as const;

// Phone bottom navigation: four destinations, then "Lainnya" with everything else.
const mobileShortLabels: Record<string, string> = {
  "/app": "Beranda",
  "/app/attendance": "Hadir",
  "/app/leave": "Cuti",
  "/app/approvals": "Approval",
};

function NavigationLink({
  label,
  href,
  icon: Icon,
  category,
  active = false,
}: {
  label: string;
  href: string;
  icon: typeof Home;
  category?: ServiceCategoryTone;
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
          : "text-muted-foreground hover:bg-surface-raised hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
          category
            ? categoryTileClass[category]
            : active
              ? "bg-surface-raised text-brand-primary shadow-[var(--shadow-soft)]"
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
      <nav aria-label="Tugas Human Capital" className="mb-5 rounded-2xl border border-border/80 bg-surface-raised p-3 shadow-[var(--shadow-soft)] lg:hidden">
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
      {items.map(({ label, href, icon, category }) => (
        <NavigationLink key={href} label={label} href={href} icon={icon} category={category} active={activeItem === label} />
      ))}
    </>
  );
}

export function AppShell({
  children,
  user,
  activeItem = "Beranda",
  previewMode,
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
  const humanCapitalItems = humanCapitalNavigation.filter((item) => canAccessEmployeeHcPath(session, item.href));
  const managementLabel = humanCapitalItems.length ? "Human Capital" : user.additionalRole;

  const employeeItems: ShellNavItem[] = employeeNavigation.map((item) => ({
    key: item.href,
    label: item.label,
    shortLabel: mobileShortLabels[item.href],
    href: item.href,
    icon: item.icon,
    category: item.category,
    active: attendanceActive && item.href.startsWith("/app/attendance")
      ? item.href === currentPath
      : item.label === activeItem || (item.label === "Semua Layanan" && activeItem === "Lainnya"),
  }));
  const taskItems: ShellNavItem[] = [...managementNavigation, ...humanCapitalItems].map((item) => ({
    key: item.href,
    label: item.label,
    shortLabel: mobileShortLabels[item.href],
    href: item.href,
    icon: item.icon,
    category: item.category,
    active: item.label === activeItem,
  }));
  const navigation: ShellNavGroup[] = [
    { label: "Saya", items: employeeItems },
    { label: "Tugas", badge: managementLabel, items: taskItems },
  ];
  const allItems = [...employeeItems, ...taskItems];
  const mobileItems = Object.keys(mobileShortLabels)
    .map((href) => allItems.find((item) => item.href === href))
    .filter((item): item is ShellNavItem => Boolean(item))
    .map((item) => (item.href === "/app/attendance" ? { ...item, active: attendanceActive } : item));

  const roles = [...new Set([user.position, managementLabel, canAdminister ? "Administrator HCIS" : undefined]
    .filter((role): role is string => Boolean(role)))];

  return (
    <CoreShell
      space="workspace"
      canSwitchSpace={canAdminister}
      user={{ name: user.name, initials: user.initials, detail: `${user.position} · ${user.unit}`, roles }}
      unreadNotifications={unreadNotifications}
      navigation={navigation}
      mobileItems={mobileItems}
      previewMode={previewMode}
    >
      {attendanceActive ? <EmployeeAttendanceNavigation currentPath={currentPath} /> : null}
      {children}
    </CoreShell>
  );
}
