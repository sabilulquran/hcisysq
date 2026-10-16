import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

interface HcisFormFieldProps extends ComponentProps<"input"> {
  label: string;
  error?: string;
}

export function HcisFormField({ label, error, className, id, ...props }: HcisFormFieldProps) {
  const errorId = `${id}-error`;

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-bold text-foreground">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          "h-12 w-full rounded-xl border border-white/80 bg-surface-raised px-4 outline-none shadow-[var(--shadow-input)] transition-[box-shadow,border-color,background-color] placeholder:text-muted-foreground/75 hover:border-brand-primary/20 focus:border-brand-primary/45 focus:bg-surface-raised focus:ring-2 focus:ring-brand-primary/20 focus:shadow-[var(--shadow-input-focus)]",
          error && "border-destructive/60 focus:border-destructive focus:ring-destructive/20",
          className,
        )}
        {...props}
      />
      {error && (
        <p id={errorId} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
