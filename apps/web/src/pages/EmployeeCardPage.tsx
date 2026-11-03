// EMP-012 employee surface: the digital card, a large QR, and reporting a lost card.
// Spec: docs/domain/employee-id-card.md §10.

import { AlertTriangle, CheckCircle2, Loader2, QrCode, RotateCw, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { CardQr, EmployeeIdCardBack, EmployeeIdCardFront } from "@/components/employee-card/EmployeeIdCard";
import { AppShell } from "@/layouts/AppShell";
import {
  formatCode,
  formatDate,
  getMyEmployeeCard,
  invalidReasonLabel,
  myCardPhotoUrl,
  myCardSignatureUrl,
  reportMyCardLost,
  verifyUrl,
  type MyEmployeeCard,
} from "@/lib/employeeCards";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";

/** The card fills a phone screen: 54 mm at 6 px/mm is 324 px wide. */
const SCREEN_SCALE = 6;

export function EmployeeCardPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [data, setData] = useState<MyEmployeeCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [side, setSide] = useState<"front" | "back">("front");
  const [qrOpen, setQrOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  const user = useMemo(() => employeeShellUser(employee), [employee]);

  useEffect(() => {
    void getEmployeeLeaveSummary().then((summary) => setEmployee(summary.employee)).catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    getMyEmployeeCard()
      .then((result) => { if (active) { setData(result); setError(null); } })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Kartu tidak dapat dimuat."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt]);

  const card = data?.card ?? null;
  const valid = card !== null && !card.invalidReason;

  async function reportLost() {
    setReporting(true);
    setReportError(null);
    try {
      await reportMyCardLost();
      setConfirming(false);
      setAttempt((value) => value + 1);
    } catch (cause) {
      setReportError(cause instanceof Error ? cause.message : "Laporan tidak dapat dikirim.");
    } finally {
      setReporting(false);
    }
  }

  return (
    <AppShell user={user} activeItem="Kartu Pegawai">
      <section className="mx-auto max-w-md">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Saya</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading">Kartu Pegawai</h1>

        {loading && !data ? (
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat kartu…
          </div>
        ) : error ? (
          <div className="mt-6 rounded-3xl border border-border/75 bg-surface-raised p-5" role="alert">
            <p className="text-sm text-brand-heading">{error}</p>
            <button type="button" onClick={() => setAttempt((value) => value + 1)}
              className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-4 text-sm font-bold text-brand-primary-deep">
              <RotateCw className="h-4 w-4" aria-hidden="true" /> Coba lagi
            </button>
          </div>
        ) : !card ? (
          <div className="mt-6 rounded-3xl border border-border/75 bg-surface-raised p-5">
            <p className="text-sm font-bold text-brand-heading">Anda belum punya kartu pegawai di HCIS.</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Kartu diterbitkan dan dicetak oleh Human Capital. Hubungi HC bila Anda membutuhkannya.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-5 flex justify-center">
              {side === "front"
                ? <EmployeeIdCardFront card={card} photoUrl={myCardPhotoUrl} scale={SCREEN_SCALE} className="shadow-[var(--shadow-soft)]" />
                : <EmployeeIdCardBack card={card} signatureUrl={data?.hasSignature ? myCardSignatureUrl : null} scale={SCREEN_SCALE} className="shadow-[var(--shadow-soft)]" />}
            </div>

            <div className={valid
              ? "mt-4 flex items-start gap-2.5 rounded-2xl bg-emerald-50 px-3 py-2.5 text-emerald-900"
              : "mt-4 flex items-start gap-2.5 rounded-2xl bg-orange-50 px-3 py-2.5 text-orange-900"}>
              {valid
                ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                : <XCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />}
              <p className="text-sm font-semibold">
                {valid ? "Aktif" : `Tidak berlaku: ${invalidReasonLabel[card.invalidReason!]}`}
                <span className="block text-xs font-normal">
                  No. {card.cardNumber} · cetakan ke-{card.edition} · berlaku s.d. {formatDate(card.validUntil)}
                </span>
              </p>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <button type="button" onClick={() => setSide(side === "front" ? "back" : "front")}
                className="min-h-11 rounded-xl border border-border bg-surface-raised text-sm font-bold text-brand-primary-deep">
                {side === "front" ? "Lihat belakang" : "Lihat depan"}
              </button>
              <button type="button" onClick={() => setQrOpen(true)} disabled={!valid}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand-primary text-sm font-bold text-brand-foreground disabled:opacity-50">
                <QrCode className="h-4 w-4" aria-hidden="true" /> Perbesar QR
              </button>
            </div>

            {card.status === "ACTIVE" ? (
              confirming ? (
                <div className="mt-4 rounded-2xl border border-orange-200 bg-orange-50 p-4" role="alertdialog" aria-labelledby="lost-title">
                  <p id="lost-title" className="flex items-center gap-2 text-sm font-bold text-orange-900">
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Laporkan kartu hilang?
                  </p>
                  <p className="mt-1 text-sm leading-6 text-orange-900">
                    Kartu ini langsung tidak berlaku saat dipindai dan tidak dapat diaktifkan lagi. Human Capital akan menerbitkan kartu pengganti.
                  </p>
                  {reportError ? <p className="mt-2 text-sm font-semibold text-red-700" role="alert">{reportError}</p> : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => void reportLost()} disabled={reporting}
                      className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-orange-700 px-4 text-sm font-bold text-white disabled:opacity-60">
                      {reporting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} Ya, laporkan hilang
                    </button>
                    <button type="button" onClick={() => setConfirming(false)}
                      className="min-h-11 rounded-xl border border-border bg-surface-raised px-4 text-sm font-bold text-brand-heading">Batal</button>
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirming(true)}
                  className="mt-4 min-h-11 w-full text-center text-sm font-semibold text-brand-primary-deep underline-offset-2 hover:underline">
                  Kartu hilang? Laporkan agar tidak berlaku
                </button>
              )
            ) : (
              <p className="mt-4 text-sm leading-6 text-muted-foreground">
                Hubungi Human Capital untuk menerbitkan kartu pengganti.
              </p>
            )}
          </>
        )}
      </section>

      {qrOpen && card ? (
        <div role="dialog" aria-modal="true" aria-label="QR kartu pegawai"
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-white p-6">
          <button type="button" onClick={() => setQrOpen(false)} aria-label="Tutup"
            className="absolute right-4 top-4 inline-flex h-11 w-11 items-center justify-center rounded-full border border-border">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
          <CardQr value={verifyUrl(card.verifyCode)} size="min(80vw, 60vh)" />
          <p className="text-center text-base font-bold text-brand-heading">{card.fullName}</p>
          <p className="text-center text-sm text-muted-foreground">Kode {formatCode(card.verifyCode)}</p>
        </div>
      ) : null}
    </AppShell>
  );
}
