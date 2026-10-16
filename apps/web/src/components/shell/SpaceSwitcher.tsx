import { cn } from "@/lib/utils";

export type ShellSpace = "workspace" | "admin";

const spaces: Array<{ key: ShellSpace; href: string; label: string }> = [
  { key: "workspace", href: "/app", label: "Ruang pegawai" },
  { key: "admin", href: "/admin", label: "Administrasi" },
];

/**
 * "Pindah ruang": the single way into and out of HCIS administration
 * (sabilulquran/SQ-Hub docs/design/sq-core-app-shell.md). Segments are real links.
 */
export function SpaceSwitcher({ space, className }: { space: ShellSpace; className?: string }) {
  return (
    <div role="tablist" aria-label="Pindah ruang" className={cn("flex gap-1 rounded-xl bg-muted p-1", className)}>
      {spaces.map((item) => {
        const active = item.key === space;
        return (
          <a
            key={item.key}
            href={item.href}
            role="tab"
            aria-selected={active}
            className={cn(
              "flex min-h-9 flex-1 items-center justify-center whitespace-nowrap rounded-lg px-3.5 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-surface-raised text-brand-primary-deep shadow-[var(--shadow-soft)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </a>
        );
      })}
    </div>
  );
}
