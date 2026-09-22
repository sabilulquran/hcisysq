import { FileText, Loader2, Printer, Search, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import ysqLogoHorizontal from "@/assets/brand/ysq-logo-white.png";
import { AppShell } from "@/layouts/AppShell";
import {
  getEmployeeLeaveSummary,
  type EmployeeLeaveSummary,
} from "@/lib/employeeLeave";
import { employeeShellUser } from "@/lib/employeeIdentity";
import {
  getMyPayslip,
  getMyPayslips,
  type PayslipDetail,
  type PayslipLine,
  type PayslipLineSection,
  type PayslipSourceFormat,
  type PayslipSummary,
} from "@/lib/payslips";

export const payslipConfidentialityNotes = [
  "Dokumen ini bersifat RAHASIA dan PRIBADI.",
  "Dilarang menyebarluaskan atau menunjukkan isi dokumen ini kepada pihak yang tidak berwenang.",
  "Segala risiko finansial atau hukum akibat penyalahgunaan dokumen menjadi tanggung jawab pribadi pegawai.",
] as const;

export function formatPayslipPeriod(value: string) {
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return value;
  return new Intl.DateTimeFormat("id-ID", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export function payslipSourceLabel(value: PayslipSourceFormat) {
  if (value === "tetap") return "Pegawai Tetap";
  if (value === "honorer") return "Honorer";
  return "Imported";
}

export function payslipOptionLabel(item: PayslipSummary) {
  return `${formatPayslipPeriod(item.period)} · ${payslipSourceLabel(item.sourceFormat)}`;
}

export function groupPayslipLines(lines: PayslipLine[]) {
  const grouped: Record<PayslipLineSection, PayslipLine[]> = {
    identity: [],
    income: [],
    deduction: [],
    summary: [],
    other: [],
  };
  for (const line of lines) grouped[line.section ?? "other"].push(line);
  return grouped;
}

function PairLines({ lines }: { lines: PayslipLine[] }) {
  const rows: Array<[PayslipLine, PayslipLine | null]> = [];
  for (let index = 0; index < lines.length; index += 2) {
    rows.push([lines[index]!, lines[index + 1] ?? null]);
  }
  return (
    <div className="payslip-pair-table divide-y divide-border/70 border-y border-border/70">
      {rows.map(([left, right], index) => (
        <div
          key={`${left.label}-${index}`}
          className="payslip-detail-row grid gap-x-6 py-2 sm:grid-cols-2"
        >
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
            <span className="text-muted-foreground">{left.label}</span>
            <strong className="max-w-52 break-words text-right text-brand-heading">{left.value}</strong>
          </div>
          {right ? (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
              <span className="text-muted-foreground">{right.label}</span>
              <strong className="max-w-52 break-words text-right text-brand-heading">{right.value}</strong>
            </div>
          ) : <span />}
        </div>
      ))}
    </div>
  );
}

function PayslipPaper({
  payslip,
  employee,
}: {
  payslip: PayslipDetail;
  employee: EmployeeLeaveSummary["employee"] | null;
}) {
  const grouped = groupPayslipLines(payslip.lines);
  const structured = payslip.sourceFormat !== "generic";
  const detailLines = structured
    ? [...grouped.income, ...grouped.deduction]
    : payslip.lines;

  return (
    <article className="payslip-print-paper w-full overflow-hidden rounded-2xl border border-border bg-white shadow-[var(--shadow-soft)]">
      <div className="payslip-brand-header flex items-center justify-between gap-5 bg-brand-primary-deep px-6 py-4 text-white">
        <img
          src={ysqLogoHorizontal}
          alt="Yayasan Sabilul Qur'an"
          className="h-10 w-auto max-w-[13rem] object-contain"
        />
        <div className="text-right">
          <h2 className="text-xl font-extrabold tracking-[0.08em]">SLIP GAJI</h2>
          <p className="mt-0.5 text-xs text-white/80">{formatPayslipPeriod(payslip.period)}</p>
          <span className="mt-1.5 inline-flex rounded-full bg-white/15 px-2.5 py-0.5 text-[10px] font-bold">
            {payslipSourceLabel(payslip.sourceFormat)}
          </span>
        </div>
      </div>

      <div className="payslip-print-inner p-5 sm:p-6">
        <section className="payslip-section">
          <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Identitas Pegawai</h3>
          <div className="payslip-identity-grid grid gap-x-8 gap-y-2 rounded-xl bg-surface px-4 py-3 sm:grid-cols-2">
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 text-sm"><span className="text-muted-foreground">Nama</span><strong>{employee?.fullName ?? "—"}</strong></div>
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 text-sm"><span className="text-muted-foreground">NIP</span><strong>{employee?.employeeNumber ?? "—"}</strong></div>
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 text-sm"><span className="text-muted-foreground">Unit</span><strong>{employee?.unitName ?? "—"}</strong></div>
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 text-sm"><span className="text-muted-foreground">Jabatan</span><strong>{employee?.positionName ?? "—"}</strong></div>
          </div>
        </section>

        {structured && grouped.summary.length > 0 ? (
          <section className="payslip-section mt-4">
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-brand-primary-deep">Ringkasan Gaji</h3>
            <div className="payslip-summary-grid grid gap-2 sm:grid-cols-3">
              {grouped.summary.map((line) => (
                <div key={line.label} className="rounded-xl border border-brand-primary/20 bg-brand-primary-pale/25 px-3 py-2">
                  <p className="text-[10px] font-semibold text-muted-foreground">{line.label}</p>
                  <p className="mt-0.5 text-sm font-extrabold text-brand-heading">{line.value}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {detailLines.length > 0 ? (
          <section className="payslip-section mt-4">
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
              {structured ? "Rincian Penghasilan & Potongan" : "Rincian Slip"}
            </h3>
            <PairLines lines={detailLines} />
          </section>
        ) : null}

        {structured && grouped.other.length > 0 ? (
          <section className="payslip-section mt-3">
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Informasi Lain</h3>
            <PairLines lines={grouped.other} />
          </section>
        ) : null}

        <footer className="payslip-footer mt-5 grid gap-5 border-t border-border pt-4 md:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="payslip-confidentiality rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2.5">
            <div className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[0.1em] text-amber-900">
              <ShieldCheck className="h-3.5 w-3.5" /> Catatan Penting
            </div>
            <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 text-[10px] leading-4 text-amber-950">
              {payslipConfidentialityNotes.map((note) => <li key={note}>{note}</li>)}
            </ol>
          </div>

          <div className="payslip-signature text-center text-xs text-brand-heading">
            <p className="font-semibold">{payslip.signer.title},</p>
            <div className="payslip-sign-space h-12" aria-hidden="true" />
            <p className="border-t border-brand-heading/60 pt-1 font-bold">
              {payslip.signer.name ?? "Nama penandatangan belum terhubung"}
            </p>
          </div>
        </footer>

        <p className="payslip-system-note mt-2 text-[9px] leading-4 text-muted-foreground">
          Dibuat otomatis oleh HCIS Sabilul Qur&apos;an. Nilai ditampilkan dari data payroll yang dipublikasikan dan tidak dihitung ulang oleh HCIS.
        </p>
      </div>
    </article>
  );
}

export function EmployeePayslipsPage() {
  const [items, setItems] = useState<PayslipSummary[] | null>(null);
  const [selected, setSelected] = useState<PayslipDetail | null>(null);
  const [selectorValue, setSelectorValue] = useState("");
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    let mounted = true;
    void getMyPayslips()
      .then(async (result) => {
        if (!mounted) return;
        setItems(result.items);
        const latest = result.items[0];
        if (latest) {
          setSelectorValue(payslipOptionLabel(latest));
          setLoadingDetail(true);
          try {
            const detail = await getMyPayslip(latest.id);
            if (mounted) setSelected(detail);
          } catch (cause) {
            if (mounted) setError(cause instanceof Error ? cause.message : "Payslip tidak dapat dibuka.");
          } finally {
            if (mounted) setLoadingDetail(false);
          }
        }
      })
      .catch((cause: unknown) => {
        if (!mounted) return;
        setItems([]);
        setError(cause instanceof Error ? cause.message : "Payslip tidak dapat dimuat.");
      });

    void getEmployeeLeaveSummary()
      .then((summary) => {
        if (mounted) setEmployee(summary.employee);
      })
      .catch(() => {
        // Detail payslip tetap owner-scoped oleh API; identity akan menampilkan fallback kosong.
      });

    return () => {
      mounted = false;
    };
  }, []);

  const user = useMemo(() => employeeShellUser(employee), [employee]);
  const optionMap = useMemo(
    () => new Map((items ?? []).map((item) => [payslipOptionLabel(item).toLowerCase(), item])),
    [items],
  );

  const showSelectedPayslip = async () => {
    if (!items?.length) return;
    const normalized = selectorValue.trim().toLowerCase();
    let match = optionMap.get(normalized);
    if (!match) {
      const candidates = items.filter((item) =>
        payslipOptionLabel(item).toLowerCase().includes(normalized),
      );
      if (candidates.length === 1) match = candidates[0];
    }
    if (!match) {
      setError("Pilih satu periode dari daftar hasil pencarian.");
      return;
    }
    setSelectorValue(payslipOptionLabel(match));
    setLoadingDetail(true);
    setError(null);
    try {
      setSelected(await getMyPayslip(match.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Payslip tidak dapat dibuka.");
    } finally {
      setLoadingDetail(false);
    }
  };

  return (
    <AppShell user={user} activeItem="Slip Gaji">
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 5mm; }
          html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
          body * { visibility: hidden !important; }
          .payslip-print-paper, .payslip-print-paper * { visibility: visible !important; }
          .payslip-print-paper {
            position: absolute !important;
            inset: 0 auto auto 0 !important;
            width: 116% !important;
            max-width: none !important;
            border: 0 !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            zoom: .86;
            font-size: 8pt !important;
            line-height: 1.15 !important;
          }
          .payslip-brand-header {
            padding: 3mm 4mm !important;
            print-color-adjust: exact !important;
            -webkit-print-color-adjust: exact !important;
          }
          .payslip-brand-header img { height: 9mm !important; max-width: 45mm !important; }
          .payslip-brand-header h2 { font-size: 14pt !important; }
          .payslip-brand-header p, .payslip-brand-header span { font-size: 7pt !important; }
          .payslip-print-inner { padding: 3.5mm 4mm !important; }
          .payslip-section { margin-top: 2.2mm !important; break-inside: avoid !important; }
          .payslip-section h3 { margin-bottom: 1mm !important; font-size: 7pt !important; }
          .payslip-identity-grid { padding: 2mm 3mm !important; gap: 1mm 6mm !important; grid-template-columns: repeat(2,minmax(0,1fr)) !important; }
          .payslip-identity-grid > div { font-size: 8pt !important; }
          .payslip-summary-grid { gap: 1.5mm !important; grid-template-columns: repeat(3,minmax(0,1fr)) !important; }
          .payslip-summary-grid > div { padding: 1.5mm 2mm !important; border-radius: 2mm !important; }
          .payslip-summary-grid p { margin: 0 !important; font-size: 7.5pt !important; line-height: 1.15 !important; }
          .payslip-detail-row { padding: 1.1mm 0 !important; gap: 5mm !important; grid-template-columns: repeat(2,minmax(0,1fr)) !important; font-size: 7.5pt !important; break-inside: avoid !important; }
          .payslip-footer { margin-top: 2.5mm !important; padding-top: 2mm !important; gap: 5mm !important; grid-template-columns: minmax(0,1fr) 42mm !important; break-inside: avoid !important; }
          .payslip-confidentiality { padding: 1.5mm 2mm !important; border-radius: 2mm !important; }
          .payslip-confidentiality, .payslip-confidentiality ol { font-size: 6.5pt !important; line-height: 1.2 !important; }
          .payslip-confidentiality ol { margin-top: .8mm !important; }
          .payslip-signature { font-size: 7pt !important; }
          .payslip-sign-space { height: 10mm !important; }
          .payslip-system-note { margin-top: 1mm !important; font-size: 6pt !important; line-height: 1.1 !important; }
        }
      `}</style>

      <div className="space-y-5">
        <div className="print:hidden">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-brand-primary">Dokumen pribadi</p>
          <h1 className="mt-2 font-display text-2xl font-bold text-brand-heading sm:text-3xl">Slip Gaji</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Cari periode, tampilkan satu slip, lalu cetak atau simpan sebagai PDF. Hanya slip yang sudah dipublikasikan untuk akun Anda yang tersedia.
          </p>
        </div>

        {error ? <div className="print:hidden rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div> : null}

        {items === null ? (
          <div className="print:hidden flex min-h-36 items-center justify-center rounded-2xl border border-border bg-white"><Loader2 className="h-6 w-6 animate-spin text-brand-primary" aria-label="Memuat payslip" /></div>
        ) : items.length === 0 ? (
          <div className="print:hidden rounded-2xl border border-border bg-white p-8 text-center shadow-[var(--shadow-soft)]">
            <FileText className="mx-auto h-10 w-10 text-muted-foreground" />
            <h2 className="mt-4 text-base font-bold">Belum ada slip gaji yang dipublikasikan</h2>
            <p className="mt-2 text-sm text-muted-foreground">Draft atau batch yang masih direview tidak ditampilkan di sini.</p>
          </div>
        ) : (
          <>
            <section className="print:hidden rounded-2xl border border-border bg-white p-4 shadow-[var(--shadow-soft)]">
              <div className="flex flex-col gap-3 md:flex-row md:items-end">
                <label className="min-w-0 flex-1 text-xs font-bold text-brand-heading">
                  Cari periode slip
                  <div className="relative mt-2">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      list="payslip-period-options"
                      value={selectorValue}
                      onChange={(event) => setSelectorValue(event.target.value)}
                      onKeyDown={(event) => event.key === "Enter" && void showSelectedPayslip()}
                      placeholder="Ketik bulan atau tahun, mis. Juli 2026"
                      className="w-full rounded-xl border border-border bg-white py-2.5 pl-9 pr-3 text-sm"
                    />
                    <datalist id="payslip-period-options">
                      {items.map((item) => <option key={item.id} value={payslipOptionLabel(item)} />)}
                    </datalist>
                  </div>
                </label>
                <button type="button" disabled={loadingDetail} onClick={() => void showSelectedPayslip()} className="rounded-xl bg-brand-primary px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50">
                  Tampilkan
                </button>
                <button type="button" disabled={!selected || loadingDetail} onClick={() => window.print()} className="inline-flex items-center justify-center gap-2 rounded-xl border border-brand-primary/30 bg-white px-4 py-2.5 text-sm font-bold text-brand-primary-deep disabled:opacity-50">
                  <Printer className="h-4 w-4" /> Cetak / Simpan PDF
                </button>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">{items.length} slip tersedia. Tidak perlu scroll riwayat satu per satu.</p>
            </section>

            {loadingDetail ? (
              <div className="print:hidden flex min-h-72 items-center justify-center rounded-2xl border border-border bg-white"><Loader2 className="h-6 w-6 animate-spin" /></div>
            ) : selected ? (
              <PayslipPaper payslip={selected} employee={employee} />
            ) : (
              <div className="print:hidden flex min-h-64 items-center justify-center rounded-2xl border border-border bg-white p-8 text-center text-sm text-muted-foreground">Pilih periode dan klik Tampilkan.</div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
