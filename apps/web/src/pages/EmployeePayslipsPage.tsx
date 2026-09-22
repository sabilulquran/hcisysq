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
  type PayslipSummary,
} from "@/lib/payslips";

export const payslipInitialSelectorValue = "";
export const payslipAutomaticNote = "Dibuat otomatis oleh HCIS Sabilul Qur'an.";

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

export function payslipEmploymentStatusLabel(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function payslipOptionLabel(item: PayslipSummary) {
  const status = payslipEmploymentStatusLabel(item.employmentStatus);
  return status
    ? `${formatPayslipPeriod(item.period)} · ${status}`
    : formatPayslipPeriod(item.period);
}

export function filterPayslipOptions(items: PayslipSummary[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  return items.filter((item) =>
    payslipOptionLabel(item).toLowerCase().includes(normalized),
  );
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

function GenericPairLines({ lines }: { lines: PayslipLine[] }) {
  const rows: Array<[PayslipLine, PayslipLine | null]> = [];
  for (let index = 0; index < lines.length; index += 2) {
    rows.push([lines[index]!, lines[index + 1] ?? null]);
  }
  return (
    <div className="payslip-generic-table divide-y divide-slate-200 border-y border-slate-300">
      {rows.map(([left, right], index) => (
        <div
          key={`${left.label}-${index}`}
          className="payslip-detail-row grid gap-x-5 py-1.5 sm:grid-cols-2"
        >
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
            <span className="text-slate-600">{left.label}</span>
            <strong className="max-w-48 break-words text-right text-slate-950">{left.value}</strong>
          </div>
          {right ? (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
              <span className="text-slate-600">{right.label}</span>
              <strong className="max-w-48 break-words text-right text-slate-950">{right.value}</strong>
            </div>
          ) : <span />}
        </div>
      ))}
    </div>
  );
}

function PayrollColumn({
  title,
  lines,
}: {
  title: "PENGHASILAN" | "POTONGAN";
  lines: PayslipLine[];
}) {
  return (
    <div className="payslip-payroll-column overflow-hidden border border-slate-300">
      <div className="border-b border-slate-300 bg-slate-50 px-3 py-2 text-[8.5pt] font-extrabold tracking-[0.08em] text-slate-700">
        {title}
      </div>
      <div className="divide-y divide-slate-200">
        {lines.length > 0 ? lines.map((line) => (
          <div
            key={line.label}
            className="payslip-payroll-row grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-1.5 text-[9pt]"
          >
            <span className="text-slate-600">{line.label}</span>
            <strong className="max-w-44 break-words text-right text-slate-950">{line.value}</strong>
          </div>
        )) : (
          <div className="px-3 py-2 text-[8.5pt] text-slate-400">Tidak ada komponen.</div>
        )}
      </div>
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
  const employmentStatus = payslipEmploymentStatusLabel(payslip.employmentStatus);

  return (
    <article className="payslip-print-paper mx-auto min-h-[297mm] w-full max-w-[210mm] overflow-hidden rounded-sm border border-slate-300 bg-white text-[9.5pt] text-slate-900 shadow-[0_16px_44px_rgba(15,23,42,0.12)]">
      <header className="payslip-document-header bg-brand-primary-deep px-6 py-5 text-center text-white">
        <img
          src={ysqLogoHorizontal}
          alt="Yayasan Sabilul Qur'an"
          className="mx-auto h-[5.5rem] w-auto max-w-[26rem] object-contain"
        />
        <h2 className="mt-3 text-[12pt] font-extrabold tracking-[0.12em]">SLIP GAJI</h2>
        <p className="mt-1 text-[9pt] text-white/85">Periode {formatPayslipPeriod(payslip.period)}</p>
        {employmentStatus ? (
          <span className="mt-2 inline-flex rounded-full bg-white/15 px-2.5 py-0.5 text-[8pt] font-bold">
            {employmentStatus}
          </span>
        ) : null}
      </header>

      <div className="payslip-print-inner p-5 sm:p-6">
        <section className="payslip-section">
          <h3 className="mb-2 text-[8.5pt] font-bold uppercase tracking-[0.12em] text-slate-600">Identitas Pegawai</h3>
          <div className="payslip-identity-grid grid gap-x-8 gap-y-1.5 border border-slate-300 bg-slate-50 px-4 py-3 sm:grid-cols-2">
            <div className="grid grid-cols-[4.25rem_minmax(0,1fr)] gap-2 text-[9.5pt]"><span className="text-slate-600">Nama</span><strong>{employee?.fullName ?? "—"}</strong></div>
            <div className="grid grid-cols-[4.25rem_minmax(0,1fr)] gap-2 text-[9.5pt]"><span className="text-slate-600">NIP</span><strong>{employee?.employeeNumber ?? "—"}</strong></div>
            <div className="grid grid-cols-[4.25rem_minmax(0,1fr)] gap-2 text-[9.5pt]"><span className="text-slate-600">Unit</span><strong>{employee?.unitName ?? "—"}</strong></div>
            <div className="grid grid-cols-[4.25rem_minmax(0,1fr)] gap-2 text-[9.5pt]"><span className="text-slate-600">Jabatan</span><strong>{employee?.positionName ?? "—"}</strong></div>
          </div>
        </section>

        {structured && grouped.summary.length > 0 ? (
          <section className="payslip-section mt-4">
            <h3 className="mb-2 text-[8.5pt] font-bold uppercase tracking-[0.12em] text-brand-primary-deep">Ringkasan Gaji</h3>
            <div className="payslip-summary-grid grid gap-2 sm:grid-cols-3">
              {grouped.summary.map((line) => (
                <div key={line.label} className="border border-slate-300 bg-brand-primary-pale/20 px-3 py-2">
                  <p className="text-[8pt] font-semibold text-slate-600">{line.label}</p>
                  <p className="mt-0.5 text-[10.5pt] font-extrabold text-slate-950">{line.value}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {structured ? (
          <section className="payslip-section mt-4">
            <div className="payslip-income-deduction-grid grid gap-4 sm:grid-cols-2">
              <PayrollColumn title="PENGHASILAN" lines={grouped.income} />
              <PayrollColumn title="POTONGAN" lines={grouped.deduction} />
            </div>
          </section>
        ) : payslip.lines.length > 0 ? (
          <section className="payslip-section mt-4">
            <h3 className="mb-2 text-[8.5pt] font-bold uppercase tracking-[0.12em] text-slate-600">Rincian Slip</h3>
            <GenericPairLines lines={payslip.lines} />
          </section>
        ) : null}

        {structured && grouped.other.length > 0 ? (
          <section className="payslip-section mt-3">
            <h3 className="mb-2 text-[8.5pt] font-bold uppercase tracking-[0.12em] text-slate-600">Informasi Lain</h3>
            <GenericPairLines lines={grouped.other} />
          </section>
        ) : null}

        <footer className="payslip-footer mt-5 flex justify-start border-t border-slate-300 pt-4">
          <div className="payslip-signature w-56 text-center text-[8.5pt] text-slate-900">
            <p className="font-semibold">{payslip.signer.title},</p>
            <div className="payslip-sign-space h-14" aria-hidden="true" />
            <p className="border-t border-slate-500 pt-1 font-bold">
              {payslip.signer.name ?? "Pejabat penandatangan belum ditetapkan"}
            </p>
          </div>
        </footer>

        <p className="payslip-system-note mt-2 text-[7.5pt] leading-4 text-slate-500">
          {payslipAutomaticNote}
        </p>
      </div>
    </article>
  );
}

export function EmployeePayslipsPage() {
  const [items, setItems] = useState<PayslipSummary[] | null>(null);
  const [selected, setSelected] = useState<PayslipDetail | null>(null);
  const [selectorValue, setSelectorValue] = useState(payslipInitialSelectorValue);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    let mounted = true;
    void getMyPayslips()
      .then((result) => {
        if (!mounted) return;
        setItems(result.items);
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
  const filteredOptions = useMemo(
    () => filterPayslipOptions(items ?? [], selectorValue),
    [items, selectorValue],
  );

  const showSelectedPayslip = async () => {
    if (!items?.length) return;
    let match = selectedId ? items.find((item) => item.id === selectedId) : undefined;
    if (!match) {
      const normalized = selectorValue.trim().toLowerCase();
      const exact = items.find((item) => payslipOptionLabel(item).toLowerCase() === normalized);
      if (exact) match = exact;
      else {
        const candidates = filterPayslipOptions(items, selectorValue);
        if (candidates.length === 1) match = candidates[0];
      }
    }
    if (!match) {
      setError("Pilih satu periode dari daftar pilihan.");
      setSelectorOpen(true);
      return;
    }
    setSelectorValue(payslipOptionLabel(match));
    setSelectedId(match.id);
    setSelectorOpen(false);
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
          @page { size: A4 portrait; margin: 0; }
          html, body {
            margin: 0 !important;
            padding: 0 !important;
            background: #fff !important;
          }
          body * { visibility: hidden !important; }
          .payslip-print-paper, .payslip-print-paper * {
            visibility: visible !important;
          }
          .payslip-print-paper {
            position: absolute !important;
            inset: 0 auto auto 0 !important;
            box-sizing: border-box !important;
            width: 210mm !important;
            max-width: 210mm !important;
            min-height: 297mm !important;
            border: 1px solid #cbd5e1 !important;
            border-radius: 0 !important;
            box-shadow: none !important;
          }
          .payslip-document-header {
            print-color-adjust: exact !important;
            -webkit-print-color-adjust: exact !important;
          }
        }
      `}</style>

      <div className="space-y-4">
        <div className="print:hidden">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-brand-primary">Dokumen pribadi</p>
          <h1 className="mt-2 font-display text-2xl font-bold text-brand-heading sm:text-3xl">Slip Gaji</h1>
        </div>

        <section className="print:hidden rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-800" />
            <div>
              <p className="text-xs font-extrabold uppercase tracking-[0.1em] text-amber-900">Catatan penting</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs leading-5 text-amber-950">
                {payslipConfidentialityNotes.map((note) => <li key={note}>{note}</li>)}
              </ol>
            </div>
          </div>
        </section>

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
                <label className="relative min-w-0 flex-1 text-xs font-bold text-brand-heading">
                  Pilih periode slip
                  <div className="relative mt-2">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      value={selectorValue}
                      onFocus={() => setSelectorOpen(true)}
                      onBlur={() => window.setTimeout(() => setSelectorOpen(false), 120)}
                      onChange={(event) => {
                        setSelectorValue(event.target.value);
                        setSelectedId(null);
                        setSelectorOpen(true);
                      }}
                      onKeyDown={(event) => event.key === "Enter" && void showSelectedPayslip()}
                      placeholder="Ketik bulan, tahun, atau status kepegawaian"
                      className="w-full rounded-xl border border-border bg-white py-2.5 pl-9 pr-3 text-sm font-normal"
                      autoComplete="off"
                    />
                    {selectorOpen ? (
                      <div className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-white p-1 shadow-xl">
                        {filteredOptions.length > 0 ? filteredOptions.map((item) => {
                          const status = payslipEmploymentStatusLabel(item.employmentStatus);
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                setSelectorValue(payslipOptionLabel(item));
                                setSelectedId(item.id);
                                setSelectorOpen(false);
                                setError(null);
                              }}
                              className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm font-normal hover:bg-surface"
                            >
                              <span className="font-semibold text-brand-heading">{formatPayslipPeriod(item.period)}</span>
                              {status ? <span className="text-xs text-muted-foreground">{status}</span> : null}
                            </button>
                          );
                        }) : (
                          <div className="px-3 py-4 text-center text-xs text-muted-foreground">Tidak ada periode yang cocok.</div>
                        )}
                      </div>
                    ) : null}
                  </div>
                </label>
                <button type="button" disabled={loadingDetail} onClick={() => void showSelectedPayslip()} className="rounded-xl bg-brand-primary px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50">
                  Tampilkan
                </button>
                <button type="button" disabled={!selected || loadingDetail} onClick={() => window.print()} className="inline-flex items-center justify-center gap-2 rounded-xl border border-brand-primary/30 bg-white px-4 py-2.5 text-sm font-bold text-brand-primary-deep disabled:opacity-50">
                  <Printer className="h-4 w-4" /> Cetak / Simpan PDF
                </button>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">{items.length} slip tersedia. Klik kolom pilihan untuk melihat semua periode atau ketik untuk memfilter.</p>
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
