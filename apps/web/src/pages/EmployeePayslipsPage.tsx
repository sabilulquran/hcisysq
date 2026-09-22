import { FileText, Loader2, LockKeyhole, Printer } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import ysqMark from "@/assets/brand/ysq-mark.png";
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

function formatPeriod(value: string) {
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return value;
  return new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric", timeZone: "Asia/Jakarta" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

export function payslipSourceLabel(value: PayslipSourceFormat) {
  if (value === "tetap") return "Pegawai Tetap";
  if (value === "honorer") return "Honorer";
  return "Imported";
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

function LineGrid({ lines }: { lines: PayslipLine[] }) {
  return (
    <dl className="grid gap-x-8 sm:grid-cols-2">
      {lines.map((line, index) => (
        <div key={`${line.label}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-border/70 py-3">
          <dt className="text-sm text-muted-foreground">{line.label}</dt>
          <dd className="max-w-56 break-words text-right text-sm font-bold text-brand-heading">{line.value}</dd>
        </div>
      ))}
    </dl>
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

  return (
    <article className="payslip-print-paper overflow-hidden rounded-3xl border border-border bg-white shadow-[var(--shadow-soft)]">
      <div className="p-5 sm:p-8">
        <header className="flex flex-col items-center border-b-2 border-brand-primary/30 pb-5 text-center">
          <img src={ysqMark} alt="Yayasan Sabilul Qur'an" className="h-16 w-16 object-contain" />
          <p className="mt-3 text-xs font-bold uppercase tracking-[0.16em] text-brand-primary-deep">Yayasan Sabilul Qur&apos;an</p>
          <h2 className="mt-1 text-2xl font-extrabold tracking-[0.08em] text-brand-heading">SLIP GAJI</h2>
          <p className="mt-1 text-sm text-muted-foreground">Periode {formatPeriod(payslip.period)}</p>
          <span className="mt-3 rounded-full bg-brand-primary-pale px-3 py-1 text-[11px] font-bold text-brand-primary-deep">
            {payslipSourceLabel(payslip.sourceFormat)}
          </span>
        </header>

        <section className="mt-6">
          <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Identitas Pegawai</h3>
          <div className="mt-3 grid gap-3 rounded-2xl bg-surface p-4 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Nama</p>
              <p className="mt-1 text-sm font-bold text-brand-heading">{employee?.fullName ?? "—"}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">NIP</p>
              <p className="mt-1 text-sm font-bold text-brand-heading">{employee?.employeeNumber ?? "—"}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Unit</p>
              <p className="mt-1 text-sm font-bold text-brand-heading">{employee?.unitName ?? "—"}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Jabatan</p>
              <p className="mt-1 text-sm font-bold text-brand-heading">{employee?.positionName ?? "—"}</p>
            </div>
          </div>
        </section>

        {structured && grouped.summary.length > 0 ? (
          <section className="mt-6 rounded-2xl border border-brand-primary/20 bg-brand-primary-pale/30 p-4">
            <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Ringkasan dari sumber payroll</h3>
            <div className="mt-2">
              <LineGrid lines={grouped.summary} />
            </div>
          </section>
        ) : null}

        {structured && grouped.income.length > 0 ? (
          <section className="mt-6">
            <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Rincian Penghasilan</h3>
            <div className="mt-2"><LineGrid lines={grouped.income} /></div>
          </section>
        ) : null}

        {structured && grouped.deduction.length > 0 ? (
          <section className="mt-6">
            <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">Potongan</h3>
            <div className="mt-2"><LineGrid lines={grouped.deduction} /></div>
          </section>
        ) : null}

        {(grouped.other.length > 0 || (!structured && payslip.lines.length > 0)) ? (
          <section className="mt-6">
            <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
              {structured ? "Informasi Lain" : "Rincian Slip"}
            </h3>
            <div className="mt-2"><LineGrid lines={structured ? grouped.other : payslip.lines} /></div>
          </section>
        ) : null}

        <footer className="mt-8 border-t border-border pt-4 text-[11px] leading-5 text-muted-foreground">
          <p>Dokumen ini bersifat pribadi. Nilai ditampilkan dari data payroll yang dipublikasikan dan tidak dihitung ulang oleh HCIS.</p>
        </footer>
      </div>
    </article>
  );
}

export function EmployeePayslipsPage() {
  const [items, setItems] = useState<PayslipSummary[] | null>(null);
  const [selected, setSelected] = useState<PayslipDetail | null>(null);
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

  const openPayslip = async (id: string) => {
    setLoadingDetail(true);
    setError(null);
    try {
      setSelected(await getMyPayslip(id));
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
          body * { visibility: hidden !important; }
          .payslip-print-paper, .payslip-print-paper * { visibility: visible !important; }
          .payslip-print-paper {
            position: absolute !important;
            inset: 0 auto auto 0 !important;
            width: 100% !important;
            border: 0 !important;
            border-radius: 0 !important;
            box-shadow: none !important;
          }
          @page { size: A4; margin: 12mm; }
        }
      `}</style>
      <div className="space-y-6">
        <div className="print:hidden">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-brand-primary">Dokumen pribadi</p>
          <h1 className="mt-2 font-display text-2xl font-bold text-brand-heading sm:text-3xl">Slip Gaji</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Hanya slip yang sudah dipublikasikan untuk akun Anda yang ditampilkan. Data read-only berasal dari import payroll dan tidak dihitung ulang oleh HCIS.
          </p>
        </div>

        {error ? (
          <div className="print:hidden rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>
        ) : null}

        {items === null ? (
          <div className="print:hidden flex min-h-48 items-center justify-center rounded-3xl border border-border bg-white">
            <Loader2 className="h-6 w-6 animate-spin text-brand-primary" aria-label="Memuat payslip" />
          </div>
        ) : items.length === 0 ? (
          <div className="print:hidden rounded-3xl border border-border bg-white p-8 text-center shadow-[var(--shadow-soft)]">
            <FileText className="mx-auto h-10 w-10 text-muted-foreground" />
            <h2 className="mt-4 text-base font-bold">Belum ada slip gaji yang dipublikasikan</h2>
            <p className="mt-2 text-sm text-muted-foreground">Draft atau batch yang masih direview tidak ditampilkan di sini.</p>
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
            <aside className="print:hidden space-y-3">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">Riwayat</p>
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void openPayslip(item.id)}
                  className="flex w-full items-center justify-between rounded-2xl border border-border bg-white p-4 text-left shadow-[var(--shadow-soft)] transition hover:border-brand-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span>
                    <span className="block text-sm font-bold">{formatPeriod(item.period)}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{payslipSourceLabel(item.sourceFormat)}</span>
                  </span>
                  <LockKeyhole className="h-5 w-5 text-brand-primary" aria-hidden="true" />
                </button>
              ))}
            </aside>

            <div className="min-w-0">
              {loadingDetail ? (
                <div className="print:hidden flex min-h-72 items-center justify-center rounded-3xl border border-border bg-white">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : selected ? (
                <div className="space-y-3">
                  <div className="print:hidden flex justify-end">
                    <button
                      type="button"
                      onClick={() => window.print()}
                      className="inline-flex items-center gap-2 rounded-xl bg-brand-primary px-4 py-2.5 text-sm font-bold text-white"
                    >
                      <Printer className="h-4 w-4" />
                      Cetak / Simpan PDF
                    </button>
                  </div>
                  <PayslipPaper payslip={selected} employee={employee} />
                </div>
              ) : (
                <div className="print:hidden flex min-h-72 items-center justify-center rounded-3xl border border-border bg-white p-8 text-center text-sm text-muted-foreground">
                  Pilih periode untuk melihat detail slip gaji.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
