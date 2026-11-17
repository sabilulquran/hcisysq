// PAY-003 §7.4: annual PPh21 (Pasal 17) recap, bukti potong 1721-A1, and NIK/NPWP entry.
// The server decides every figure and every permission; the screen shows what it returns,
// and a section the account may not open is not shown at all.

import { AlertTriangle, Download, FileText, IdCard, Loader2, Printer } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { DetailDialog } from "@/components/DetailDialog";
import { Pph21A1Paper, Pph21A1PrintCopy } from "@/components/payroll/Pph21A1Paper";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import { PayrollApiError } from "@/lib/payroll";
import {
  ANNUAL_FLAG_LABELS,
  getPph21A1,
  getPph21AnnualRecap,
  getTaxIdentity,
  pph21AnnualCsvUrl,
  putTaxIdentity,
  rupiah,
  type Pph21A1Document,
  type Pph21AnnualRecap,
  type TaxIdentityMasked,
} from "@/lib/payrollPph21Annual";
import type { AuthSession } from "@/types/hcis";

/** Same set the API accepts for per-person figures (§7.3). */
const READER_PERMISSIONS = ["payroll.results.read.organization", "payroll.calculate", "payroll.inputs.manage"];

function defaultYear(): number {
  // Bukti potong are made in January for the year just ended.
  const now = new Date();
  return now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
}

export function AdminPayrollPph21AnnualPage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [year, setYear] = useState(defaultYear());
  const [recap, setRecap] = useState<Pph21AnnualRecap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [a1, setA1] = useState<Pph21A1Document | null>(null);
  const [a1Error, setA1Error] = useState<string | null>(null);
  const [identityFor, setIdentityFor] = useState<{ employeeId: string; fullName: string } | null>(null);

  const canRead = READER_PERMISSIONS.some((permission) => hasPermission(session, permission));
  const canEditIdentity = hasPermission(session, "payroll.profiles.manage");

  useEffect(() => {
    let active = true;
    void getCurrentSession().then((value) => {
      if (active) setSession(value);
    });
    return () => {
      active = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRecap((await getPph21AnnualRecap(year)).annual);
    } catch (cause) {
      setRecap(null);
      setError(cause instanceof PayrollApiError ? cause.message : "Rekap PPh21 tahunan gagal dimuat.");
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    if (canRead) void load();
  }, [canRead, load]);

  async function openA1(employeeId: string, index: number) {
    setA1Error(null);
    try {
      setA1((await getPph21A1(year, employeeId, index)).a1);
    } catch (cause) {
      setA1Error(cause instanceof PayrollApiError ? cause.message : "Bukti potong gagal dibuka.");
    }
  }

  return (
    <AdminShell
      active="payroll-pph21-annual"
      title="PPh21 Tahunan & 1721-A1"
      description="Penghitungan Pasal 17 masa pajak terakhir dan bukti potong 1721-A1 per pegawai."
    >
      <div className="space-y-6">
        {canRead ? (
          <section className="space-y-3 rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Tahun pajak</span>
                <input
                  type="number"
                  min={2024}
                  max={2100}
                  value={year}
                  onChange={(event) => setYear(Number(event.target.value))}
                  className="h-9 w-28 rounded-md border bg-background px-3 text-sm"
                />
              </label>
              {recap ? (
                <a
                  href={pph21AnnualCsvUrl(year)}
                  className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium"
                >
                  <Download className="h-4 w-4" aria-hidden /> Unduh rekap e-Bupot (CSV, memuat NIK/NPWP)
                </a>
              ) : null}
            </div>
            {loading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Memuat rekap…
              </p>
            ) : null}
            {error ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <p>{error}</p>
              </div>
            ) : null}
            {recap ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Sumber kebijakan: {recap.policy.source} (berlaku {recap.policy.effectiveFrom}). {recap.totals.closedCount} dari{" "}
                  {recap.totals.segmentCount} masa kerja sudah mencapai masa pajak terakhir.
                </p>
                {recap.pendingPeriods.length > 0 ? (
                  <p className="text-xs text-amber-700">
                    Periode belum disahkan dan belum dihitung: {recap.pendingPeriods.map((period) => period.periodMonth).join(", ")}.
                  </p>
                ) : null}
                {recap.periodsWithoutTer.length > 0 ? (
                  <p className="text-xs text-amber-700">Tabel TER belum dimuat untuk: {recap.periodsWithoutTer.join(", ")}.</p>
                ) : null}
                {recap.rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Belum ada periode yang disahkan pada tahun ini.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[56rem] text-sm">
                      <thead className="text-left text-xs text-muted-foreground">
                        <tr>
                          <th className="py-2 pr-3">Pegawai</th>
                          <th className="py-2 pr-3">Masa</th>
                          <th className="py-2 pr-3">PTKP</th>
                          <th className="py-2 pr-3 text-right">Bruto</th>
                          <th className="py-2 pr-3 text-right">PKP</th>
                          <th className="py-2 pr-3 text-right">PPh21 setahun</th>
                          <th className="py-2 pr-3 text-right">TER sebelumnya</th>
                          <th className="py-2 pr-3 text-right">Masa terakhir</th>
                          <th className="py-2 pr-3">NIK/NPWP</th>
                          <th className="py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {recap.rows.map((row) => (
                          <tr key={`${row.employeeId}-${row.index}`} className="border-t align-top">
                            <td className="py-2 pr-3">
                              <p className="font-medium">{row.fullName}</p>
                              <p className="text-xs text-muted-foreground">{row.employeeNumber}</p>
                              {row.flags.map((flag) => (
                                <p key={flag} className="text-xs text-amber-700">{ANNUAL_FLAG_LABELS[flag]}</p>
                              ))}
                            </td>
                            <td className="py-2 pr-3 whitespace-nowrap">{row.startPeriod} – {row.endPeriod}</td>
                            <td className="py-2 pr-3">{row.ptkpStatus ?? "—"}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{rupiah(row.gross)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{rupiah(row.pkp)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{rupiah(row.annualTax)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{rupiah(row.terWithheld)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{rupiah(row.finalMasaTax)}</td>
                            <td className="py-2 pr-3 text-xs">
                              {row.taxIdentity.nik ? "NIK ada" : "NIK belum"} · {row.taxIdentity.npwp ? "NPWP ada" : "NPWP belum"}
                            </td>
                            <td className="py-2 text-right whitespace-nowrap">
                              {row.closed ? (
                                <button
                                  type="button"
                                  onClick={() => void openA1(row.employeeId, row.index)}
                                  className="inline-flex items-center gap-1 text-sm font-medium text-primary underline"
                                >
                                  <FileText className="h-4 w-4" aria-hidden /> 1721-A1
                                </button>
                              ) : null}
                              {canEditIdentity ? (
                                <button
                                  type="button"
                                  onClick={() => setIdentityFor({ employeeId: row.employeeId, fullName: row.fullName })}
                                  className="ml-3 inline-flex items-center gap-1 text-sm font-medium text-primary underline"
                                >
                                  <IdCard className="h-4 w-4" aria-hidden /> NIK/NPWP
                                </button>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : null}
            {a1Error ? <p className="text-sm text-destructive">{a1Error}</p> : null}
          </section>
        ) : null}
      </div>

      {a1 ? (
        <DetailDialog title="Bukti potong 1721-A1" description={`${a1.employee.fullName} · ${a1.year}`} onClose={() => setA1(null)} wide>
          <Pph21A1PrintCopy a1={a1} />
          <div className="mb-3 flex justify-end">
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
            >
              <Printer className="h-4 w-4" aria-hidden /> Cetak / Simpan PDF
            </button>
          </div>
          <Pph21A1Paper a1={a1} />
        </DetailDialog>
      ) : null}

      {identityFor ? (
        <TaxIdentityDialog
          employeeId={identityFor.employeeId}
          fullName={identityFor.fullName}
          onClose={() => setIdentityFor(null)}
          onSaved={() => void load()}
        />
      ) : null}
    </AdminShell>
  );
}

function TaxIdentityDialog({
  employeeId,
  fullName,
  onClose,
  onSaved,
}: {
  employeeId: string;
  fullName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [current, setCurrent] = useState<TaxIdentityMasked | null>(null);
  const [nik, setNik] = useState("");
  const [npwp, setNpwp] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void getTaxIdentity(employeeId)
      .then((data) => setCurrent(data.taxIdentity))
      .catch((cause) => setMessage(cause instanceof PayrollApiError ? cause.message : "Data pajak gagal dimuat."));
  }, [employeeId]);

  async function save() {
    // Only what was typed is sent: an empty box keeps the number on file.
    const body: { nik?: string; npwp?: string } = {};
    if (nik.trim()) body.nik = nik.trim();
    if (npwp.trim()) body.npwp = npwp.trim();
    if (!body.nik && !body.npwp) {
      setMessage("Isi NIK atau NPWP.");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const data = await putTaxIdentity(employeeId, body);
      setCurrent(data.taxIdentity);
      setNik("");
      setNpwp("");
      setMessage("Tersimpan.");
      onSaved();
    } catch (cause) {
      setMessage(cause instanceof PayrollApiError ? cause.message : "Data pajak gagal disimpan.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <DetailDialog title="NIK dan NPWP untuk bukti potong" description={fullName} onClose={onClose}>
      <p className="text-sm text-muted-foreground">
        Nomor disimpan terenkripsi dan hanya dicetak pada bukti potong 1721-A1 serta rekap e-Bupot. Layar ini menampilkan empat digit terakhir.
      </p>
      <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-y-1 text-sm">
        <dt className="text-muted-foreground">NIK</dt>
        <dd>{current?.nikMasked ?? "belum tercatat"}</dd>
        <dt className="text-muted-foreground">NPWP</dt>
        <dd>{current?.npwpMasked ?? "belum tercatat"}</dd>
      </dl>
      <div className="mt-4 grid gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-muted-foreground">NIK baru (16 digit)</span>
          <input value={nik} onChange={(event) => setNik(event.target.value)} inputMode="numeric" autoComplete="off" className="h-9 w-full rounded-md border bg-background px-3" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted-foreground">NPWP baru (15 atau 16 digit)</span>
          <input value={npwp} onChange={(event) => setNpwp(event.target.value)} inputMode="numeric" autoComplete="off" className="h-9 w-full rounded-md border bg-background px-3" />
        </label>
        {message ? <p className="text-sm">{message}</p> : null}
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Simpan
        </button>
      </div>
    </DetailDialog>
  );
}
