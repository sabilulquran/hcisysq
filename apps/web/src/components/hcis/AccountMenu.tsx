import { ChevronDown, LogOut, UserRound } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { useDismiss } from "@/components/shell/useDismiss";
import { logoutFromAccountMenu } from "@/lib/auth";
import { SQ_HUB_URL } from "@/lib/sqCore";
import { cn } from "@/lib/utils";

export interface AccountMenuUser {
  name: string;
  initials: string;
  /** Second line of the identity block, e.g. "Staf · Unit". */
  detail: string;
  /** Role badges; the first one also shows under the name in the header. */
  roles: string[];
}

interface AccountMenuProps {
  user: AccountMenuUser;
  previewOpen?: boolean;
}

/**
 * The only place for account, role and sign-out in HCIS
 * (sabilulquran/SQ-Hub docs/design/sq-core-app-shell.md, item 5).
 * Dropdown from 768 px, bottom sheet on phones.
 */
export function AccountMenu({ user, previewOpen = false }: AccountMenuProps) {
  const [open, setOpen] = useState(previewOpen);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, rootRef, triggerRef);

  const handleLogout = async () => {
    setLoggingOut(true);
    setLogoutError(false);
    try {
      await logoutFromAccountMenu();
    } catch {
      setLogoutError(true);
      setLoggingOut(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Menu akun ${user.name}`}
        onClick={() => {
          setLogoutError(false);
          setOpen((value) => !value);
        }}
        className="group flex min-h-11 items-center gap-2.5 rounded-full p-1 text-left transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:pr-2"
      >
        <Avatar initials={user.initials} />
        <span className="hidden min-w-0 flex-col md:flex">
          <span className="max-w-40 truncate text-xs font-bold leading-tight text-foreground">{user.name}</span>
          <span className="max-w-40 truncate text-[11px] leading-tight text-muted-foreground">{user.roles[0] ?? user.detail}</span>
        </span>
        <ChevronDown
          className={cn("hidden h-4 w-4 text-muted-foreground transition-transform md:block", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={close}
            className="fixed inset-0 z-50 cursor-default bg-black/35 md:hidden"
          />
          <div
            role="menu"
            aria-label="Menu akun"
            className="fixed inset-x-0 bottom-0 z-50 rounded-t-3xl border border-border/80 bg-surface-raised p-2 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[var(--shadow-raised)] md:absolute md:inset-x-auto md:bottom-auto md:right-0 md:top-[calc(100%+0.5rem)] md:w-[19rem] md:rounded-2xl md:pb-2"
          >
            <span className="mx-auto mb-1 mt-1 block h-1 w-10 rounded-full bg-border md:hidden" aria-hidden="true" />
            <div className="flex items-center gap-3 px-3 pb-3 pt-2">
              <Avatar initials={user.initials} large />
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-foreground">{user.name}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{user.detail}</p>
                {user.roles.length ? (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {user.roles.map((role) => (
                      <span key={role} className="inline-flex rounded-full bg-brand-primary-pale px-2 py-0.5 text-[10px] font-bold text-brand-primary-deep">
                        {role}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="my-1 h-px bg-border/70" aria-hidden="true" />
            <a
              href={`${SQ_HUB_URL}/account`}
              role="menuitem"
              className="flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-sm font-semibold text-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <UserRound className="h-[18px] w-[18px] text-muted-foreground" aria-hidden="true" />
              <span className="flex min-w-0 flex-col">
                Akun SQ
                <span className="text-xs font-normal text-muted-foreground">Profil, keamanan, dan sesi</span>
              </span>
            </a>
            <div className="flex min-h-11 items-center justify-between gap-3 px-3 py-1.5">
              <span className="text-sm font-semibold text-foreground">Tampilan</span>
              <ThemeToggle />
            </div>
            <div className="my-1 h-px bg-border/70" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              disabled={loggingOut}
              onClick={() => void handleLogout()}
              className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-destructive transition hover:bg-danger-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
            >
              <LogOut className="h-[18px] w-[18px]" aria-hidden="true" />
              {loggingOut ? "Keluar..." : "Keluar"}
            </button>
            {logoutError ? (
              <p className="px-3 pb-1 pt-2 text-xs leading-5 text-destructive" role="alert">
                Belum dapat keluar. Silakan coba lagi.
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Avatar({ initials, large = false }: { initials: string; large?: boolean }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-brand-primary font-bold text-brand-foreground shadow-[var(--shadow-button)]",
        large ? "h-11 w-11 text-sm" : "h-9 w-9 text-xs",
      )}
    >
      {initials}
    </span>
  );
}
