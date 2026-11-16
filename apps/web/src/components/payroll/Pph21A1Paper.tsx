// PAY-003 §7.4: the printable bukti potong 1721-A1. Every figure is the server's; this
// component lays them out in the order of the form (PER-2/PJ/2024) and decides nothing.
// "Unduh" is Simpan sebagai PDF from the browser's print dialog, like DOC-001 D-20.

import { createPortal } from "react-dom";

import { A1_LINE_LABELS, rupiah, type Pph21A1Document } from "@/lib/payrollPph21Annual";

function monthYear(period: string): string {
  return new Date(`${period}-01T00:00:00Z`).toLocaleDateString("id-ID", { month: "long", year: "numeric", timeZone: "UTC" });
}

function longDate(value: string): string {
  return new Date(`${value}T00:00:00+07:00`).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  });
}

function Row({ no, label, value, strong }: { no: string; label: string; value: string; strong?: boolean }) {
  return (
    <tr className={strong ? "font-semibold" : undefined}>
      <td className="w-8 py-0.5 align-top text-slate-600">{no}</td>
      <td className="py-0.5 pr-3">{label}</td>
      <td className="py-0.5 text-right tabular-nums">{value}</td>
    </tr>
  );
}

export function Pph21A1Paper({ a1 }: { a1: Pph21A1Document }) {
  const s = a1.segment;
  const gross = A1_LINE_LABELS.map(([key, label], i) => ({ no: String(i + 1), label, value: rupiah(s.lines[key]) }));
  const finalLabel = s.finalMasaTax !== null && Number(s.finalMasaTax) < 0
    ? "PPh Pasal 21 lebih dipotong pada masa pajak terakhir"
    : "PPh Pasal 21 kurang dipotong pada masa pajak terakhir";
  return (
    <article className="pph21-a1-paper sq-paper rounded-2xl border border-border bg-white p-6 text-xs leading-5 text-slate-900">
      <header className="text-center">
        <p className="font-semibold uppercase tracking-[0.12em]">Bukti Pemotongan PPh Pasal 21</p>
        <p className="font-semibold uppercase">Bagi Pegawai Tetap atau Pensiunan yang Menerima Uang Terkait Pensiun Secara Berkala</p>
        <p className="mt-1">Formulir 1721-A1 · Tahun pajak {a1.year} · Kode objek {a1.objectCode}</p>
        <p>Masa perolehan penghasilan: {monthYear(s.startPeriod)} s.d. {monthYear(s.endPeriod)}</p>
        <p className="text-slate-600">Referensi HCIS: {a1.reference} (nomor bukti potong mengikuti e-Bupot)</p>
      </header>

      <section className="mt-4">
        <h4 className="font-semibold">A. Identitas penerima penghasilan</h4>
        <dl className="mt-1 grid grid-cols-[9rem_1fr] gap-x-3">
          <dt className="text-slate-600">NPWP</dt>
          <dd>{a1.employee.npwp ?? "-"}</dd>
          <dt className="text-slate-600">NIK</dt>
          <dd>{a1.employee.nik ?? (a1.employee.unreadable?.includes("nik") ? "tidak dapat dibuka — hubungi HC" : "belum tercatat di HCIS")}</dd>
          <dt className="text-slate-600">Nama</dt>
          <dd className="font-medium">{a1.employee.fullName}</dd>
          <dt className="text-slate-600">NIP</dt>
          <dd>{a1.employee.employeeNumber}</dd>
          <dt className="text-slate-600">Jabatan</dt>
          <dd>{a1.employee.position ?? "-"}</dd>
          <dt className="text-slate-600">Status PTKP</dt>
          <dd>{s.ptkpStatus ?? "-"}</dd>
        </dl>
      </section>

      <section className="mt-4">
        <h4 className="font-semibold">B. Rincian penghasilan dan penghitungan PPh Pasal 21 (rupiah)</h4>
        <table className="mt-1 w-full">
          <tbody>
            {gross.map((line) => (
              <Row key={line.no} {...line} />
            ))}
            <Row no="8" label="Jumlah penghasilan bruto (1 s.d. 7)" value={rupiah(s.gross)} strong />
            <Row no="9" label="Biaya jabatan" value={rupiah(s.positionCost)} />
            <Row no="10" label="Iuran terkait pensiun atau hari tua" value={rupiah(s.pensionContribution)} />
            <Row no="11" label="Jumlah pengurangan (9 + 10)" value={rupiah(s.deductions)} strong />
            <Row no="12" label="Jumlah penghasilan neto (8 − 11)" value={rupiah(s.net)} />
            <Row no="13" label="Penghasilan neto masa pajak sebelumnya" value="0" />
            <Row no="14" label="Jumlah penghasilan neto untuk penghitungan PPh Pasal 21" value={rupiah(s.net)} />
            <Row no="15" label="Penghasilan tidak kena pajak (PTKP)" value={rupiah(s.ptkp)} />
            <Row no="16" label="Penghasilan kena pajak setahun (14 − 15)" value={rupiah(s.pkp)} />
            <Row no="17" label="PPh Pasal 21 atas penghasilan kena pajak setahun" value={rupiah(s.annualTax)} strong />
            <Row no="18" label="PPh Pasal 21 yang telah dipotong masa pajak sebelumnya" value={rupiah(s.terWithheld)} />
            <Row no="19" label={finalLabel} value={rupiah(s.finalMasaTax)} strong />
          </tbody>
        </table>
        {s.note ? <p className="mt-2 text-slate-600">Catatan: {s.note}.</p> : null}
      </section>

      <section className="mt-4">
        <h4 className="font-semibold">C. Identitas pemotong</h4>
        <dl className="mt-1 grid grid-cols-[9rem_1fr] gap-x-3">
          <dt className="text-slate-600">Nama</dt>
          <dd>{a1.withholder.name}</dd>
          <dt className="text-slate-600">NPWP</dt>
          <dd>{a1.withholder.taxNumber ?? "-"}</dd>
        </dl>
        <div className="mt-6 ml-auto w-56 text-center">
          <p>{longDate(a1.issuedOn)}</p>
          <p className="mt-1">{a1.signer.title}</p>
          <p className="mt-12 font-bold underline">{a1.signer.name ?? "-"}</p>
        </div>
      </section>
    </article>
  );
}

const printStyle = `
  .pph21-a1-print-root { display: none; }
  @media print {
    @page { size: A4 portrait; margin: 14mm; }
    body > *:not(.pph21-a1-print-root) { display: none !important; }
    .pph21-a1-print-root { display: block !important; }
    .pph21-a1-print-root .pph21-a1-paper { border: 0 !important; border-radius: 0 !important; padding: 0 !important; }
  }
`;

/** Prints only the bukti potong, mounted directly under <body> (same approach as DOC-001 D-20). */
export function Pph21A1PrintCopy({ a1 }: { a1: Pph21A1Document }) {
  if (typeof window === "undefined") return null;
  return createPortal(
    <div className="pph21-a1-print-root">
      <style>{printStyle}</style>
      <Pph21A1Paper a1={a1} />
    </div>,
    window.document.body,
  );
}
