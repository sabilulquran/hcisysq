import { AlertTriangle, ArrowLeftRight, ClipboardCheck, Smartphone, TimerReset, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import { listAttendanceCorrections } from "@/lib/attendanceCorrections";
import { todayCardLabel } from "@/lib/attendanceToday";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import { listShiftSwapsForHc } from "@/lib/shiftSwap";
import {
  getAttendanceToday,
  listAttendanceMobileEvidence,
  listAttendanceOvertime,
} from "@/lib/workforceAttendance";
import type { AuthSession } from "@/types/hcis";

function todayJakarta() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()); }

type ActionCard = { key: string; label: string; href: string; icon: typeof UsersRound; count: number | null };

// ATT-014 §5: today's numbers are scan facts, not verdicts; verdicts come from Laporan & Kalkulasi.
const TODAY_CARDS = ["scanned", "not_scanned", "not_connected", "off", "leave", "unscheduled"] as const;

/** ATT-011 §3 Ringkasan: today's numbers and what waits for HC, each only when the account can load it. */
export function AdminAttendanceSummaryPage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [today, setToday] = useState<Record<string, number> | null>(null);
  const [actions, setActions] = useState<ActionCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void getCurrentSession().then(async (current) => {
      if (!active) return;
      setSession(current);
      const date = todayJakarta();
      const can = (permission: string) => hasPermission(current, permission);
      const count = async (load: () => Promise<{ items: unknown[] }>) => {
        try { return (await load()).items.length; } catch { return null; }
      };
      const [daily, clarifications, mobile, overtime, swaps] = await Promise.all([
        can("attendance.reports.read") ? getAttendanceToday().then((value) => value.summary as Record<string, number>).catch(() => null) : Promise.resolve(undefined),
        can("attendance.clarification.manage")
          ? listAttendanceCorrections({ status: "submitted", origin: "all", mode: "all", page: 1 }).then((value) => value.submittedCount ?? value.total).catch(() => null)
          : Promise.resolve(undefined),
        can("attendance.clarification.manage") ? count(() => listAttendanceMobileEvidence({ date, reviewState: "needs_review" })) : Promise.resolve(undefined),
        can("attendance.overtime.manage") ? listAttendanceOvertime("submitted").then((value) => value.total).catch(() => null) : Promise.resolve(undefined),
        can("attendance.shift_swap.manage") ? count(() => listShiftSwapsForHc("awaiting_hc")) : Promise.resolve(undefined),
      ]);
      if (!active) return;
      if (daily === null) setError("Kehadiran hari ini tidak dapat dimuat. Coba muat ulang halaman.");
      setToday(daily ?? null);
      const cards: Array<ActionCard | null> = [
        clarifications === undefined ? null : { key: "clarifications", label: "Perbaikan absen menunggu keputusan", href: "/admin/attendance/corrections", icon: ClipboardCheck, count: clarifications },
        mobile === undefined ? null : { key: "mobile", label: "Absen HP perlu ditinjau hari ini", href: "/admin/attendance/reports?tab=transactions&source=mobile", icon: Smartphone, count: mobile },
        overtime === undefined ? null : { key: "overtime", label: "Lembur menunggu", href: "/admin/attendance/overtime", icon: TimerReset, count: overtime },
        swaps === undefined ? null : { key: "swaps", label: "Tukar shift menunggu HC", href: "/admin/attendance/schedules/swaps", icon: ArrowLeftRight, count: swaps },
      ];
      setActions(cards.filter((item): item is ActionCard => item !== null));
      setLoaded(true);
    });
    return () => { active = false; };
  }, []);

  const canSeeToday = hasPermission(session, "attendance.reports.read");

  return (
    <AttendanceWorkforceShell tab="summary" title="Waktu & Kehadiran" description="Gambaran hari ini dan hal yang menunggu tindakan Human Capital.">
      {error ? <div className="mb-5 flex gap-2 rounded-2xl border border-warning-line bg-warning-soft p-4 text-sm text-warning-ink" role="alert"><AlertTriangle className="h-4 w-4" />{error}</div> : null}

      {canSeeToday ? (
        <section aria-labelledby="attendance-today">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id="attendance-today" className="font-bold text-brand-heading">Hari ini</h2>
            <a href="/admin/attendance/daily" className="text-xs font-bold text-brand-primary-deep">Buka pantauan hari ini</a>
          </div>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {TODAY_CARDS.map((key) => (
              <article key={key} className="rounded-2xl border border-border/70 bg-surface-raised p-4 shadow-[var(--shadow-soft)]">
                <p className="text-xs font-semibold text-muted-foreground">{todayCardLabel(key)}</p>
                <p className="mt-2 text-2xl font-bold text-brand-heading">{today ? today[key] ?? 0 : "…"}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {actions.length > 0 ? (
        <section className={canSeeToday ? "mt-6" : undefined} aria-labelledby="attendance-actions">
          <h2 id="attendance-actions" className="mb-3 font-bold text-brand-heading">Perlu tindakan</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {actions.map(({ key, label, href, icon: Icon, count }) => (
              <a key={key} href={href} className="rounded-2xl border border-border/70 bg-surface-raised p-4 shadow-[var(--shadow-soft)] transition hover:border-brand-primary/40">
                <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground"><Icon className="h-4 w-4" aria-hidden="true" />{label}</div>
                <p className="mt-2 text-2xl font-bold text-brand-heading">{count === null ? "Gagal dimuat" : count}</p>
              </a>
            ))}
          </div>
        </section>
      ) : null}

      {loaded && !canSeeToday && actions.length === 0 ? (
        <div className="rounded-2xl border border-border/70 bg-surface-raised p-6 text-sm text-muted-foreground">
          Akun ini dapat membuka sebagian menu Waktu & Kehadiran, tetapi tidak memiliki ringkasan yang dapat ditampilkan. Gunakan menu di samping.
        </div>
      ) : null}
    </AttendanceWorkforceShell>
  );
}
