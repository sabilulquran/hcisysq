import { Info } from "lucide-react";

import type { OvertimeWarning } from "@/lib/workforceAttendance";

// ATT-011-6b-3 D-5b (§7.7): neutral, non-blocking notice when approved + waiting overtime goes above the
// PP 35/2021 guide figure. Information, not an accusation; sending stays possible.
export function OvertimeWarnings({ warnings, compact = false }: { warnings?: OvertimeWarning[] | null; compact?: boolean }) {
  if (!warnings?.length) return null;
  return (
    <ul role="note" aria-label="Peringatan batas lembur" className={compact ? "mt-1 space-y-0.5" : "mt-3 space-y-1 rounded-xl border border-warning-line bg-warning-soft p-3"}>
      {warnings.map((warning) => (
        <li key={warning.code} className="flex items-start gap-1.5 text-xs text-warning-ink">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{warning.message}</span>
        </li>
      ))}
    </ul>
  );
}
