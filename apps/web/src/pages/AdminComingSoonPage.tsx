import { ArrowLeft, Check, Clock3 } from "lucide-react";
import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { canAccessAdminPath } from "@/lib/authorization";
import { adminServiceStageLabel, getAdminService, type AdminServiceDefinition } from "@/lib/adminServices";
import type { AuthSession } from "@/types/hcis";

export function canOpenAvailableAdminService(service: AdminServiceDefinition | null, session: AuthSession | null) {
  return service?.stage === "available" && canAccessAdminPath(session, service.href);
}

export function AdminComingSoonPage() {
  const { serviceKey } = useParams({ strict: false }) as { serviceKey?: string };
  const service = serviceKey ? getAdminService(serviceKey) : null;
  const [session, setSession] = useState<AuthSession | null>(null);
  const [sessionResolved, setSessionResolved] = useState(false);

  useEffect(() => {
    let active = true;
    void getCurrentSession()
      .then((value) => { if (active) setSession(value); })
      .catch(() => { if (active) setSession(null); })
      .finally(() => { if (active) setSessionResolved(true); });
    return () => { active = false; };
  }, []);

  const canOpenAvailable = canOpenAvailableAdminService(service, session);

  useEffect(() => {
    if (
      sessionResolved &&
      canOpenAvailable &&
      service?.href.startsWith("/admin/") &&
      service.href !== window.location.pathname
    ) {
      window.location.replace(service.href);
    }
  }, [canOpenAvailable, service, sessionResolved]);

  if (!service) {
    return (
      <AdminShell active="services" title="Modul tidak ditemukan">
        <a href="/admin/services" className="text-sm font-bold text-brand-primary-deep">Kembali ke katalog modul</a>
      </AdminShell>
    );
  }

  if (service.stage === "available") {
    return (
      <AdminShell active="services" title={service.label} description={service.description}>
        <div className="max-w-xl rounded-3xl border border-border/70 bg-white p-6 shadow-[var(--shadow-soft)]">
          {!sessionResolved ? (
            <>
              <p className="text-sm font-bold text-brand-heading">Memeriksa akses {service.label}…</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">Tautan lama ini hanya diteruskan jika akun Anda memang memiliki izin ke workspace tujuan.</p>
            </>
          ) : canOpenAvailable ? (
            <>
              <p className="text-sm font-bold text-brand-heading">{service.label} sudah tersedia</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">Tautan lama ini akan diarahkan ke workspace operasional yang aktif.</p>
              <a href={service.href} className="mt-5 inline-flex min-h-11 items-center rounded-xl bg-brand-primary px-4 text-sm font-bold text-white">
                Buka {service.label}
              </a>
            </>
          ) : (
            <>
              <p className="text-sm font-bold text-brand-heading">{service.label} tersedia di HCIS</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">Akun ini belum memiliki izin untuk membuka workspace tersebut. Tidak ada hak akses yang ditambahkan melalui katalog modul.</p>
              <a href="/admin/services" className="mt-5 inline-flex min-h-11 items-center rounded-xl border border-border bg-white px-4 text-sm font-bold text-brand-heading">
                Kembali ke katalog modul
              </a>
            </>
          )}
        </div>
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
          <h2 className="mt-2 text-2xl font-bold tracking-[-0.02em] text-brand-heading">Belum tersedia untuk digunakan</h2>
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
