// LEAVE-009: the warning shown in a leave preview whose dates touch a critical period. It never
// blocks the submit button (D-01); it tells the employee HC will review after line approval.

import { AlertTriangle } from "lucide-react";

import { criticalPeriodRange, criticalPeriodWarning, type CriticalPeriodMatch } from "@/lib/leaveCriticalPeriods";

export function CriticalPeriodNotice({ periods }: { periods: readonly CriticalPeriodMatch[] | undefined }) {
  const message = criticalPeriodWarning(periods ?? []);
  if (!message || !periods) return null;
  return (
    <div role="status" className="mt-4 rounded-xl border border-warning-line bg-warning-soft p-3 text-xs leading-5 text-warning-ink">
      <p className="flex items-start gap-2 font-semibold">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        {message}
      </p>
      <ul className="mt-1 pl-6">
        {periods.map((period) => (
          <li key={period.id}>
            {period.label}: {criticalPeriodRange(period)}
            {period.unitName ? ` (${period.unitName})` : " (seluruh yayasan)"}
          </li>
        ))}
      </ul>
    </div>
  );
}
