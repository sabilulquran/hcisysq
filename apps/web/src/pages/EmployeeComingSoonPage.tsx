import { ArrowLeft, Check, Clock3 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";

import { AppShell } from "@/layouts/AppShell";
import {
  employeeServiceStageLabel,
  getEmployeeService,
} from "@/lib/employeeServices";
import {
  getEmployeeLeaveSummary,
  type EmployeeLeaveSummary,
} from "@/lib/employeeLeave";
import { employeeShellUser } from "@/lib/employeeIdentity";

export function EmployeeComingSoonPage() {
  const { serviceKey } = useParams({ strict: false }) as { serviceKey?: string };
  const service = serviceKey ? getEmployeeService(serviceKey) : null;
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

  if (!service || service.stage === "available") {
    return (
      <AppShell user={user} activeItem="Lainnya">
        <div className="mx-auto max-w-xl py-12 text-center">
          <h1 className="text-xl font-bold text-brand-heading">Layanan tidak ditemukan</h1>
          <a href="/app/services" className="mt-5 inline-flex text-sm font-bold text-brand-primary-deep">Kembali ke semua layanan</a>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} activeItem="Lainnya">
      <div className="mx-auto max-w-2xl py-4 sm:py-10">
        <a href="/app/services" className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Semua layanan
        </a>

        <section className="mt-5 rounded-3xl border border-border/75 bg-white p-6 shadow-[var(--shadow-soft)] sm:p-8">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-primary-pale text-brand-primary-deep">
            <Clock3 className="h-6 w-6" aria-hidden="true" />
          </span>
          <p className="mt-6 text-xs font-bold uppercase tracking-[0.16em] text-brand-primary-deep">{employeeServiceStageLabel(service.stage)}</p>
          <h1 className="mt-2 text-2xl font-bold tracking-[-0.02em] text-brand-heading sm:text-3xl">{service.label}</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{service.description}</p>

          {service.details?.length ? (
            <div className="mt-5">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Cakupan yang direncanakan</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {service.details.map((detail) => (
                  <div key={detail} className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2.5 text-sm font-semibold text-brand-heading">
                    <Check className="h-4 w-4 text-brand-primary-deep" aria-hidden="true" />
                    {detail}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-6 rounded-2xl bg-surface p-4">
            <p className="text-sm font-bold text-brand-heading">Belum tersedia untuk digunakan</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Fitur ini sudah tercatat dalam perencanaan HCIS, tetapi workflow pengguna belum diaktifkan. Belum ada tanggal peluncuran yang dijanjikan.
            </p>
            <p className="mt-3 text-xs font-semibold text-muted-foreground">
              Roadmap: {service.featureIds.join(" · ")}
            </p>
          </div>

          <a href="/app/services" className="mt-6 inline-flex h-11 items-center rounded-xl bg-brand-primary px-4 text-sm font-bold text-white">
            Lihat layanan lain
          </a>
        </section>
      </div>
    </AppShell>
  );
}
