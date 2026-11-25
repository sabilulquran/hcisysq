import {
  BadgeCheck,
  Handshake,
  LockKeyhole,
  MessagesSquare,
  RefreshCcw,
  Shield,
  ShieldCheck,
} from "lucide-react";

import ysqLogoWhite from "@/assets/brand/ysq-logo-white.png";
import { cn } from "@/lib/utils";

const brandValues = [
  { icon: BadgeCheck, label: "Uswah Hasanah", description: "Menjadi teladan yang baik", accentClass: "bg-brand-yellow text-brand-heading" },
  { icon: Handshake, label: "Ta'awun", description: "Saling menolong dalam kebaikan", accentClass: "bg-brand-cyan text-brand-heading" },
  { icon: Shield, label: "Syaja'ah", description: "Berani menghadapi tantangan", accentClass: "bg-brand-orange text-brand-heading" },
  { icon: MessagesSquare, label: "Musyawarah", description: "Terbuka untuk mencapai mufakat", accentClass: "bg-white text-brand-primary-deep" },
  { icon: RefreshCcw, label: "Muhasabah", description: "Koreksi diri dan terus memperbaiki", accentClass: "bg-brand-cyan text-brand-heading" },
  { icon: ShieldCheck, label: "Amanah", description: "Menjalankan tugas dengan totalitas", accentClass: "bg-brand-yellow text-brand-heading" },
];

export function HcisBrandPanel({ className }: { className?: string }) {
  return (
    <section
      className={cn("relative isolate overflow-hidden bg-brand-primary text-brand-foreground", className)}
      aria-label="Human Capital Information System Yayasan Sabilul Qur'an"
      style={{
        background:
          "linear-gradient(145deg, var(--brand-primary-deep) 0%, var(--brand-primary) 48%, var(--brand-accent-cyan) 132%)",
      }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          backgroundImage: "radial-gradient(circle, oklch(1 0 0 / 0.18) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
          maskImage: "linear-gradient(to bottom right, black, transparent 72%)",
        }}
      />
      <div aria-hidden="true" className="pointer-events-none absolute -left-24 top-1/3 h-72 w-72 rounded-full bg-brand-cyan/35 blur-3xl" />
      <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-14 h-56 w-56 rounded-full bg-brand-yellow/75 shadow-[var(--shadow-brand-card)]" />
      <div aria-hidden="true" className="pointer-events-none absolute right-[18%] top-[27%] h-8 w-8 rounded-full bg-brand-orange shadow-[var(--shadow-brand-card)]" />
      <div aria-hidden="true" className="pointer-events-none absolute bottom-[-7rem] right-[8%] h-64 w-64 rounded-full border border-white/25 bg-white/8 shadow-[var(--shadow-brand-card)]" />

      <div className="relative flex h-full min-h-[17rem] flex-col justify-between gap-7 p-6 sm:p-8 lg:min-h-screen lg:gap-8 lg:p-12 xl:p-14">
        <div>
          <img
            src={ysqLogoWhite}
            alt="Islamic Tahfizh School Sabilul Qur'an"
            className="mb-7 h-auto w-full max-w-[22rem] object-contain object-left"
          />

          <h1 className="max-w-2xl font-display text-3xl font-bold leading-[1.08] tracking-[-0.018em] text-white sm:text-4xl lg:text-[2.55rem] xl:text-[2.8rem]">
            Human Capital Information System
          </h1>
          <p className="mt-3 max-w-lg text-sm font-semibold leading-relaxed text-white/82 sm:text-base">
            Yayasan Sabilul Qur&apos;an
          </p>
          <p className="mt-6 max-w-xl text-base font-semibold leading-relaxed text-white sm:mt-7 lg:text-lg">
            Satu ruang untuk tumbuh, terhubung, dan melayani lebih baik.
          </p>
        </div>

        <div className="hidden lg:block" aria-label="Nilai YSQ UTSMAN">
          <div className="sq-eyebrow mb-3 flex items-center gap-3 text-white/72">
            <span className="h-px w-8 bg-brand-yellow" aria-hidden="true" />
            Nilai YSQ · UTSMAN
          </div>
          <div className="grid max-w-4xl grid-cols-3 gap-3">
            {brandValues.map((value) => {
              const Icon = value.icon;
              return (
                <article
                  key={value.label}
                  className="rounded-2xl border border-white/18 bg-white/10 p-3.5 text-white transition-transform duration-200 hover:-translate-y-0.5"
                  style={{ boxShadow: "var(--shadow-brand-card)" }}
                >
                  <div className="flex items-start gap-3">
                    <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl shadow-[var(--shadow-soft)]", value.accentClass)}>
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <h2 className="text-sm font-bold leading-tight text-white">{value.label}</h2>
                      <p className="mt-1 text-2xs leading-relaxed text-white/68">{value.description}</p>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <p className="hidden items-center gap-2 text-xs text-white/68 lg:flex">
          <LockKeyhole className="h-4 w-4 text-brand-yellow" aria-hidden="true" />
          Dirancang untuk layanan kepegawaian yang aman dan bertanggung jawab.
        </p>
      </div>
    </section>
  );
}
