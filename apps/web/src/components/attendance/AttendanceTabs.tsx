// ATT-014 §6.5c: the three places an employee goes after reading today — their history, their
// fortnight schedule, and the requests they have open. They are tabs, not four stacked panels,
// so the phone shows one at a time and the way to Riwayat is visible without scrolling.
//
// The tab lives in the URL hash so a direct link and the browser Back button both land where the
// reader expects: #overtime and #clarifications (the two service links HCIS has published since
// ATT-011) open Pengajuan, #jadwal opens Jadwal, anything else opens Riwayat.

import { useCallback, useEffect, useRef, useState } from "react";

export const ATTENDANCE_TABS = [
  { key: "riwayat", label: "Riwayat", hash: "" },
  { key: "jadwal", label: "Jadwal", hash: "#jadwal" },
  { key: "pengajuan", label: "Pengajuan", hash: "#pengajuan" },
] as const;

export type AttendanceTabKey = (typeof ATTENDANCE_TABS)[number]["key"];

/** Which tab a hash names. Unknown hashes stay on Riwayat rather than showing nothing. */
export function tabForHash(hash: string): AttendanceTabKey {
  const value = hash.replace(/^#/, "").toLowerCase();
  if (value === "overtime" || value === "clarifications" || value === "pengajuan") return "pengajuan";
  if (value === "jadwal") return "jadwal";
  return "riwayat";
}

/** The hash a tab writes. Riwayat is the default, so it clears the hash instead of naming itself. */
export function hashForTab(key: AttendanceTabKey): string {
  return ATTENDANCE_TABS.find((tab) => tab.key === key)?.hash ?? "";
}

export function useAttendanceTab(): [AttendanceTabKey, (key: AttendanceTabKey) => void] {
  const [tab, setTab] = useState<AttendanceTabKey>(() =>
    typeof window === "undefined" ? "riwayat" : tabForHash(window.location.hash));

  useEffect(() => {
    const sync = () => setTab(tabForHash(window.location.hash));
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  // Choosing a tab pushes a history entry, so Back returns to the tab the reader came from.
  const select = useCallback((key: AttendanceTabKey) => {
    setTab(key);
    const url = new URL(window.location.href);
    url.hash = hashForTab(key);
    window.history.pushState(window.history.state, "", url);
  }, []);

  return [tab, select];
}

/**
 * WAI-ARIA tabs: Left/Right move between tabs, Home/End jump to the ends, and the focused tab is
 * the selected one, so a keyboard reaches every panel without reaching for the mouse.
 */
export function AttendanceTabList({ tab, onSelect }: { tab: AttendanceTabKey; onSelect: (key: AttendanceTabKey) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (index: number) => {
    const next = ATTENDANCE_TABS[(index + ATTENDANCE_TABS.length) % ATTENDANCE_TABS.length]!;
    onSelect(next.key);
    refs.current[ATTENDANCE_TABS.indexOf(next)]?.focus();
  };
  return (
    <div role="tablist" aria-label="Bagian kehadiran" className="flex flex-wrap gap-1 rounded-xl bg-surface p-1">
      {ATTENDANCE_TABS.map((item, index) => {
        const selected = item.key === tab;
        return (
          <button
            key={item.key}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="tab"
            id={`tab-${item.key}`}
            aria-selected={selected}
            aria-controls={`panel-${item.key}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(item.key)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") { event.preventDefault(); move(index + 1); }
              if (event.key === "ArrowLeft") { event.preventDefault(); move(index - 1); }
              if (event.key === "Home") { event.preventDefault(); move(0); }
              if (event.key === "End") { event.preventDefault(); move(ATTENDANCE_TABS.length - 1); }
            }}
            className={`min-h-10 flex-1 rounded-lg px-4 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              selected ? "bg-surface-raised font-semibold text-brand-heading shadow-[var(--shadow-soft)]" : "font-medium text-muted-foreground hover:text-brand-heading"
            }`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function AttendancePanel({ tab, value, children }: { tab: AttendanceTabKey; value: AttendanceTabKey; children: React.ReactNode }) {
  if (tab !== value) return null;
  return (
    <div role="tabpanel" id={`panel-${value}`} aria-labelledby={`tab-${value}`} tabIndex={-1} className="mt-4">
      {children}
    </div>
  );
}
