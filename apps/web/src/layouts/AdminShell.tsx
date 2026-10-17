import { canAccessAdminPath } from "@/lib/authorization";
import type { ReactNode } from "react";
import {
  ArrowLeftRight,
  Building2,
  CalendarDays,
  CalendarRange,
  ClipboardCheck,
  Clock3,
  Grid2X2,
  History,
  KeyRound,
  LayoutDashboard,
  ServerCog,
  Upload,
  UsersRound,
  WalletCards,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { CoreShell, type ShellNavGroup, type ShellPreviewMode } from "@/layouts/CoreShell";
import { getCurrentSession } from "@/lib/auth";
import { getMyNotifications } from "@/lib/notifications";
import { categoryIconClass, type ServiceCategoryTone } from "@/lib/serviceCategory";
import { cn } from "@/lib/utils";
import type { AuthSession } from "@/types/hcis";

export type AdminNavKey =
  | "overview"
  | "employees"
  | "import"
  | "history"
  | "employment-consistency"
  | "organization"
  | "attendance"
  | "attendance-adms"
  | "attendance-workforce"
  | "attendance-shift-swaps"
  | "leave"
  | "leave-calendar"
  | "payslips"
  | "access"
  | "services";

type AdminNavItem = {
  key: AdminNavKey;
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
  authorizationPath?: string;
};

type AdminNavGroup = {
  label: string | null;
  /** Service category accent for the group's icon markers (SQ Core direction C). */
  category?: ServiceCategoryTone;
  items: AdminNavItem[];
};

const navGroups: AdminNavGroup[] = [
  {
    label: null,
    items: [{ key: "overview", label: "Ringkasan", href: "/admin", icon: LayoutDashboard }],
  },
  {
    label: "Pegawai",
    items: [
      { key: "employees", label: "Daftar Pegawai", href: "/admin/employees", icon: UsersRound },
      { key: "import", label: "Impor Pegawai", href: "/admin/employees/import", icon: Upload },
      { key: "history", label: "Riwayat Impor", href: "/admin/employees/imports", icon: History },
      { key: "employment-consistency", label: "Kecocokan Data", href: "/admin/employment/consistency", icon: ClipboardCheck },
    ],
  },
  {
    label: "Organisasi",
    items: [{ key: "organization", label: "Struktur Organisasi", href: "/admin/organization", icon: Building2 }],
  },
  {
    label: "Kehadiran",
    category: "attendance",
    items: [
      { key: "attendance", label: "Rekaman Kehadiran", href: "/admin/attendance", icon: Clock3 },
      { key: "attendance-workforce", label: "Operasional Kehadiran", href: "/admin/attendance/workforce", icon: CalendarRange },
      { key: "attendance-shift-swaps", label: "Persetujuan Tukar Shift", href: "/admin/attendance/workforce/shift-swaps", icon: ArrowLeftRight },
    ],
  },
  {
    label: "Perangkat ADMS",
    category: "attendance",
    items: [
      { key: "attendance-adms", label: "Manajemen ADMS", href: "/admin/attendance/adms", icon: ServerCog },
    ],
  },
  {
    label: "Cuti",
    category: "leave",
    items: [
      { key: "leave", label: "Kebijakan Cuti", href: "/admin/leave", icon: CalendarDays },
      { key: "leave-calendar", label: "Kalender Kerja", href: "/admin/leave/calendar", icon: CalendarRange },
    ],
  },
  {
    label: "Payslip",
    category: "pay",
    items: [{ key: "payslips", label: "Pengelolaan Payslip", href: "/admin/payslips", icon: WalletCards }],
  },
  {
    label: "Sistem",
    items: [{ key: "access", label: "Account & Akses", href: "/admin/access", icon: KeyRound }],
  },
  {
    label: "Modul",
    category: "service",
    items: [{ key: "services", label: "Katalog Modul", href: "/admin/services", authorizationPath: "/admin", icon: Grid2X2 }],
  },
];

function permittedGroups(session: AuthSession | null): AdminNavGroup[] {
  return navGroups
    .map((group) => ({ ...group, items: group.items.filter((item) => canAccessAdminPath(session, item.authorizationPath ?? item.href)) }))
    .filter((group) => group.items.length);
}

/**
 * Shown in page content, never in the sidebar (sidebars hold navigation only):
 * the account can run attendance operations but cannot open the ADMS back office.
 */
export function AdminDeviceAccessNote({ session }: { session: AuthSession | null }) {
  const missingDeviceAccess = canAccessAdminPath(session, "/admin/attendance/workforce")
    && !canAccessAdminPath(session, "/admin/attendance/adms");
  if (!missingDeviceAccess) return null;
  return (
    <div className="mb-5 rounded-xl border border-border bg-surface-raised p-3 text-xs leading-5 text-muted-foreground" role="note">
      <p className="font-bold text-brand-heading">ADMS sudah terpasang</p>
      <p>Akun ini belum memiliki permission perangkat yang dibutuhkan untuk membuka Back Office ADMS. Minta pengelola akses meninjau role/scope account ini.</p>
    </div>
  );
}

export function AdminNavigation({ active, session, compact = false }: { active: AdminNavKey; session: AuthSession | null; compact?: boolean }) {
  return (
    <nav className={compact ? "space-y-4" : "space-y-5"} aria-label="Navigasi Administrator HCIS">
      {permittedGroups(session).map((group, groupIndex) => (
        <div key={group.label ?? `root-${groupIndex}`}>
          {group.label ? <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">{group.label}</p> : null}
          <div className="space-y-1">
            {group.items.map((item) => {
              const Icon = item.icon;
              const selected = item.key === active;
              return (
                <a key={item.key} href={item.href} aria-current={selected ? "page" : undefined}
                  className={cn("flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected ? "bg-brand-primary-pale text-brand-primary-deep" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground")}>
                  <Icon className={cn("h-[18px] w-[18px] shrink-0", group.category ? categoryIconClass[group.category] : null)} aria-hidden="true" />{item.label}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

const attendanceKeys: AdminNavKey[] = ["attendance", "attendance-adms", "attendance-workforce", "attendance-shift-swaps"];
// Phone bottom navigation in admin: Ringkasan, Pegawai, Kehadiran, Cuti, then "Lainnya".
const mobileKeys: Array<{ key: AdminNavKey; shortLabel: string }> = [
  { key: "overview", shortLabel: "Ringkasan" },
  { key: "employees", shortLabel: "Pegawai" },
  { key: "attendance", shortLabel: "Kehadiran" },
  { key: "leave", shortLabel: "Cuti" },
];

function adminDisplayName(email: string) {
  return email.split("@")[0] || email;
}

export function AdminShell({ children, active, title, description, previewMode }: {
  children: ReactNode;
  active: AdminNavKey;
  title: string;
  description?: string;
  previewMode?: ShellPreviewMode;
}) {
  const navigate = useNavigate();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [unreadNotifications, setUnreadNotifications] = useState<number | null>(null);

  useEffect(() => {
    let mounted = true;
    void getCurrentSession().then((current) => {
      if (!mounted) return;
      if (!canAccessAdminPath(current, "/admin")) { void navigate({ to: "/" }); return; }
      setSession(current);
      if (current?.principal.principalType === "EMPLOYEE") {
        void getMyNotifications("unread", 1)
          .then((value) => { if (mounted) setUnreadNotifications(value.unreadCount); })
          .catch(() => { if (mounted) setUnreadNotifications(0); });
      }
    });
    return () => { mounted = false; };
  }, [navigate]);

  const groups = permittedGroups(session);
  const navigation: ShellNavGroup[] = groups.map((group) => ({
    label: group.label,
    items: group.items.map((item) => ({
      key: item.key,
      label: item.label,
      href: item.href,
      icon: item.icon,
      category: group.category,
      active: item.key === active,
    })),
  }));
  const flat = navigation.flatMap((group) => group.items);
  const mobileItems = mobileKeys
    .map(({ key, shortLabel }) => {
      const item = flat.find((entry) => entry.key === key);
      if (!item) return null;
      const selected = key === "attendance" ? attendanceKeys.includes(active) : item.active;
      return { ...item, shortLabel, active: selected };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const activeGroup = groups.find((group) => group.items.some((item) => item.key === active));
  const email = session?.principal.email ?? "";
  const name = email ? adminDisplayName(email) : "Administrator";

  return (
    <CoreShell
      space="admin"
      canSwitchSpace={session?.principal.principalType === "EMPLOYEE"}
      user={{ name, initials: name.slice(0, 2).toUpperCase(), detail: email || "Memuat sesi...", roles: ["Administrator HCIS"] }}
      unreadNotifications={unreadNotifications}
      navigation={navigation}
      mobileItems={mobileItems}
      breadcrumb={["Administrasi", activeGroup?.label ?? "Ringkasan"]}
      previewMode={previewMode}
    >
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-[-0.02em] text-brand-heading sm:text-[1.75rem]">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
      </header>
      {attendanceKeys.includes(active) ? <AdminDeviceAccessNote session={session} /> : null}
      {session ? children : <p>Memuat izin administrasi...</p>}
    </CoreShell>
  );
}
