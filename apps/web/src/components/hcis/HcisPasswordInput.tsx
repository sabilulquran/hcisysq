import { Eye, EyeOff } from "lucide-react";
import { useState, type ComponentProps } from "react";

import { cn } from "@/lib/utils";

interface HcisPasswordInputProps extends Omit<ComponentProps<"input">, "type"> {
  label: string;
  error?: string;
}

export function HcisPasswordInput({ label, error, className, id, ...props }: HcisPasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const errorId = `${id}-error`;

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-bold text-foreground">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={visible ? "text" : "password"}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            "h-12 w-full rounded-xl border border-white/80 bg-surface-raised px-4 pr-12 outline-none shadow-[var(--shadow-input)] transition-[box-shadow,border-color,background-color] placeholder:text-muted-foreground/75 hover:border-brand-primary/20 focus:border-brand-primary/45 focus:bg-surface-raised focus:ring-2 focus:ring-brand-primary/20 focus:shadow-[var(--shadow-input-focus)]",
            error && "border-destructive/60 focus:border-destructive focus:ring-destructive/20",
            className,
          )}
          {...props}
        />
        <button
          type="button"
          className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:bg-brand-primary-pale hover:text-brand-primary-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setVisible((value) => !value)}
          aria-label={visible ? "Sembunyikan kata sandi" : "Tampilkan kata sandi"}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {error && (
        <p id={errorId} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
