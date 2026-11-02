// ASSET-001 Asset Saya: a read-only view of what the employee holds, read live from Aset SQ.
// Accepting, rejecting, and returning stay in Aset SQ. Spec: docs/domain/employee-assets.md §4.

import { ArrowLeft, ExternalLink, Laptop, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";
import { formatAssetDate, getMyAssets, safeAssetLink, type AssetHoldings } from "@/lib/employeeAssets";

export function EmployeeAssetsPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [holdings, setHoldings] = useState<AssetHoldings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const user = useMemo(() => employeeShellUser(employee), [employee]);

  useEffect(() => {
    void (async () => {
      const [summary, assets] = await Promise.allSettled([getEmployeeLeaveSummary(), getMyAssets()]);
      if (summary.status === "fulfilled") setEmployee(summary.value.employee);
      if (assets.status === "fulfilled") setHoldings(assets.value);
      else setError(assets.reason instanceof Error ? assets.reason.message : "Data aset tidak dapat dimuat.");
      setLoading(false);
    })();
  }, []);

  return (
    <AppShell user={user} activeItem="Semua Layanan">
      <section className="mx-auto max-w-3xl">
        <a href="/app/services" className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />Semua layanan
        </a>
        <p className="mt-4 text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Layanan Pegawai</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Asset Saya</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Aset organisasi yang sedang menjadi tanggung jawab Anda, menurut catatan Aset SQ. Untuk menerima,
          menolak, atau mengembalikan aset, buka Aset SQ.
        </p>

        {error ? (
          <div className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div>
        ) : null}

        {loading ? (
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />Memuat aset...
          </div>
        ) : holdings ? (
          <AssetHoldingsView holdings={holdings} />
        ) : null}
      </section>
    </AppShell>
  );
}

/** What Aset SQ said, separate from loading so every state is testable as markup. */
export function AssetHoldingsView({ holdings }: { holdings: AssetHoldings }) {
  const link = safeAssetLink(holdings.selfServiceUrl);
  const openButton = (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground"
    >
      Buka Aset SQ
      <ExternalLink className="h-4 w-4" aria-hidden="true" />
    </a>
  );

  if (holdings.status !== "AVAILABLE") {
    return (
      <div className="mt-6 rounded-3xl border border-border/75 bg-surface-raised p-6 shadow-[var(--shadow-soft)]">
        <p className="font-bold text-brand-heading">Daftar aset belum dapat ditampilkan di HCIS</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {holdings.status === "NOT_CONFIGURED"
            ? "Sambungan ke Aset SQ belum diaktifkan. Anda tetap dapat melihat aset Anda langsung di Aset SQ."
            : "Aset SQ sedang tidak dapat dihubungi. Coba lagi nanti, atau buka Aset SQ langsung."}
        </p>
        <div className="mt-4">{openButton}</div>
      </div>
    );
  }

  return (
    <>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
        <div>
          <p className="text-lg font-bold text-brand-heading">
            {holdings.counts.outstanding
              ? `Anda memegang ${holdings.counts.outstanding} aset`
              : "Tidak ada aset yang sedang Anda pegang"}
          </p>
          {holdings.counts.pendingAcceptance || holdings.counts.overdue ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {[
                holdings.counts.pendingAcceptance ? `${holdings.counts.pendingAcceptance} menunggu konfirmasi Anda` : null,
                holdings.counts.overdue ? `${holdings.counts.overdue} lewat tanggal kembali` : null,
              ].filter(Boolean).join(" · ")}
            </p>
          ) : null}
        </div>
        {openButton}
      </div>

      {holdings.truncated ? (
        <div className="mt-4 flex items-start gap-2 rounded-2xl border border-warning-line bg-warning-soft p-4 text-sm text-warning-ink">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Sebagian aset tidak ditampilkan. Buka Aset SQ untuk daftar lengkap.</span>
        </div>
      ) : null}

      {holdings.assignments.length ? (
        <ul className="mt-5 space-y-3">
          {holdings.assignments.map((item) => (
            <li
              key={item.assignmentId}
              className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold text-brand-heading">{item.assetLabel}</span>
                {item.custodyState === "PENDING_ACCEPTANCE" ? (
                  <span className="rounded-full bg-brand-primary-pale px-2 py-0.5 text-[10px] font-bold text-brand-primary-deep">
                    Menunggu konfirmasi Anda
                  </span>
                ) : (
                  <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-bold text-muted-foreground">Dipegang</span>
                )}
                {item.overdue ? (
                  <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-bold text-danger-ink">
                    Lewat tanggal kembali
                  </span>
                ) : null}
              </div>
              <p className="mt-1 font-mono text-xs text-muted-foreground">{item.assetTag}</p>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-[11px] font-semibold text-muted-foreground">Diserahkan</dt>
                  <dd className="font-semibold text-brand-heading">{formatAssetDate(item.checkoutAt)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold text-muted-foreground">Harus kembali</dt>
                  <dd className="font-semibold text-brand-heading">{formatAssetDate(item.expectedReturnOn)}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-6 rounded-3xl border border-border/75 bg-surface-raised p-10 text-center shadow-[var(--shadow-soft)]">
          <Laptop className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="mt-3 font-bold text-brand-heading">Tidak ada aset organisasi yang sedang Anda pegang.</p>
        </div>
      )}
    </>
  );
}
