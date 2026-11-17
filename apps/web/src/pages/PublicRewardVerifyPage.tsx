// REWARD-001 §9: the page a certificate's check link opens. No login; name, category, month and
// whether the award still stands, nothing else.

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import ysqMark from "@/assets/brand/ysq-mark.png";
import { checkCertificate, RewardApiError, type CertificateCheck } from "@/lib/rewards";

export function CertificateCheckView({ result }: { result: CertificateCheck }) {
  const valid = result.status === "VALID";
  return (
    <div className={`rounded-3xl border p-5 ${valid ? "border-border bg-surface-raised" : "border-danger-line bg-danger-soft"}`}>
      <p className={`flex items-center gap-2 font-bold ${valid ? "text-brand-heading" : "text-danger-ink"}`}>
        {valid ? <CheckCircle2 className="h-5 w-5" aria-hidden="true" /> : <XCircle className="h-5 w-5" aria-hidden="true" />}
        {valid ? "Sertifikat sah" : "Penghargaan ini sudah dicabut"}
      </p>
      <dl className="mt-4 grid gap-3">
        <div><dt className="text-xs text-muted-foreground">Penerima</dt><dd className="text-sm font-bold text-brand-heading">{result.recipientName}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Kategori</dt><dd className="text-sm font-bold text-brand-heading">{result.categoryLabel}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Bulan</dt><dd className="text-sm font-bold text-brand-heading">{result.monthLabel}</dd></div>
      </dl>
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
          <h1 className="text-base font-extrabold text-brand-heading">Cek Sertifikat Penghargaan</h1>
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
