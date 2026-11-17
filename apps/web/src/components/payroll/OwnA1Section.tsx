// PAY-003 §7.4: the employee's own bukti potong 1721-A1 on the payslip screen. The list carries
// no figures; opening one is recorded by the API. Hidden entirely when there is none yet.

import { FileText, Printer } from "lucide-react";
import { useEffect, useState } from "react";

import { DetailDialog } from "@/components/DetailDialog";
import { Pph21A1Paper, Pph21A1PrintCopy } from "@/components/payroll/Pph21A1Paper";
import { PayrollApiError } from "@/lib/payroll";
import { getOwnA1, listOwnA1, type Pph21A1Document } from "@/lib/payrollPph21Annual";

type Item = { year: number; index: number; startPeriod: string; endPeriod: string };

export function OwnA1Section() {
  const [items, setItems] = useState<Item[]>([]);
  const [opened, setOpened] = useState<Pph21A1Document | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // A failure here only means there is nothing to show; the payslips above are unaffected.
    void listOwnA1()
      .then((data) => {
        if (active) setItems(data.items);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  async function open(item: Item) {
    setError(null);
    try {
      setOpened((await getOwnA1(item.year, item.index)).a1);
    } catch (cause) {
      setError(cause instanceof PayrollApiError ? cause.message : "Bukti potong gagal dibuka.");
    }
  }

  if (items.length === 0) return null;
  return (
    <section className="print:hidden mt-6 rounded-2xl border border-border bg-surface-raised p-4">
      <h2 className="text-sm font-bold">Bukti potong PPh21 (1721-A1)</h2>
      <p className="mt-1 text-xs text-muted-foreground">Untuk pelaporan SPT Tahunan. Cetak atau simpan sebagai PDF.</p>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li key={`${item.year}-${item.index}`} className="flex items-center justify-between gap-3 text-sm">
            <span>
              Tahun {item.year} · {item.startPeriod} s.d. {item.endPeriod}
            </span>
            <button type="button" onClick={() => void open(item)} className="inline-flex items-center gap-1 font-medium text-primary underline">
              <FileText className="h-4 w-4" aria-hidden /> Lihat & cetak
            </button>
          </li>
        ))}
      </ul>
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      {opened ? (
        <DetailDialog title="Bukti potong 1721-A1" description={`Tahun ${opened.year}`} onClose={() => setOpened(null)} wide>
          <Pph21A1PrintCopy a1={opened} />
          <div className="mb-3 flex justify-end">
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
            >
              <Printer className="h-4 w-4" aria-hidden /> Cetak / Simpan PDF
            </button>
          </div>
          <Pph21A1Paper a1={opened} />
        </DetailDialog>
      ) : null}
    </section>
  );
}
