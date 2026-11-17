// DOC-001 D-20: the printable surat keterangan, drawn from the snapshot frozen at issuing time
// (§4.1) and the printed signer block (D-05). Wording follows hr-documents.md §13 and, for the
// income letter, §14; this component decides nothing about who may see the letter — the API
// already did — and calculates nothing: every figure is printed as the snapshot holds it.

import { createPortal } from "react-dom";

import {
  formatRupiahAmount,
  hasEmployerBorneIncome,
  incomeFigures,
  type IssuedDocumentSummary,
} from "@/lib/hrDocuments";

/**
 * DOC-001 D-27 (DRAFT, owner decision 2026-11-17): the letter states the gross the employee was
 * shown on their slip, and names the BPJS Kesehatan contribution the yayasan pays on their behalf
 * on a line of its own, so the letter reconciles with the 1721-A1 without inflating the headline
 * gross a bank reads.
 */
/**
 * The column holds the BPJS Kesehatan contribution alone, not everything the slip's block
 * "Ditanggung yayasan" lists (PPh21 the yayasan bears stays out, D-27), so it is named for what it
 * holds rather than after the block.
 */
export const incomeEmployerColumnTitle = "Iuran BPJS Kesehatan ditanggung yayasan";
export const incomeEmployerBorneNote =
  "Kolom “Iuran BPJS Kesehatan ditanggung yayasan” adalah iuran yang dibayarkan yayasan atas nama pegawai. Iuran tersebut dibayarkan langsung oleh yayasan, tidak diterima pegawai sebagai uang tunai, dan tidak termasuk dalam penghasilan bruto maupun penghasilan neto di atas.";

/** Letter dates are on the Jakarta calendar, like the number (§9). */
function letterDate(value: string, dateOnly = false) {
  const instant = dateOnly ? new Date(`${value}T00:00:00+07:00`) : new Date(value);
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta" }).format(instant);
}

/** `YYYY-MM` -> "Agustus 2026". */
function monthLabel(period: string) {
  return new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric", timeZone: "Asia/Jakarta" })
    .format(new Date(`${period}-01T00:00:00+07:00`));
}

/** Months from `from` to `to` inclusive, both `YYYY-MM`: how many the snapshot's window spans. */
function monthsBetween(from: string, to: string) {
  const index = (period: string) => Number(period.slice(0, 4)) * 12 + Number(period.slice(5, 7));
  return index(to) - index(from) + 1;
}

/**
 * D-27: the sentence a window that mixes the two slip layouts must carry. It names the months whose
 * gross still holds the contribution and, where that slip stated the amount, the amount itself, so
 * a bank can reconcile the two bases instead of reading the step as a change of pay. Printed with
 * the table, not at the foot of the letter.
 */
export function incomeMixedLayoutNote(
  legacyMonths: ReadonlyArray<{ period: string; employerBorneInGross?: string | null }>,
): string {
  const parts = legacyMonths.map((month) =>
    month.employerBorneInGross
      ? `${monthLabel(month.period)} (${formatRupiahAmount(month.employerBorneInGross)})`
      : monthLabel(month.period),
  );
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} dan ${parts[parts.length - 1]}` : parts[0] ?? "";
  const amounts = legacyMonths.some((month) => month.employerBorneInGross)
    ? "Nominal dalam kurung adalah iuran yang termasuk di dalam penghasilan bruto bulan itu menurut slip. "
    : "";
  return `Pada slip periode ${list} iuran tersebut masih tercantum di dalam penghasilan bruto, sehingga kolom “${incomeEmployerColumnTitle}” bulan tersebut dikosongkan dan rata-rata iuran per bulan tidak dicantumkan. ${amounts}Penghasilan bruto bulan tersebut karena itu tidak disusun dengan cara yang sama dengan bulan lainnya, dan selisihnya bukan perubahan gaji.`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

// Employees reach their own letters only while active, so a paklaring (issued after the
// employment ended, D-06) is rendered here for completeness rather than for the self screen.
export function CertificateLetterPaper({ document }: { document: IssuedDocumentSummary }) {
  const content = document.contentSnapshot;
  const startedOn = text(content.startedOn);
  const endedOn = text(content.endedOn);
  const purpose = text(content.purpose);
  const title = (text(content.documentLabel) ?? "Surat Keterangan").toUpperCase();
  const rows: Array<[string, string | null]> = [
    ["Nama", text(content.fullName)],
    ["NIP", text(content.employeeNumber)],
    ["Jabatan", text(content.positionTitle)],
    ["Unit", text(content.unitName)],
    ["Mulai bekerja", startedOn ? letterDate(startedOn, true) : null],
  ];
  const income = incomeFigures(document);
  // D-27: the column only appears when a slip in the window actually states an employer-borne
  // figure, so letters issued under the earlier slip layout read exactly as they did.
  const showEmployerBorne = income ? hasEmployerBorneIncome(income) : false;
  // Only when the column is there: a window whose block months state nothing employer-borne has
  // one definition of gross after all, so there is nothing to warn a bank about.
  const legacyMonths = income && income.mixedLayout && showEmployerBorne
    ? income.months.filter((month) => month.layout !== "EMPLOYER_BLOCK")
    : [];
  const statement = document.documentCode === "PAKLARING"
    ? `telah bekerja di Yayasan Sabilul Qur'an sejak ${startedOn ? letterDate(startedOn, true) : "-"} sampai dengan ${endedOn ? letterDate(endedOn, true) : "-"}.`
    : income
      ? "adalah benar pegawai Yayasan Sabilul Qur'an yang masih aktif bekerja sampai dengan tanggal surat ini, dengan penghasilan menurut slip gaji resmi yang telah diterbitkan sebagai berikut:"
      : "adalah benar pegawai Yayasan Sabilul Qur'an yang masih aktif bekerja sampai dengan tanggal surat ini.";
  return (
    <article className="certificate-letter-paper sq-paper rounded-2xl border border-border bg-white p-6 text-sm leading-6 text-slate-900">
      <p className="text-center text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">Yayasan Sabilul Qur&apos;an</p>
      <h3 className="mt-2 text-center text-lg font-bold">{title}</h3>
      <p className="text-center text-xs">Nomor: {document.documentNumber}</p>
      <p className="mt-5">Yang bertanda tangan di bawah ini menerangkan bahwa:</p>
      <dl className="mt-3 grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-slate-600">{label}</dt>
            <dd className="font-medium">{value ?? "-"}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4">{statement}</p>
      {income ? (
        <>
          <table className="mt-3 w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-400">
                <th className="py-1 pr-2 font-semibold">Bulan</th>
                <th className="py-1 pr-2 text-right font-semibold">Penghasilan bruto</th>
                <th className={`py-1 text-right font-semibold${showEmployerBorne ? " pr-2" : ""}`}>Penghasilan neto</th>
                {showEmployerBorne ? <th className="py-1 text-right font-semibold">{incomeEmployerColumnTitle}</th> : null}
              </tr>
            </thead>
            <tbody>
              {income.months.map((month) => (
                <tr key={month.period} className="border-b border-slate-200">
                  <td className="py-1 pr-2">{monthLabel(month.period)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{formatRupiahAmount(month.gross)}</td>
                  <td className={`py-1 text-right tabular-nums${showEmployerBorne ? " pr-2" : ""}`}>{formatRupiahAmount(month.net)}</td>
                  {showEmployerBorne ? (
                    <td className="py-1 text-right tabular-nums">
                      {month.layout === "EMPLOYER_BLOCK" ? formatRupiahAmount(month.employerBorne ?? "0") : "—"}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className="py-1 pr-2">Rata-rata per bulan</td>
                <td className="py-1 pr-2 text-right tabular-nums">{formatRupiahAmount(income.averageGross)}</td>
                <td className={`py-1 text-right tabular-nums${showEmployerBorne ? " pr-2" : ""}`}>{formatRupiahAmount(income.averageNet)}</td>
                {showEmployerBorne ? (
                  // D-27 / §7.6.6 S8: on a mixed window the average would add months that state the
                  // contribution to months that do not, although the yayasan paid it in both.
                  <td className="py-1 text-right tabular-nums">
                    {legacyMonths.length > 0 ? "—" : formatRupiahAmount(income.averageEmployerBorne ?? "0")}
                  </td>
                ) : null}
              </tr>
            </tfoot>
          </table>
          {legacyMonths.length > 0 ? <p className="mt-2 text-xs">{incomeMixedLayoutNote(legacyMonths)}</p> : null}
          <p className="mt-2 text-xs">
            Angka diambil dari slip gaji resmi periode {monthLabel(income.windowFrom)} sampai dengan {monthLabel(income.windowTo)}
            {income.monthCount < monthsBetween(income.windowFrom, income.windowTo)
              ? `; rata-rata dihitung dari ${income.monthCount} bulan yang memiliki slip gaji resmi.`
              : "."}
          </p>
          {showEmployerBorne ? <p className="mt-2 text-xs">{incomeEmployerBorneNote}</p> : null}
        </>
      ) : null}
      {purpose ? <p className="mt-2">Surat keterangan ini dibuat untuk keperluan: {purpose}.</p> : null}
      <p className="mt-2">Demikian surat keterangan ini dibuat untuk dipergunakan sebagaimana mestinya.</p>
      <div className="mt-8 ml-auto w-56 text-center">
        <p>{letterDate(document.issuedAt)}</p>
        <p className="mt-1">{document.signer.title}</p>
        <p className="mt-14 font-bold underline">{document.signer.name ?? "-"}</p>
      </div>
    </article>
  );
}

const printStyle = `
  .certificate-print-root { display: none; }
  @media print {
    @page { size: A4 portrait; margin: 18mm; }
    body > *:not(.certificate-print-root) { display: none !important; }
    .certificate-print-root { display: block !important; }
    .certificate-print-root .certificate-letter-paper { border: 0 !important; border-radius: 0 !important; padding: 0 !important; }
  }
`;

/**
 * Print only the letter, on A4: a copy is mounted directly under <body> and everything else is
 * taken out of the printed layout, so no blank pages or offsets come from the screen around it.
 */
export function CertificatePrintCopy({ document }: { document: IssuedDocumentSummary }) {
  if (typeof window === "undefined") return null;
  return createPortal(
    <div className="certificate-print-root">
      <style>{printStyle}</style>
      <CertificateLetterPaper document={document} />
    </div>,
    window.document.body,
  );
}
