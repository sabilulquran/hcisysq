// EMP-012 D-12: print sheet, one 54 × 85.6 mm page per side, front then back of each card,
// for a duplex card printer or "Save as PDF". Pressing Cetak records the batch first.

import { Loader2, Printer } from "lucide-react";
import { useEffect, useState } from "react";

import { CARD_HEIGHT_MM, CARD_WIDTH_MM, EmployeeIdCardBack, EmployeeIdCardFront } from "@/components/employee-card/EmployeeIdCard";
import { adminSignatureUrl, cardPhotoUrl, getPrintBatch, recordPrinted, type PrintBatch } from "@/lib/employeeCards";

const PRINT_CSS = `
@page { size: ${CARD_WIDTH_MM}mm ${CARD_HEIGHT_MM}mm; margin: 0; }
.card-sheet { display: flex; flex-wrap: wrap; gap: 6mm; padding: 6mm; background: #E9EEEE; }
.card-page { box-shadow: 0 1mm 3mm rgba(0,0,0,.15); }
@media print {
  html, body { margin: 0; padding: 0; background: #FFFFFF; }
  .card-screen-only { display: none !important; }
  .card-sheet { display: block; padding: 0; gap: 0; background: none; }
  .card-page { box-shadow: none; break-after: page; page-break-after: always; }
  .card-page:last-child { break-after: auto; page-break-after: auto; }
}
`;

function cardIdsFromLocation(): string[] {
  return (new URLSearchParams(window.location.search).get("cardIds") ?? "").split(",").filter(Boolean);
}

export function AdminEmployeeCardPrintPage() {
  const [batch, setBatch] = useState<PrintBatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    document.title = "Cetak Kartu Pegawai";
    const ids = cardIdsFromLocation();
    getPrintBatch(ids).then(setBatch).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Kartu tidak dapat dimuat."));
  }, []);

  async function print() {
    if (!batch?.items.length) return;
    setPrinting(true);
    setError(null);
    try {
      // Every photo must be decoded, or the printer gets an empty frame.
      await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
      await recordPrinted(batch.items.map((card) => card.id));
      window.print();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pencetakan tidak dapat dicatat.");
    } finally {
      setPrinting(false);
    }
  }

  const signature = batch?.hasSignature ? adminSignatureUrl() : null;

  return (
    <main>
      <style>{PRINT_CSS}</style>
      <div className="card-screen-only flex flex-wrap items-center gap-3 border-b border-border bg-surface-raised p-4">
        <p className="text-sm font-bold text-brand-heading">
          {batch ? `${batch.items.length} kartu · ${batch.items.length * 2} halaman ${CARD_WIDTH_MM} × ${CARD_HEIGHT_MM} mm` : "Memuat kartu…"}
        </p>
        <button type="button" onClick={() => void print()} disabled={!batch?.items.length || printing}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
          {printing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Printer className="h-4 w-4" aria-hidden="true" />} Cetak
        </button>
        <p className="w-full text-xs leading-5 text-muted-foreground">
          Atur printer ke ukuran kartu CR80 dua sisi tanpa margin dan skala 100%, atau pilih “Simpan sebagai PDF”. Setiap tekan Cetak tercatat di riwayat kartu.
        </p>
        {batch?.unavailableCardIds.length ? (
          <p className="w-full text-sm font-semibold text-orange-800" role="alert">
            {batch.unavailableCardIds.length} kartu tidak ikut dicetak karena sudah tidak aktif.
          </p>
        ) : null}
        {error ? <p className="w-full text-sm font-semibold text-red-800" role="alert">{error}</p> : null}
      </div>
      <div className="card-sheet">
        {batch?.items.flatMap((card) => [
          <EmployeeIdCardFront key={`${card.id}-front`} card={card} photoUrl={cardPhotoUrl(card.id)} className="card-page" />,
          <EmployeeIdCardBack key={`${card.id}-back`} card={card} signatureUrl={signature} className="card-page" />,
        ])}
      </div>
    </main>
  );
}
