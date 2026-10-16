import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type StatusTone = "pending" | "review" | "approved" | "warning" | "neutral";

// Status colours from SQ Core direction C; they never stand in for a service category.
const toneClasses: Record<StatusTone, string> = {
  pending: "border-warning-line bg-warning-soft text-warning-ink",
  review: "border-info-line bg-info-soft text-info-ink",
  approved: "border-success-line bg-success-soft text-success-ink",
  warning: "border-danger-line bg-danger-soft text-danger-ink",
  neutral: "border-border bg-muted text-muted-foreground",
};

export function HcisStatusBadge({ children, tone = "neutral", className }: { children: ReactNode; tone?: StatusTone; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold leading-none", toneClasses[tone], className)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
      {children}
    </span>
  );
}
