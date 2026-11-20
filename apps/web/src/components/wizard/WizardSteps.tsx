import { Check } from "lucide-react";

/** UX-FLOW-001: penanda langkah untuk alur bertahap (satu langkah per layar). */
export function WizardSteps({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol
      aria-label="Langkah pengajuan"
      className="mt-5 flex items-center gap-2 rounded-2xl border border-border/70 bg-surface-raised px-3 py-3 shadow-[var(--shadow-soft)]"
    >
      {steps.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={label}
            aria-current={active ? "step" : undefined}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                active
                  ? "bg-brand-primary text-brand-foreground"
                  : done
                    ? "bg-brand-primary-pale text-brand-primary-deep"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : index + 1}
            </span>
            <span
              className={`truncate text-[11px] font-semibold sm:text-xs ${
                active ? "text-brand-heading" : "text-muted-foreground"
              } ${active ? "" : "hidden sm:inline"}`}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
