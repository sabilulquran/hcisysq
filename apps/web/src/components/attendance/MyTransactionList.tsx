import { Loader2, RefreshCw } from "lucide-react";

import { myTransactionSourceLabel, transactionKindLabel } from "@/lib/attendanceLabels";
import type { MyTransaction } from "@/lib/workforceAttendance";

// ATT-014 §6.5c (DRAFT): Transaksi saya — every raw punch of one date, as the machine or the phone
// sent it. A fact list, not a verdict: no minutes, no status, nothing calculated here.

function formatClock(value: string) {
  return new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

export function MyTransactionList({ items, refreshing, generatedAt, error, onRefresh }: {
  items: MyTransaction[];
  refreshing: boolean;
  generatedAt: string | null;
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {generatedAt ? `Diperbarui pukul ${formatClock(generatedAt)} WIB. Data dimuat ulang otomatis tiap menit.` : "Memuat transaksi…"}
        </p>
        <button type="button" onClick={onRefresh} disabled={refreshing} className="inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 text-xs font-bold disabled:opacity-50">
          {refreshing ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
          Segarkan
        </button>
      </div>
      {error ? <p role="alert" className="mt-3 rounded-xl border border-danger-line bg-danger-soft p-3 text-xs text-danger-ink">{error}</p> : null}
      {items.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">Belum ada scan yang diterima untuk tanggal ini.</p>
      ) : (
        <ol className="mt-4 divide-y rounded-xl border">
          {items.map((item, index) => (
            <li key={`${item.occurredAt}-${item.source}-${index}`} className="flex items-start justify-between gap-3 p-3 text-sm">
              <div>
                <p className="font-bold tabular-nums">{formatClock(item.occurredAt)}</p>
                <p className="text-xs text-muted-foreground">{myTransactionSourceLabel(item)}</p>
              </div>
              <div className="flex flex-wrap justify-end gap-1.5 text-2xs font-bold">
                <span className="rounded-full bg-surface px-2 py-0.5">{transactionKindLabel(item.kind)}</span>
                {item.reviewState === "needs_review" ? <span className="rounded-full bg-warning-soft px-2 py-0.5 text-warning-ink">Perlu ditinjau HC</span> : null}
                {item.afterCalculation ? <span className="rounded-full bg-brand-primary-pale px-2 py-0.5 text-brand-primary-deep">Masuk setelah dihitung</span> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
