import { ArrowLeft, Check, Clock3 } from "lucide-react";
import { useParams } from "@tanstack/react-router";

import { AdminShell } from "@/layouts/AdminShell";
import { adminServiceStageLabel, getAdminService } from "@/lib/adminServices";

export function AdminComingSoonPage() {
  const { serviceKey } = useParams({ strict: false }) as { serviceKey?: string };
  const service = serviceKey ? getAdminService(serviceKey) : null;

  if (!service) {
    return (
      <AdminShell active="services" title="Modul tidak ditemukan">
        <a href="/admin/services" className="text-sm font-bold text-brand-primary-deep">Kembali ke roadmap modul</a>
      </AdminShell>
    );
  }

  return (
    <AdminShell
      active="services"
      title={service.label}
      description={service.description}
    >
      <div className="max-w-2xl">
        <a href="/admin/services" className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Roadmap modul
        </a>

        <section className="mt-5 rounded-3xl border border-border/70 bg-white p-6 shadow-[var(--shadow-soft)] sm:p-8">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-primary-pale text-brand-primary-deep">
            <Clock3 className="h-6 w-6" aria-hidden="true" />
          </span>
          <p className="mt-6 text-xs font-bold uppercase tracking-[0.16em] text-brand-primary-deep">{adminServiceStageLabel(service.stage)}</p>
          <h2 className="mt-2 text-2xl font-bold tracking-[-0.02em] text-brand-heading">Coming Soon</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Modul ini sudah masuk arah produk HCIS, tetapi workflow operasionalnya belum aktif. Belum ada tanggal peluncuran yang dijanjikan.
          </p>

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
            <p className="text-xs font-semibold text-muted-foreground">Roadmap / specification</p>
            <p className="mt-1 text-sm font-bold text-brand-heading">{service.featureIds.join(" · ")}</p>
          </div>
        </section>
      </div>
    </AdminShell>
  );
}
