// DOC-001 D-20: the printable surat keterangan, drawn from the snapshot frozen at issuing time
// (§4.1) and the printed signer block (D-05). Wording follows hr-documents.md §13; this
// component decides nothing about who may see the letter — the API already did.

import type { IssuedDocumentSummary } from "@/lib/hrDocuments";

/** Letter dates are on the Jakarta calendar, like the number (§9). */
function letterDate(value: string, dateOnly = false) {
  const instant = dateOnly ? new Date(`${value}T00:00:00+07:00`) : new Date(value);
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta" }).format(instant);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

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
  const statement = document.documentCode === "PAKLARING"
    ? `telah bekerja di Yayasan Sabilul Qur'an sejak ${startedOn ? letterDate(startedOn, true) : "-"} sampai dengan ${endedOn ? letterDate(endedOn, true) : "-"}.`
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

/** Print only the letter, on A4, whatever the rest of the page shows. */
export const certificatePrintStyle = `
  @media print {
    @page { size: A4 portrait; margin: 18mm; }
    body * { visibility: hidden !important; }
    .certificate-letter-paper, .certificate-letter-paper * { visibility: visible !important; }
    .certificate-letter-paper { position: absolute !important; inset: 0 auto auto 0 !important; width: 100% !important; border: 0 !important; }
  }
`;
