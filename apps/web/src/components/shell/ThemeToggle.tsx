import { useState } from "react";

import { applyThemePreference, readThemePreference, type ThemePreference } from "@/lib/theme";

const options: Array<{ value: ThemePreference; label: string }> = [
  { value: "light", label: "Terang" },
  { value: "dark", label: "Gelap" },
  { value: "system", label: "Sistem" },
];

/** "Tampilan" row of the account menu: Terang · Gelap · Sistem. */
export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference());

  return (
    <div role="group" aria-label="Tampilan" className="flex gap-0.5 rounded-lg bg-muted p-0.5">
      {options.map((option) => {
        const checked = option.value === preference;
        return (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            onClick={() => {
              applyThemePreference(option.value);
              setPreference(option.value);
            }}
            className={[
              "min-h-8 flex-1 rounded-md px-2.5 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              checked
                ? "bg-surface-raised text-brand-primary-deep shadow-[var(--shadow-soft)]"
                : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
