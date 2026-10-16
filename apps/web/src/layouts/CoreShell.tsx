import { Bell, Ellipsis, type LucideIcon } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { BrandLockup } from "@/components/BrandLockup";
import { AccountMenu, type AccountMenuUser } from "@/components/hcis/AccountMenu";
import { AppLauncher } from "@/components/shell/AppLauncher";
import { SpaceSwitcher, type ShellSpace } from "@/components/shell/SpaceSwitcher";
import { useDismiss } from "@/components/shell/useDismiss";
import { categoryTileClass, type ServiceCategoryTone } from "@/lib/serviceCategory";
import { cn } from "@/lib/utils";

export interface ShellNavItem {
  key: string;
  label: string;
  /** Shorter label for the phone bottom navigation. */
  shortLabel?: string;
  href: string;
  icon: LucideIcon;
  category?: ServiceCategoryTone;
  active?: boolean;
}

export interface ShellNavGroup {
  label: string | null;
  badge?: string;
  items: ShellNavItem[];
}

export type ShellPreviewMode = "launcher" | "account-menu" | "more" | undefined;

interface CoreShellProps {
  space: ShellSpace;
  /** Show "Pindah ruang" (the user may use both spaces). */
  canSwitchSpace: boolean;
  user: AccountMenuUser;
  /** Unread count for the bell; null hides the bell (no notification centre for this user). */
  unreadNotifications: number | null;
  navigation: ShellNavGroup[];
  /** Phone bottom navigation; at most four, "Lainnya" is added after them. */
  mobileItems: ShellNavItem[];
  breadcrumb?: string[];
  previewMode?: ShellPreviewMode;
  children: ReactNode;
}

/**
 * SQ Core app shell for HCIS (sabilulquran/SQ-Hub docs/design/sq-core-app-shell.md).
 * One shell for the employee and admin spaces; only the sidebar and the selected
 * switcher segment change.
 */
export function CoreShell({
  space,
  canSwitchSpace,
  user,
  unreadNotifications,
  navigation,
  mobileItems,
  breadcrumb,
  previewMode,
  children,
}: CoreShellProps) {
  const sidebarLabel = space === "admin" ? "Navigasi Administrator HCIS" : "Navigasi utama pegawai";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b border-border bg-surface-raised">
        <div className="flex h-14 items-center gap-3 px-3 sm:px-4 md:h-16 lg:px-5">
          <a
            href={space === "admin" ? "/admin" : "/app"}
            aria-label={space === "admin" ? "Beranda Administrasi HCIS" : "Beranda HCIS"}
            className="min-w-0 shrink-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:w-[13.5rem]"
          >
            <BrandLockup compact />
          </a>
          {canSwitchSpace ? <SpaceSwitcher space={space} className="hidden md:flex" /> : null}

          <div className="ml-auto flex items-center gap-1">
            {unreadNotifications !== null ? <NotificationBell unread={unreadNotifications} /> : null}
            <AppLauncher previewOpen={previewMode === "launcher"} />
            <AccountMenu user={user} previewOpen={previewMode === "account-menu"} />
          </div>
        </div>
      </header>

      <aside className="fixed bottom-0 left-0 top-16 z-30 hidden w-14 overflow-y-auto border-r border-border bg-sidebar px-2 py-4 md:block lg:w-[248px] lg:px-3">
        <nav aria-label={sidebarLabel}>
          {navigation.map((group, index) => (
            <div key={group.label ?? `group-${index}`} className="mb-5">
              {group.label ? (
                <div className="mb-1.5 hidden items-center justify-between gap-2 px-3 lg:flex">
                  <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{group.label}</p>
                  {group.badge ? (
                    <span className="truncate rounded-full bg-warning-soft px-2 py-0.5 text-[9px] font-bold text-warning-ink">{group.badge}</span>
                  ) : null}
                </div>
              ) : null}
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.key}>
                    <SidebarLink item={item} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="md:pl-14 lg:pl-[248px]">
        <main className="mx-auto w-full max-w-7xl px-4 pb-32 pt-5 sm:px-6 sm:pt-7 md:pb-12 lg:px-8">
          {breadcrumb && breadcrumb.length > 0 ? (
            <nav aria-label="Breadcrumb" className="mb-3">
              <ol className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                {breadcrumb.map((crumb, index) => (
                  <li key={`${crumb}-${index}`} className="flex items-center gap-1.5">
                    {index > 0 ? <span aria-hidden="true">/</span> : null}
                    <span aria-current={index === breadcrumb.length - 1 ? "page" : undefined}>{crumb}</span>
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}
          {children}
        </main>
      </div>

      <MobileNavigation
        space={space}
        canSwitchSpace={canSwitchSpace}
        navigation={navigation}
        mobileItems={mobileItems}
        ariaLabel={space === "admin" ? "Navigasi mobile administrator" : "Navigasi mobile pegawai"}
        previewMoreOpen={previewMode === "more"}
      />
    </div>
  );
}

function NotificationBell({ unread }: { unread: number }) {
  return (
    <a
      href="/app/notifications"
      aria-label={unread > 0 ? `Notifikasi, ${unread} belum dibaca` : "Notifikasi"}
      title="Buka pusat notifikasi"
      className="relative flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Bell className="h-5 w-5" aria-hidden="true" />
      {unread > 0 ? (
        <span className="absolute right-1 top-1 min-w-5 rounded-full bg-destructive px-1.5 py-0.5 text-center text-[10px] font-bold leading-4 text-destructive-foreground">
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </a>
  );
}

function SidebarLink({ item }: { item: ShellNavItem }) {
  const Icon = item.icon;
  return (
    <a
      href={item.href}
      title={item.label}
      aria-current={item.active ? "page" : undefined}
      className={cn(
        "group flex min-h-10 items-center justify-center gap-3 rounded-xl px-1.5 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:justify-start lg:px-2",
        item.active
          ? "bg-brand-primary-pale font-bold text-brand-primary-deep"
          : "font-semibold text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
          item.category ? categoryTileClass[item.category] : item.active ? "bg-surface-raised text-brand-primary" : "bg-muted/70 text-muted-foreground",
        )}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="sr-only lg:not-sr-only lg:min-w-0 lg:flex-1 lg:truncate">{item.label}</span>
    </a>
  );
}

function MobileNavigation({
  space,
  canSwitchSpace,
  navigation,
  mobileItems,
  ariaLabel,
  previewMoreOpen,
}: {
  space: ShellSpace;
  canSwitchSpace: boolean;
  navigation: ShellNavGroup[];
  mobileItems: ShellNavItem[];
  ariaLabel: string;
  previewMoreOpen: boolean;
}) {
  const [open, setOpen] = useState(previewMoreOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, rootRef, triggerRef);

  const direct = mobileItems.slice(0, 4);
  const directHrefs = new Set(direct.map((item) => item.href));
  const remaining = navigation
    .map((group) => ({ ...group, items: group.items.filter((item) => !directHrefs.has(item.href)) }))
    .filter((group) => group.items.length);
  const moreActive = remaining.some((group) => group.items.some((item) => item.active));

  return (
    <div ref={rootRef} className="md:hidden">
      <nav
        aria-label={ariaLabel}
        className="fixed inset-x-3 z-40 flex rounded-2xl border border-border/80 bg-surface-raised p-1.5 shadow-[var(--shadow-raised)]"
        style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        {direct.map((item) => {
          const Icon = item.icon;
          return (
            <a key={item.key} href={item.href} aria-current={item.active ? "page" : undefined} className={tabClass(Boolean(item.active))}>
              <Icon className="h-[19px] w-[19px]" aria-hidden="true" />
              <span className="truncate">{item.shortLabel ?? item.label}</span>
            </a>
          );
        })}
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={tabClass(moreActive || open)}
        >
          <Ellipsis className="h-[19px] w-[19px]" aria-hidden="true" />
          <span className="truncate">Lainnya</span>
        </button>
      </nav>

      {open ? (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={close}
            className="fixed inset-0 z-[60] cursor-default bg-black/35"
          />
          <div
            role="dialog"
            aria-label="Lainnya"
            className="fixed inset-x-0 bottom-0 z-[60] max-h-[80dvh] overflow-y-auto rounded-t-3xl border border-border/80 bg-surface-raised p-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-[var(--shadow-raised)]"
          >
            <span className="mx-auto mb-3 block h-1 w-10 rounded-full bg-border" aria-hidden="true" />
            {canSwitchSpace ? (
              <section aria-label="Pindah ruang" className="mb-4">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Pindah ruang</p>
                <SpaceSwitcher space={space} />
              </section>
            ) : null}
            {remaining.map((group, index) => (
              <div key={group.label ?? `more-${index}`} className="mb-3">
                {group.label ? (
                  <p className="mb-1 px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{group.label}</p>
                ) : null}
                <ul className="space-y-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <li key={item.key}>
                        <a
                          href={item.href}
                          aria-current={item.active ? "page" : undefined}
                          className={cn(
                            "flex min-h-11 items-center gap-3 rounded-xl px-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            item.active ? "bg-brand-primary-pale text-brand-primary-deep" : "text-foreground hover:bg-muted",
                          )}
                        >
                          <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", item.category ? categoryTileClass[item.category] : "bg-muted/70 text-muted-foreground")}>
                            <Icon className="h-4 w-4" aria-hidden="true" />
                          </span>
                          {item.label}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function tabClass(active: boolean) {
  return cn(
    "flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active ? "bg-brand-primary-pale text-brand-primary-deep" : "text-muted-foreground",
  );
}
