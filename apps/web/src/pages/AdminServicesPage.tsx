import { useEffect, useState } from "react";
import {
  Building2,
  CalendarDays,
  Clock3,
  FileText,
  GraduationCap,
  HandCoins,
  Landmark,
  Megaphone,
  TrendingUp,
  UsersRound,
  WalletCards,
  ServerCog,
} from "lucide-react";

import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { canAccessAdminPath } from "@/lib/authorization";
import type { AuthSession } from "@/types/hcis";
import {
  adminServiceCategories,
  adminServices,
  adminServiceStageLabel,
  type AdminServiceDefinition,
} from "@/lib/adminServices";

const icons = {
  schedules: CalendarDays,
  "mobile-attendance": Clock3,
  "attendance-evaluation": Clock3,
  "shift-exchange": CalendarDays,
  adms: ServerCog,
  payroll: WalletCards,
  reimbursement: HandCoins,
  loans: Landmark,
  performance: TrendingUp,
  learning: GraduationCap,
  recruitment: UsersRound,
  "business-travel": Landmark,
  assets: FileText,
  workplace: Building2,
  documents: FileText,
  communications: Megaphone,
  sites: Building2,
} as const;

export function AdminServiceTile({ service, canOpen }: { service: AdminServiceDefinition; canOpen: boolean }) {
  const Icon = icons[service.key as keyof typeof icons] ?? FileText;
  const className = "group flex min-h-32 flex-col rounded-2xl border border-border/70 bg-white p-4 shadow-[var(--shadow-soft)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    + (canOpen ? " hover:border-brand-primary/35 hover:bg-brand-primary-pale/15" : " cursor-not-allowed opacity-70");

  const content = (
    <>

      <div className="flex items-start justify-between gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-primary-pale text-brand-primary-deep">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className={service.stage === "available"
          ? "rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-bold text-emerald-800"
          : "rounded-full bg-muted px-2.5 py-1 text-[10px] font-bold text-muted-foreground"}>
          {adminServiceStageLabel(service.stage)}
        </span>
      </div>
      <p className="mt-3 text-sm font-bold text-brand-heading">{service.label}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{service.description}</p>
      {service.details?.length ? (
        <p className="mt-2 text-[10px] font-semibold leading-4 text-brand-primary-deep">
          {service.details.join(" · ")}
        </p>
      ) : null}
      {!canOpen && service.stage === "available" ? (
        <p className="mt-2 text-[10px] font-bold leading-4 text-amber-800">Tersedia di HCIS · akun ini belum memiliki akses</p>
      ) : null}
    </>
  );

  return canOpen ? (
    <a href={service.href} className={className}>{content}</a>
  ) : (
    <div className={className} aria-disabled="true">{content}</div>
  );
}

export function AdminServicesPage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [sessionResolved, setSessionResolved] = useState(false);

  useEffect(() => {
    let active = true;
    void getCurrentSession().then((value) => {
      if (active) setSession(value);
    }).finally(() => {
      if (active) setSessionResolved(true);
    });
    return () => { active = false; };
  }, []);

  return (
    <AdminShell
      active="services"
      title="Katalog Modul HCIS"
      description="Lihat modul yang sudah tersedia dan arah pengembangan yang belum aktif. Status Tersedia selalu mengarah ke GUI operasional nyata; modul lain tetap ditandai sesuai tahapnya."
    >
      <div className="space-y-8">
        {adminServiceCategories.map((category) => {
          const services = adminServices.filter((service) => service.category === category.key);
          if (!services.length) return null;
          return (
            <section key={category.key}>
              <div className="mb-3">
                <h2 className="text-base font-bold text-brand-heading">{category.label}</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{category.description}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {services.map((service) => {
                  const canOpen = service.stage !== "available"
                    ? true
                    : sessionResolved && canAccessAdminPath(session, service.href);
                  return <AdminServiceTile key={service.key} service={service} canOpen={canOpen} />;
                })}
              </div>
            </section>
          );
        })}
      </div>
    </AdminShell>
  );
}
