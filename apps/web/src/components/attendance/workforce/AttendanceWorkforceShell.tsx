import { useEffect, useState, type ReactNode } from "react";

import { AdminShell, type AdminNavKey } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import {
  type AttendanceTab,
  accessibleAttendanceTabs,
  attendanceSectionOf,
  attendanceTabBarKey,
  type AttendanceSectionKey,
  type AttendanceTabKey,
} from "@/lib/attendanceNavigation";
import { cn } from "@/lib/utils";
import type { AuthSession } from "@/types/hcis";

const sectionNavKey: Record<AttendanceSectionKey, AdminNavKey> = {
  summary: "attendance",
  shifts: "attendance-shifts",
  schedules: "attendance-schedules",
  records: "attendance-records",
  overtime: "attendance-overtime",
  devices: "attendance-adms",
  settings: "attendance-settings",
};

/** Sub-navigation inside one ATT-011 section; hidden when the account can open only one tab of it. */
export function AttendanceSectionTabs({ tab, session }: { tab: AttendanceTabKey; session: AuthSession | null }) {
  const section = attendanceSectionOf(tab);
  const tabs = accessibleAttendanceTabs(session, section);
  // ATT-011-8: a "Tampilan lanjutan" page is not in the bar; its parent is shown as current.
  const current = attendanceTabBarKey(tab);
  if (tabs.length < 2) return null;
  return (
    <nav className="mb-6 flex flex-wrap gap-2 border-b border-border/80 pb-3" aria-label={`Navigasi ${section.label}`}>
      {tabs.map((item) => (
        <a key={item.key} href={item.href} aria-current={item.key === current ? "page" : undefined}
          className={cn("inline-flex min-h-11 items-center rounded-xl border px-3 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            item.key === current ? "border-brand-primary/40 bg-brand-primary-pale text-brand-primary-deep" : "border-border bg-surface-raised text-muted-foreground hover:text-brand-heading")}>
          {item.label}
        </a>
      ))}
    </nav>
  );
}

/** ATT-011-8: the way from Kalender to the read-only "Tampilan lanjutan" pages; nothing when none is allowed. */
export function AttendanceAdvancedLinks({ views }: { views: AttendanceTab[] }) {
  if (!views.length) return null;
  return (
    <p className="mt-6 text-xs text-muted-foreground">
      Tampilan lanjutan (baca saja):{" "}
      {views.map((view, index) => (
        <span key={view.key}>
          {index ? " · " : null}
          <a className="font-semibold text-brand-primary-deep underline" href={view.href}>{view.label}</a>
        </span>
      ))}
    </p>
  );
}

/** ATT-011-8: top of every read-only "Tampilan lanjutan" page. */
export function AttendanceAdvancedNotice() {
  return (
    <div role="note" className="mb-4 rounded-2xl border border-border bg-surface p-4 text-sm text-muted-foreground">
      <span className="font-bold text-brand-heading">Tampilan lanjutan — baca saja.</span>{" "}
      Layar lama ini hanya untuk melihat data yang tersimpan. Ubah jadwal lewat Atur, Ganti, atau Salin jadwal di{" "}
      <a className="font-semibold text-brand-primary-deep underline" href="/admin/attendance/schedules/calendar">Kalender</a>.
    </div>
  );
}

export function AttendanceWorkforceShell({ tab, children, title, description }: {
  tab: AttendanceTabKey;
  children: ReactNode;
  title: string;
  description: string;
}) {
  const [session, setSession] = useState<AuthSession | null>(null);
  useEffect(() => {
    let active = true;
    void getCurrentSession().then((value) => { if (active) setSession(value); }).catch(() => { if (active) setSession(null); });
    return () => { active = false; };
  }, []);
  return (
    <AdminShell active={sectionNavKey[attendanceSectionOf(tab).key]} title={title} description={description}>
      <AttendanceSectionTabs tab={tab} session={session} />
      {children}
    </AdminShell>
  );
}
