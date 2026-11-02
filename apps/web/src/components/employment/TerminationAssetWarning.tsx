// ASSET-001 §5: in the Termination dialog, say whether the employee still holds assets in
// Aset SQ. A warning only (DRAFT): it never blocks recording, and Aset SQ being down only
// changes the wording.

import { ExternalLink, Loader2, PackageCheck, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { getEmployeeAssets, safeAssetLink, type AssetHoldings } from "@/lib/employeeAssets";

const VISIBLE_TAGS = 5;

export function TerminationAssetWarning({ employeeId }: { employeeId: string }) {
  const [holdings, setHoldings] = useState<AssetHoldings | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    void getEmployeeAssets(employeeId)
      .then((result) => { if (mounted) setHoldings(result); })
      .catch(() => { if (mounted) setFailed(true); });
    return () => { mounted = false; };
  }, [employeeId]);

  return <TerminationAssetNotice holdings={holdings} failed={failed} />;
}

/** The notice itself, separate from loading so every state is testable as markup. */
export function TerminationAssetNotice({ holdings, failed }: { holdings: AssetHoldings | null; failed: boolean }) {
  if (!holdings && !failed) {
    return (
      <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Memeriksa aset di Aset SQ...
      </p>
    );
  }

  if (failed || !holdings || holdings.status !== "AVAILABLE") {
    return (
      <p className="mt-4 rounded-xl border border-border bg-surface p-3 text-xs text-muted-foreground">
        Status aset di Aset SQ tidak dapat diperiksa saat ini. Pemberhentian tetap bisa dicatat.
      </p>
    );
  }

  if (holdings.clearance === "CLEAR") {
    return (
      <p className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-surface p-3 text-xs text-muted-foreground">
        <PackageCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
        Menurut Aset SQ, pegawai ini tidak sedang memegang aset organisasi.
      </p>
    );
  }

  const tags = holdings.assignments.slice(0, VISIBLE_TAGS).map((item) => item.assetTag);
  const more = holdings.counts.outstanding - tags.length;
  return (
    <div role="status" className="mt-4 rounded-xl border border-warning-line bg-warning-soft p-3 text-sm text-warning-ink">
      <p className="flex items-start gap-2 font-semibold">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          Pegawai ini masih memegang {holdings.counts.outstanding} aset organisasi di Aset SQ
          {holdings.counts.overdue ? ` (${holdings.counts.overdue} lewat tanggal kembali)` : ""}.
        </span>
      </p>
      <p className="mt-1 pl-6 text-xs">
        {tags.join(", ")}{more > 0 ? `, dan ${more} lainnya` : ""}
      </p>
      <p className="mt-2 pl-6 text-xs">
        Pemberhentian tetap bisa dicatat. Pastikan aset dikembalikan dan dicatat di Aset SQ.{" "}
        <a
          href={safeAssetLink(holdings.selfServiceUrl.replace(/\/my-assets\/?$/, "/"))}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-bold underline"
        >
          Buka Aset SQ<ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </p>
    </div>
  );
}
