// REWARD-001 §9: the page a certificate's check link opens. No login; name, category, month and
// whether the award still stands, nothing else.

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import ysqMark from "@/assets/brand/ysq-mark.png";
import { checkCertificate, RewardApiError, type CertificateCheck } from "@/lib/rewards";

/**
 * Same shape as the employee-card check (EMP-012 D-11): the answer leads, in the HCIS status
 * colours, and the certificate's facts sit under it. A certificate that still stands used to
 * look like an ordinary card while only a revoked one was coloured, so the common answer — yes,
 * this is real — carried no confirmation at all.
 */
export function CertificateCheckView({ result }: { result: CertificateCheck }) {
  const valid = result.status === "VALID";
  const skin = valid
    ? "border-success-line bg-success-soft text-success-ink"
    : "border-danger-line bg-danger-soft text-danger-ink";
  return (
    <div className="grid gap-4">
      <div className={`flex items-start gap-3 rounded-2xl border p-4 ${skin}`} role={valid ? undefined : "alert"}>
        {valid
          ? <CheckCircle2 className="mt-0.5 h-7 w-7 shrink-0" aria-hidden="true" />
          : <XCircle className="mt-0.5 h-7 w-7 shrink-0" aria-hidden="true" />}
        <div>
          <p className="text-2xl font-semibold leading-tight">{valid ? "Sertifikat sah" : "Penghargaan dicabut"}</p>
          <p className="mt-1 text-sm leading-6">
            {valid ? "Penghargaan ini diterbitkan Yayasan Sabilul Qur'an." : "Penghargaan ini sudah dicabut dan tidak lagi berlaku."}
          </p>
        </div>
      </div>
      <div className="rounded-2xl border border-border bg-surface-raised p-4">
        <p className="text-xl font-semibold leading-tight text-brand-heading">{result.recipientName}</p>
        <p className="mt-1 text-sm font-medium text-brand-primary-deep">{result.categoryLabel}</p>
        <p className="text-sm text-muted-foreground">{result.monthLabel}</p>
      </div>
    </div>
  );
}

export function PublicRewardVerifyPage({ code }: { code: string }) {
  const [result, setResult] = useState<CertificateCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Cek Sertifikat Penghargaan · Sabilul Qur'an";
    checkCertificate(code)
      .then(setResult)
      .catch((cause: unknown) => setError(
        cause instanceof RewardApiError && cause.status === 404
          ? "Kode sertifikat tidak dikenal. Periksa kembali kode pada sertifikat."
          : cause instanceof Error ? cause.message : "Pemeriksaan gagal.",
      ));
  }, [code]);

  return (
    <main className="min-h-screen bg-surface">
      <header className="flex items-center gap-3 border-b border-border bg-surface-raised px-5 py-4">
        <img src={ysqMark} alt="" className="h-9 w-9" aria-hidden="true" />
        <div>
          <h1 className="text-base font-semibold text-brand-heading">Cek Sertifikat Penghargaan</h1>
          <p className="text-xs text-muted-foreground">Yayasan Sabilul Qur&apos;an</p>
        </div>
      </header>
      <section className="mx-auto grid max-w-md gap-4 p-5">
        {!result && !error ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memeriksa sertifikat…
          </p>
        ) : null}
        {error ? <p role="alert" className="rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</p> : null}
        {result ? <CertificateCheckView result={result} /> : null}
      </section>
    </main>
  );
}
