// EMP-012 D-11: the page a printed card's QR opens. No login. A valid card shows who holds it;
// a card that no longer verifies shows only its number, the reason and how to return it.

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import ysqMark from "@/assets/brand/ysq-mark.png";
import {
  checkEmployeeCard,
  EmployeeCardApiError,
  formatDate,
  formatInstant,
  formatInstantDate,
  invalidReasonLabel,
  publicCardPhotoUrl,
  type PublicCardCheck,
} from "@/lib/employeeCards";

const FOUNDATION_WHATSAPP = "https://wa.me/6285175201627";

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-bold text-brand-heading">{value}</dd>
    </div>
  );
}

export function PublicCardCheckPage({ code }: { code: string }) {
  const [result, setResult] = useState<PublicCardCheck | null>(null);
  const [error, setError] = useState<{ notFound: boolean; message: string } | null>(null);
  const [photoFailed, setPhotoFailed] = useState(false);

  useEffect(() => {
    document.title = "Cek Keaslian Kartu · Sabilul Qur'an";
    checkEmployeeCard(code)
      .then(setResult)
      .catch((cause: unknown) => setError({
        notFound: cause instanceof EmployeeCardApiError && cause.status === 404,
        message: cause instanceof Error ? cause.message : "Pemeriksaan gagal.",
      }));
  }, [code]);

  return (
    <main className="min-h-screen bg-surface">
      <header className="flex items-center gap-3 border-b border-border bg-surface-raised px-5 py-4">
        <img src={ysqMark} alt="" className="h-9 w-9" aria-hidden="true" />
        <div>
          <h1 className="text-base font-extrabold text-brand-heading">Cek Keaslian Kartu</h1>
          <p className="text-xs text-muted-foreground">Yayasan Sabilul Qur'an</p>
        </div>
      </header>
      <section className="mx-auto grid max-w-md gap-4 p-5">
        {!result && !error ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memeriksa kartu…
          </p>
        ) : null}

        {error ? (
          <div className="flex items-start gap-3 rounded-2xl bg-orange-50 p-4 text-orange-900" role="alert">
            <XCircle className="mt-0.5 h-7 w-7 shrink-0" aria-hidden="true" />
            <div>
              <p className="text-lg font-extrabold">{error.notFound ? "Kartu tidak dikenal" : "Pemeriksaan gagal"}</p>
              <p className="text-sm">{error.notFound ? "Kode ini tidak terdaftar di HCIS Sabilul Qur'an." : error.message}</p>
            </div>
          </div>
        ) : null}

        {result?.valid ? (
          <>
            <div className="flex items-center gap-3 rounded-2xl bg-emerald-50 p-4 text-emerald-900">
              <CheckCircle2 className="h-8 w-8 shrink-0" aria-hidden="true" />
              <div>
                <p className="text-lg font-extrabold">Kartu sah</p>
                <p className="text-sm font-semibold">Pemegang adalah pegawai aktif</p>
              </div>
            </div>
            <div className="flex gap-4 rounded-2xl border border-border bg-surface-raised p-4">
              <div className="h-24 w-[4.5rem] shrink-0 overflow-hidden rounded-lg bg-surface">
                {photoFailed ? null : (
                  <img src={publicCardPhotoUrl(code)} alt={`Foto ${result.fullName}`} onError={() => setPhotoFailed(true)}
                    className="h-full w-full object-cover" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-base font-extrabold text-brand-heading">{result.fullName}</p>
                {result.positionTitle ? <p className="text-sm font-semibold text-brand-primary-deep">{result.positionTitle}</p> : null}
                {result.unitName ? <p className="text-sm text-muted-foreground">{result.unitName}</p> : null}
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-3 px-1">
              <Detail label="No. kartu" value={`${result.cardNumber} · ke-${result.edition}`} />
              <Detail label="Berlaku s.d." value={formatDate(result.validUntil)} />
              <Detail label="Diperiksa" value={formatInstant(result.checkedAt)} />
            </dl>
          </>
        ) : null}

        {result && !result.valid ? (
          <>
            <div className="flex items-center gap-3 rounded-2xl bg-orange-50 p-4 text-orange-900">
              <XCircle className="h-8 w-8 shrink-0" aria-hidden="true" />
              <div>
                <p className="text-lg font-extrabold">Kartu tidak berlaku</p>
                <p className="text-sm font-semibold">{invalidReasonLabel[result.reason]}</p>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-3 px-1">
              <Detail label="No. kartu" value={`${result.cardNumber} · ke-${result.edition}`} />
              {result.invalidSince ? <Detail label="Tidak berlaku sejak" value={formatInstantDate(result.invalidSince)} /> : null}
              <Detail label="Diperiksa" value={formatInstant(result.checkedAt)} />
            </dl>
            <p className="text-sm leading-6 text-brand-heading">
              Nama dan foto tidak ditampilkan untuk kartu yang tidak berlaku. Jika Anda menemukan kartu ini, mohon kembalikan ke Sabilul Qur'an.
            </p>
            <a href={FOUNDATION_WHATSAPP} target="_blank" rel="noreferrer"
              className="inline-flex min-h-11 items-center justify-center rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground">
              Hubungi Sabilul Qur'an
            </a>
          </>
        ) : null}

        <p className="text-xs leading-5 text-muted-foreground">
          Status dibaca langsung dari HCIS saat halaman dibuka. Halaman ini tidak menampilkan NIK, NIP, alamat, tanggal lahir, atau nomor kontak pegawai.
        </p>
      </section>
    </main>
  );
}
