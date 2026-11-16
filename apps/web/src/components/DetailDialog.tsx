import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * SQ Core app-shell rule "Detail views open as a pop-up" (SQ Hub docs/design/sq-core-app-shell.md):
 * the detail or edit form of one item opens on top of the page and never changes its layout.
 * Centred dialog up to 720 px (960 px when `wide`) from 768 px, full-screen sheet below. Escape,
 * the backdrop and the close button close it; focus moves in on open and returns to the opener on
 * close, Tab stays inside, and the page behind does not scroll.
 */
export function DetailDialog({
  title,
  description,
  onClose,
  wide = false,
  children,
}: {
  /** Heading and accessible name; usually the item's name. */
  title: string;
  description?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel || event.defaultPrevented) return;
      // A dialog stacked inside this one (for example a confirmation) handles its own keys first.
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== panel) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center md:items-start md:p-10" role="presentation">
      <button type="button" aria-label="Tutup" tabIndex={-1} className="absolute inset-0 h-full w-full cursor-default bg-black/45" onClick={() => closeRef.current()} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`relative flex h-full w-full flex-col overflow-y-auto bg-surface-raised shadow-[var(--shadow-raised)] outline-none md:h-auto md:max-h-[90vh] md:rounded-2xl ${wide ? "md:max-w-[960px]" : "md:max-w-[720px]"}`}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-surface-raised px-4 py-3 md:px-6 md:py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-brand-heading">{title}</h2>
            {description ? <div className="mt-0.5 text-sm text-muted-foreground">{description}</div> : null}
          </div>
          <button
            type="button"
            onClick={() => closeRef.current()}
            aria-label="Tutup"
            className="-mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        <div className="px-4 py-4 md:px-6 md:py-5">{children}</div>
      </div>
    </div>
  );
}

const DIALOG_EVENT = "sq:dialog";

function readParam(name: string): string | null {
  return typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(name);
}

/**
 * The open item lives in the URL (`?<name>=<value>`), so a link opens the same pop-up and the
 * browser's Back closes it. Returns the current value plus open and close functions.
 */
export function useDialogParam(name: string): [string | null, (value: string) => void, () => void] {
  const [value, setValue] = useState<string | null>(() => readParam(name));
  useEffect(() => {
    const sync = () => setValue(readParam(name));
    window.addEventListener("popstate", sync);
    window.addEventListener(DIALOG_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(DIALOG_EVENT, sync);
    };
  }, [name]);

  const open = (next: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set(name, next);
    window.history.pushState({ ...(window.history.state as object | null), dialog: name }, "", url);
    window.dispatchEvent(new Event(DIALOG_EVENT));
  };
  // Closing goes Back when the pop-up was opened on this page, so Back and the close button agree.
  const close = () => {
    if ((window.history.state as { dialog?: string } | null)?.dialog === name) {
      window.history.back();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete(name);
    window.history.replaceState(window.history.state, "", url);
    window.dispatchEvent(new Event(DIALOG_EVENT));
  };
  return [value, open, close];
}
