import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  deletePayrollInput,
  employeeLabel,
  getPayrollInputs,
  payrollInputLabel,
  PayrollApiError,
  savePayrollInputs,
  type PayrollEmployeeIdentity,
  type PayrollInputKey,
  type PayrollPeriod,
  type PayrollPeriodInput,
} from "@/lib/payroll";
import { EmploymentPicker } from "@/components/payroll/EmploymentPicker";
import type { PayrollEmployment } from "@/lib/payrollReference";

/**
 * The manual side of a period's inputs: rapel, penyesuaian, prorata, konten Pj.
 * Media and the overrides. Overtime and PKWT attendance come from the
 * attendance resolver and are left to it.
 *
 * Which keys are typed by hand, and which of them the server refuses without a
 * reason or a decision reference, are read from `period.inputRules`. The screen
 * keeps no copy of a payroll rule (AGENTS.md section 4).
 */
export function PeriodInputsPanel({
  period,
  identities,
  canManage,
  onChanged,
}: {
  period: PayrollPeriod;
  identities: ReadonlyMap<string, PayrollEmployeeIdentity>;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [inputs, setInputs] = useState<PayrollPeriodInput[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<PayrollEmployment | null>(null);
  const [form, setForm] = useState({
    inputKey: "" as PayrollInputKey | "",
    value: "",
    reason: "",
    decisionReference: "",
  });

  const rules = period.inputRules ?? { manual: [], reasonRequired: [], decisionRequired: [] };
  const needsReason = form.inputKey !== "" && rules.reasonRequired.includes(form.inputKey);
  const needsDecision = form.inputKey !== "" && rules.decisionRequired.includes(form.inputKey);

  const load = useCallback(async () => {
    setNote(null);
    try {
      const outcome = await getPayrollInputs(period.id);
      setInputs(outcome.inputs);
    } catch (cause) {
      // A refused panel says why; an empty one would read as "no inputs".
      setNote(cause instanceof PayrollApiError ? cause.message : "Input periode tidak dapat dibaca.");
      setInputs([]);
    }
  }, [period.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!picked || form.inputKey === "") return;
    const value = Number(form.value.trim());
    if (form.value.trim() === "" || !Number.isFinite(value)) {
      setError("Nilai input harus angka.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await savePayrollInputs(period.id, [
        {
          employmentId: picked.employmentId,
          inputKey: form.inputKey,
          value,
          ...(form.reason ? { reason: form.reason } : {}),
          ...(form.decisionReference ? { decisionReference: form.decisionReference } : {}),
        },
      ]);
      setNotice(`${payrollInputLabel(form.inputKey)} untuk ${picked.fullName} tercatat.`);
      setForm({ inputKey: form.inputKey, value: "", reason: "", decisionReference: "" });
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof PayrollApiError ? cause.message : "Input gagal disimpan.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(input: PayrollPeriodInput) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await deletePayrollInput(period.id, input.employmentId, input.inputKey);
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof PayrollApiError ? cause.message : "Input gagal dihapus.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border bg-card">
      <header className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Input periode</h2>
        <p className="text-xs text-muted-foreground">
          Rapel, penyesuaian, prorata, dan override yang diketik operator. Lembur dan kehadiran PKWT datang dari
          kehadiran lewat tombol “Ambil lembur &amp; kehadiran”, dan ditimpa setiap kali tombol itu dijalankan.
        </p>
      </header>

      <div className="space-y-3 px-4 py-3">
        {note ? <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">{note}</p> : null}
        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>{error}</p>
          </div>
        ) : null}
        {notice ? <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">{notice}</p> : null}

        {canManage ? (
          <div className="space-y-3 rounded-md border p-3">
            <EmploymentPicker label="Pegawai" picked={picked} onPick={setPicked} />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Jenis input</span>
                <select
                  value={form.inputKey}
                  onChange={(event) => setForm({ ...form, inputKey: event.target.value as PayrollInputKey })}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Pilih jenis</option>
                  {rules.manual.map((key) => (
                    <option key={key} value={key}>{payrollInputLabel(key)}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Nilai</span>
                <input
                  inputMode="decimal"
                  value={form.value}
                  onChange={(event) => setForm({ ...form, value: event.target.value })}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </label>
              {needsReason ? (
                <label className="text-sm sm:col-span-2">
                  <span className="mb-1 block text-muted-foreground">Alasan (wajib untuk input ini)</span>
                  <input
                    value={form.reason}
                    onChange={(event) => setForm({ ...form, reason: event.target.value })}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  />
                </label>
              ) : null}
              {needsDecision ? (
                <label className="text-sm sm:col-span-2">
                  <span className="mb-1 block text-muted-foreground">Referensi keputusan (wajib untuk input ini)</span>
                  <input
                    value={form.decisionReference}
                    onChange={(event) => setForm({ ...form, decisionReference: event.target.value })}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  />
                </label>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => void save()}
              disabled={
                busy
                || !picked
                || form.inputKey === ""
                || form.value.trim() === ""
                || (needsReason && form.reason.trim() === "")
                || (needsDecision && form.decisionReference.trim() === "")
              }
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Simpan input
            </button>
          </div>
        ) : null}

        {inputs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada input tercatat untuk periode ini.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2">Pegawai</th>
                  <th scope="col" className="px-3 py-2">Jenis</th>
                  <th scope="col" className="px-3 py-2 text-right">Nilai</th>
                  <th scope="col" className="px-3 py-2">Asal</th>
                  <th scope="col" className="px-3 py-2">Alasan</th>
                  {canManage ? <th scope="col" className="px-3 py-2" /> : null}
                </tr>
              </thead>
              <tbody className="divide-y">
                {inputs.map((input) => (
                  <tr key={`${input.employmentId}-${input.inputKey}`}>
                    <td className="px-3 py-2">{employeeLabel(input.employmentId, identities)}</td>
                    <td className="px-3 py-2">{payrollInputLabel(input.inputKey)}</td>
                    <td className="px-3 py-2 text-right">{input.value}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{input.origin}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {input.reason ?? ""}
                      {input.decisionReference ? ` · ${input.decisionReference}` : ""}
                    </td>
                    {canManage ? (
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => void remove(input)}
                          disabled={busy}
                          aria-label={`Hapus ${payrollInputLabel(input.inputKey)}`}
                          className="inline-flex h-8 items-center rounded-md border px-2 text-xs disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
