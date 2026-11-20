import { CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";

/** LEAVE-UX-001: layar akhir setelah pengajuan terkirim. */
export function WizardDone({
  title,
  message,
  children,
}: {
  title: string;
  message: string;
  children?: ReactNode;
}) {
  return (
    <section className="mt-5 rounded-3xl border border-success-line bg-surface-raised p-6 text-center shadow-[var(--shadow-soft)] sm:p-8">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success-ink">
        <CheckCircle2 className="h-7 w-7" aria-hidden="true" />
      </span>
      <h2 className="mt-4 text-lg font-bold text-brand-heading">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{message}</p>
      <div className="mt-6 flex flex-col items-stretch justify-center gap-2 sm:flex-row sm:items-center">
        {children}
      </div>
    </section>
  );
}
