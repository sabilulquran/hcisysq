import {
  BellRing,
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
  Clock3,
  FileText,
  GraduationCap,
  HandCoins,
  Landmark,
  Megaphone,
  TrendingUp,
  UserRoundPen,
  WalletCards,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import {
  employeeServiceCategories,
  employeeServices,
  employeeServiceStageLabel,
  type EmployeeServiceDefinition,
} from "@/lib/employeeServices";
import {
  getEmployeeLeaveSummary,
  type EmployeeLeaveSummary,
} from "@/lib/employeeLeave";
import { employeeShellUser } from "@/lib/employeeIdentity";

const icons = {
  attendance: Clock3,
  "clock-in": Clock3,
  "work-schedule": CalendarClock,
  "shift-swap": CalendarClock,
  "attendance-clarification": BellRing,
  lateness: Clock3,
  overtime: Clock3,
  leave: CalendarDays,
  "leave-balance": CalendarDays,
  approvals: ClipboardCheck,
  payslips: WalletCards,
  reimbursement: HandCoins,
  loan: Landmark,
  performance: TrendingUp,
  training: GraduationCap,
  "profile-change": UserRoundPen,
  documents: FileText,
  "business-travel": Landmark,
  assets: FileText,
  "desk-booking": CalendarDays,
  announcements: Megaphone,
  notifications: BellRing,
} as const;

function ServiceTile({ service }: { service: EmployeeServiceDefinition }) {
  const Icon = icons[service.key as keyof typeof icons] ?? FileText;
  const available = service.stage === "available";

  return (
    <a
      href={service.href}
      className="group flex min-h-36 flex-col rounded-2xl border border-border/75 bg-white p-4 shadow-[var(--shadow-soft)] transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-primary-pale text-brand-primary-deep">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className={available ? "rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-bold text-emerald-800" : "rounded-full bg-muted px-2.5 py-1 text-[10px] font-bold text-muted-foreground"}>
          {employeeServiceStageLabel(service.stage)}
        </span>
      </div>
      <p className="mt-4 text-sm font-bold text-brand-heading">{service.label}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{service.description}</p>
    </a>
  );
}

export function EmployeeServicesPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);

  useEffect(() => {
    let mounted = true;
    void getEmployeeLeaveSummary()
      .then((summary) => {
        if (mounted) setEmployee(summary.employee);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const user = useMemo(() => employeeShellUser(employee), [employee]);
  const availableCount = employeeServices.filter((service) => service.stage === "available").length;
  const plannedCount = employeeServices.length - availableCount;

  return (
    <AppShell user={user} activeItem="Lainnya">
      <div className="mx-auto max-w-5xl">
        <header>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-brand-primary-deep">Layanan pegawai</p>
          <h1 className="mt-2 text-2xl font-bold tracking-[-0.02em] text-brand-heading sm:text-3xl">Semua layanan HCIS</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Layanan disusun berdasarkan kebutuhan Anda. Yang belum aktif tetap ditampilkan sebagai arah pengembangan HCIS dan akan membuka halaman Coming Soon.
          </p>
          <div className="mt-4 flex flex-wrap gap-2 text-xs font-semibold">
            <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-emerald-800">{availableCount} tersedia</span>
            <span className="rounded-full bg-muted px-3 py-1.5 text-muted-foreground">{plannedCount} direncanakan</span>
          </div>
        </header>

        <div className="mt-8 space-y-9">
          {employeeServiceCategories.map((category) => {
            const services = employeeServices.filter((service) => service.category === category.key);
            if (!services.length) return null;
            return (
              <section key={category.key}>
                <div className="mb-3">
                  <h2 className="text-base font-bold text-brand-heading">{category.label}</h2>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{category.description}</p>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {services.map((service) => <ServiceTile key={service.key} service={service} />)}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}
