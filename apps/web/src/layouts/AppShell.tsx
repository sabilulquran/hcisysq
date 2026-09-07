import { useEffect, useState } from "react";
import { getCurrentSession } from "@/lib/auth";
import { canAccessAdminPath } from "@/lib/authorization";
import type { ReactNode } from "react";
import {
  Bell,
  CalendarDays,
  ClipboardCheck,
  Clock3,
  FolderOpen,
  GraduationCap,
  Home,
  ShieldCheck,
  UsersRound,
  WalletCards,
} from "lucide-react";

import ysqMark from "@/assets/brand/ysq-mark.png";
import { AccountMenu } from "@/components/hcis/AccountMenu";
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
  { label: "Cuti & Izin", href: "/app/leave", icon: CalendarDays },
  { label: "Slip Gaji", href: "/app/payslips", icon: WalletCards },
  { label: "Dokumen", href: "#", icon: FolderOpen },
  { label: "Pengembangan", href: "#", icon: GraduationCap },
];

const managementNavigation = [
  { label: "Persetujuan", href: "/app/approvals", icon: ClipboardCheck },
  { label: "Tim Saya", href: "#", icon: UsersRound },
];

const mobileNavigation = [
  { label: "Beranda", activeLabel: "Beranda", href: "/app", icon: Home },
  { label: "Hadir", activeLabel: "Kehadiran", href: "/app/attendance", icon: Clock3 },
  { label: "Cuti", activeLabel: "Cuti & Izin", href: "/app/leave", icon: CalendarDays },
  { label: "Approval", activeLabel: "Persetujuan", href: "/app/approvals", icon: ClipboardCheck },
  { label: "Slip", activeLabel: "Slip Gaji", href: "/app/payslips", icon: WalletCards },
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
        "group flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-brand-primary-pale text-brand-primary-deep shadow-[var(--shadow-soft)]"
          : "text-muted-foreground hover:bg-white hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-xl transition-colors",
          active
            ? "bg-white text-brand-primary shadow-[var(--shadow-soft)]"
            : "bg-muted/70 text-muted-foreground group-hover:bg-brand-primary-pale",
        )}
      >
        <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
      </span>
      <span>{label}</span>
    </a>
  );
}

export function AppShell({
  children,
  user,
  activeItem = "Beranda",
  capabilities,
}: AppShellProps) {
  const [canAdminister, setCanAdminister] = useState(false);
  useEffect(() => {
    let active = true;
    void getCurrentSession().then((session) => { if (active) setCanAdminister(canAccessAdminPath(session, "/admin")); });
    return () => { active = false; };
  }, []);
  const hasOrganizationHcAccess = capabilities?.humanCapitalOrganization === true;
  const managementLabel = hasOrganizationHcAccess ? "Human Capital" : user.additionalRole;

  return (
    <div className="min-h-screen bg-surface text-foreground">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 border-r border-border/80 bg-sidebar/95 px-5 py-6 lg:flex lg:flex-col">
        <div className="flex items-start gap-3 px-2">
          <img src={ysqMark} alt="" className="h-11 w-11 shrink-0 object-contain" />
          <div className="min-w-0 pt-0.5">
            <p className="font-display text-sm font-bold leading-[1.25] tracking-[-0.01em] text-brand-heading">
              Human Capital Information System
            </p>
            <p className="mt-1 text-[10px] font-semibold leading-4 text-muted-foreground">
              Yayasan Sabilul Qur&apos;an
            </p>
          </div>
        </div>

        <nav className="mt-8 flex-1 space-y-1.5" aria-label="Navigasi utama pegawai">
          <p className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground/70">Saya</p>
          {employeeNavigation.map((item) => (
            <NavigationLink
              key={item.label}
              label={item.label}
              href={item.href}
              icon={item.icon}
              active={item.label === activeItem}
            />
          ))}

          {managementLabel ? (
            <div className="pt-6">
              <div className="mb-2 flex items-center justify-between px-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground/70">Manajemen</p>
                <span className="rounded-full bg-brand-yellow/18 px-2 py-1 text-[9px] font-bold text-amber-900">{managementLabel}</span>
              </div>
              <div className="space-y-1.5">
                {managementNavigation.map((item) => (
                  <NavigationLink
                    key={item.label}
                    label={item.label}
                    href={item.href}
                    icon={item.icon}
                    active={item.label === activeItem}
                  />
                ))}
                {hasOrganizationHcAccess ? (
                  <>
                    <NavigationLink
                      label="Validasi Cuti"
                      href="/app/hc/leave"
                      icon={ShieldCheck}
                      active={activeItem === "Validasi Cuti"}
                    />
                    <NavigationLink
                      label="Cuti Terencana"
                      href="/app/hc/planned-leave"
                      icon={CalendarDays}
                      active={activeItem === "Cuti Terencana"}
                    />
                    <NavigationLink
                      label="Penyelesaian Kehadiran"
                      href="/app/hc/attendance-resolution"
                      icon={Clock3}
                      active={activeItem === "Penyelesaian Kehadiran"}
                    />
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </nav>

        <AccountMenu user={user} variant="sidebar" />
      </aside>

      <div className="lg:pl-72">
        <header className="sticky top-0 z-20 border-b border-border/70 bg-surface/92 px-4 py-3 backdrop-blur-sm sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-2.5 lg:hidden">
              <img src={ysqMark} alt="" className="h-9 w-9 shrink-0 object-contain" />
              <div className="min-w-0">
                <p className="truncate font-display text-[11px] font-bold leading-tight text-brand-heading sm:text-xs">
                  Human Capital Information System
                </p>
                <p className="mt-0.5 truncate text-[9px] font-semibold text-muted-foreground">
                  Yayasan Sabilul Qur&apos;an
                </p>
              </div>
            </div>

            <p className="hidden text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground lg:block">Ruang kerja pegawai</p>

            <div className="flex items-center gap-2">
              <button type="button" aria-label="Notifikasi" className="relative flex h-10 w-10 items-center justify-center rounded-2xl border border-border/70 bg-white text-muted-foreground shadow-[var(--shadow-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Bell className="h-[18px] w-[18px]" aria-hidden="true" />
              </button>
              {canAdminister ? <a href="/admin" className="text-xs font-semibold text-brand-primary-deep">Administrasi HCIS</a> : null}
              <AccountMenu user={user} variant="header" />
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-4 pb-28 pt-6 sm:px-6 sm:pt-8 lg:px-8 lg:pb-10">{children}</main>
      </div>

      <nav className="fixed inset-x-3 bottom-3 z-40 grid grid-cols-5 rounded-[1.75rem] border border-border/80 bg-white/96 p-1.5 shadow-[var(--shadow-raised)] backdrop-blur lg:hidden" aria-label="Navigasi mobile pegawai">
        {mobileNavigation.map((item) => {
          const Icon = item.icon;
          const active = item.activeLabel === activeItem;
          return (
            <a
              href={item.href}
              key={item.label}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center gap-1 rounded-2xl px-1 text-[10px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active ? "bg-brand-primary-pale text-brand-primary-deep" : "text-muted-foreground",
              )}
            >
              <Icon className="h-[19px] w-[19px]" aria-hidden="true" />
              <span>{item.label}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}
