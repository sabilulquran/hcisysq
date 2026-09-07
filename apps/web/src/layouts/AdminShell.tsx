import { canAccessAdminPath } from "@/lib/authorization";
import type { ReactNode } from "react";
import {
  Building2,
  CalendarDays,
  CalendarRange,
  Clock3,
  Fingerprint,
  History,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  ShieldCheck,
  Upload,
  UsersRound,
  WalletCards,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import ysqMark from "@/assets/brand/ysq-mark.png";
import { getCurrentSession, logout } from "@/lib/auth";
import { cn } from "@/lib/utils";
import type { AuthSession } from "@/types/hcis";

export type AdminNavKey =
  | "overview"
  | "employees"
  | "import"
  | "history"
  | "organization"
  | "attendance"
  | "attendance-devices"
  | "leave"
  | "leave-calendar"
  | "payslips"
  | "access";

type AdminNavItem = {
  key: AdminNavKey;
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
};

type AdminNavGroup = {
  label: string | null;
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
    ],
  },
  {
    label: "Organisasi",
    items: [{ key: "organization", label: "Struktur Organisasi", href: "/admin/organization", icon: Building2 }],
  },
  {
    label: "Kehadiran",
    items: [
      { key: "attendance", label: "Rekaman Kehadiran", href: "/admin/attendance", icon: Clock3 },
      { key: "attendance-devices", label: "Mesin Fingerprint", href: "/admin/attendance/devices", icon: Fingerprint },
    ],
  },
  {
    label: "Cuti",
    items: [
      { key: "leave", label: "Kebijakan Cuti", href: "/admin/leave", icon: CalendarDays },
      { key: "leave-calendar", label: "Kalender Kerja", href: "/admin/leave/calendar", icon: CalendarRange },
    ],
  },
  {
    label: "Payslip",
    items: [{ key: "payslips", label: "Pengelolaan Payslip", href: "/admin/payslips", icon: WalletCards }],
  },
  {
    label: "Sistem",
    items: [{ key: "access", label: "Account & Akses", href: "/admin/access", icon: KeyRound }],
  },
];

export function AdminNavigation({ active, session, compact = false }: { active: AdminNavKey; session: AuthSession | null; compact?: boolean }) {
  return (
    <nav className={compact ? "space-y-4" : "space-y-5"} aria-label="Navigasi Administrator HCIS">
      {navGroups.map((group) => ({ ...group, items: group.items.filter((item) => canAccessAdminPath(session, item.href)) })).filter((group) => group.items.length).map((group, groupIndex) => (
        <div key={group.label ?? `root-${groupIndex}`}>
          {group.label ? (
            <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">{group.label}</p>
          ) : null}
          <div className="space-y-1">
            {group.items.map((item) => {
              const Icon = item.icon;
              const selected = item.key === active;
              return (
                <a
                  key={item.key}
                  href={item.href}
                  aria-current={selected ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors",
                    selected
                      ? "bg-brand-primary-pale text-brand-primary-deep"
                      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                  )}
                >
                  <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
                  {item.label}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

export function AdminShell({
  children,
  active,
  title,
  description,
}: {
  children: ReactNode;
  active: AdminNavKey;
  title: string;
  description?: string;
}) {
  const navigate = useNavigate();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let mounted = true;
    void getCurrentSession().then((current) => {
      if (!mounted) return;
      if (!canAccessAdminPath(current, "/admin")) {
        void navigate({ to: "/" });
        return;
      }
      setSession(current);
    });
    return () => {
      mounted = false;
    };
  }, [navigate]);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      await navigate({ to: "/" });
      setLoggingOut(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f5f8f7] text-foreground lg:grid lg:grid-cols-[16.5rem_minmax(0,1fr)]">
      <aside className="border-b border-border/70 bg-white lg:min-h-screen lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-3 px-5 py-5 lg:px-6">
          <img src={ysqMark} alt="" className="h-10 w-10 object-contain" />
          <div className="min-w-0">
            <p className="text-sm font-bold leading-5 text-brand-heading">Human Capital Information System</p>
            <p className="text-[11px] text-muted-foreground">Yayasan Sabilul Qur&apos;an</p>
          </div>
        </div>

        <details className="mx-4 mb-4 rounded-xl border border-border bg-surface lg:hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-3 text-sm font-bold text-brand-heading">
            <Menu className="h-4 w-4" aria-hidden="true" />
            Menu administrasi
          </summary>
          <div className="border-t border-border bg-white p-2">
            <AdminNavigation session={session} active={active} compact />
          </div>
        </details>

        <div className="hidden px-4 lg:block">
          <AdminNavigation session={session} active={active} />
        </div>

        <div className="hidden px-4 pb-5 pt-8 lg:block">
          <div className="rounded-2xl border border-border/70 bg-surface p-4">
            <div className="flex items-center gap-2 text-xs font-bold text-brand-primary-deep">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Administrator HCIS
            </div>
            <p className="mt-2 break-all text-xs leading-5 text-muted-foreground">
              {session?.principal.email ?? "Memuat sesi..."}
            </p>
            <button
              type="button"
              onClick={() => void handleLogout()}
              disabled={loggingOut}
              className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-border bg-white text-xs font-semibold hover:bg-muted/60 disabled:opacity-60"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              {loggingOut ? "Keluar..." : "Keluar"}
            </button>
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="border-b border-border/70 bg-white/90 px-5 py-5 sm:px-7 lg:px-10">
          <div className="mx-auto max-w-7xl">
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Administrasi sistem</p>
            <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-brand-heading sm:text-[1.75rem]">{title}</h1>
            {description ? <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-5 py-6 sm:px-7 lg:px-10 lg:py-8">
          {session?.principal.principalType === "EMPLOYEE" ? <a href="/app" className="mb-4 inline-block text-sm font-semibold text-brand-primary-deep">Buka ruang pegawai</a> : null}
          {session ? children : <p>Memuat izin administrasi...</p>}
        </main>
      </div>
    </div>
  );
}
