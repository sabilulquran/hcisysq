import { ArrowLeftRight, CalendarRange, Camera, ClipboardCheck, TimerReset } from "lucide-react";
import { cn } from "@/lib/utils";

const employeeAttendanceLinks = [
  { label: "Riwayat & Jadwal", href: "/app/attendance", icon: CalendarRange },
  { label: "Clock In/Out", href: "/app/attendance/clock", icon: Camera },
  { label: "Klarifikasi", href: "/app/attendance#clarifications", icon: ClipboardCheck },
  { label: "Lembur", href: "/app/attendance#overtime", icon: TimerReset },
  { label: "Tukar Shift", href: "/app/attendance/shift-swap", icon: ArrowLeftRight },
] as const;

/**
 * The attendance services, for the screens that need a way across to them.
 *
 * On /app/attendance itself this nav is not rendered: that page carries Clock In/Out as its one
 * primary button and Tukar Shift beside it, and Riwayat, Jadwal and Pengajuan are its own tabs.
 * Repeating all five above the heading put a second Clock In/Out on the page and made the row of
 * buttons compete with the summary the reader came for.
 */
export function EmployeeAttendanceNavigation({ currentPath }: { currentPath: string }) {
  return (
    <nav aria-label="Layanan kehadiran pegawai" className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {employeeAttendanceLinks.map(({ label, href, icon: Icon }) => {
        const selected = !href.includes("#") && currentPath === href;
        return (
          <a key={href} href={href} aria-current={selected ? "page" : undefined}
            className={cn("inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected ? "border-brand-primary/40 bg-brand-primary-pale text-brand-primary-deep" : "border-border bg-surface-raised text-muted-foreground hover:text-brand-primary-deep")}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />{label}
          </a>
        );
      })}
    </nav>
  );
}
