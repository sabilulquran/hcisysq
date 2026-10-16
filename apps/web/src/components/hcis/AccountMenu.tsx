import { ChevronDown, LogOut, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { logoutFromAccountMenu } from "@/lib/auth";
import { cn } from "@/lib/utils";

export interface AccountMenuUser {
  name: string;
  initials: string;
  position: string;
  unit: string;
}

interface AccountMenuProps {
  user: AccountMenuUser;
  variant: "header" | "sidebar";
}

export function AccountMenu({ user, variant }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

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
    <div ref={rootRef} className={cn("relative", variant === "sidebar" && "w-full")}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={variant === "header" ? `Menu akun ${user.name}` : undefined}
        onClick={() => {
          setLogoutError(false);
          setOpen((value) => !value);
        }}
        className={cn(
          "group flex items-center text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          variant === "header"
            ? "gap-2 rounded-2xl border border-border/70 bg-surface-raised p-1.5 shadow-[var(--shadow-soft)] sm:pr-3"
            : "w-full gap-3 rounded-3xl border border-border/70 bg-surface-raised p-3.5 shadow-[var(--shadow-soft)]",
        )}
      >
        <span
          className={cn(
            "flex shrink-0 items-center justify-center bg-brand-primary font-bold text-brand-foreground shadow-[var(--shadow-button)]",
            variant === "header" ? "h-8 w-8 rounded-xl text-xs" : "h-11 w-11 rounded-2xl text-sm",
          )}
        >
          {user.initials}
        </span>
        <span className={cn("min-w-0", variant === "header" && "hidden max-w-40 sm:block")}>
          <span className={cn("block truncate font-bold", variant === "header" ? "text-xs" : "text-sm")}>
            {user.name}
          </span>
          <span className={cn("block truncate text-muted-foreground", variant === "header" ? "text-[10px]" : "text-[11px]")}>
            {variant === "header" ? user.unit : `${user.position} · ${user.unit}`}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
            variant === "header" && "hidden sm:block",
          )}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Menu akun"
          className={cn(
            "absolute z-50 w-[min(18.5rem,calc(100vw-2rem))] rounded-2xl border border-border/80 bg-surface-raised p-2 shadow-[var(--shadow-raised)]",
            variant === "header" ? "right-0 top-full mt-2" : "bottom-full left-0 mb-2",
          )}
        >
          <div className="px-3 pb-2 pt-1.5">
            <p className="truncate text-sm font-bold text-foreground">{user.name}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{user.position} · {user.unit}</p>
          </div>

          <div className="my-1 h-px bg-border/70" aria-hidden="true" />

          <div
            role="menuitem"
            aria-disabled="true"
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-muted-foreground"
          >
            <UserRound className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-foreground/70">Akun Saya</span>
              <span className="block text-[11px] leading-4">SQ Account Center</span>
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              Segera
            </span>
          </div>

          <button
            type="button"
            role="menuitem"
            disabled={loggingOut}
            onClick={() => void handleLogout()}
            className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-destructive transition-colors hover:bg-destructive/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
          >
            <LogOut className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
            {loggingOut ? "Keluar..." : "Keluar"}
          </button>

          {logoutError ? (
            <p className="px-3 pb-1 pt-2 text-xs leading-5 text-destructive" role="alert">
              Belum dapat keluar. Silakan coba lagi.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
