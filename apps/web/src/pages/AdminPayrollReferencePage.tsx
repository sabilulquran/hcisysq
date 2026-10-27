import { AlertTriangle, Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { AdminShell } from "@/layouts/AdminShell";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import { formatRupiah, PayrollApiError } from "@/lib/payroll";
import {
  BPJS_SEGMENTS,
  createPayrollLoan,
  EDUCATION_LEVELS,
  listCompensationProfiles,
  listPayrollLoans,
  listPayrollPolicies,
  openCompensationProfile,
  openPayrollPolicyVersion,
  policyLabel,
  searchPayrollEmployments,
  WORK_PATTERNS,
  type PayrollCompensationProfile,
  type PayrollEmployment,
  type PayrollLoan,
  type PayrollPolicyVersion,
} from "@/lib/payrollReference";
import type { AuthSession } from "@/types/hcis";

type Tab = "policies" | "loans" | "profiles";

const TAB_LABELS: Record<Tab, string> = {
  policies: "Kebijakan",
  loans: "Kasbon",
  profiles: "Profil kompensasi",
};

/**
 * Which tabs this actor can open. The API decides each request on its own; the
 * tabs only avoid offering a door that answers 403.
 */
function permittedTabs(session: AuthSession | null): Tab[] {
  const tabs: Tab[] = [];
  if (hasPermission(session, "payroll.policies.manage")) tabs.push("policies");
  if (hasPermission(session, "payroll.loans.manage")) tabs.push("loans");
  if (hasPermission(session, "payroll.profiles.manage")) tabs.push("profiles");
  return tabs;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof PayrollApiError ? cause.message : fallback;
}

function PolicyPanel() {
  const [policies, setPolicies] = useState<PayrollPolicyVersion[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    policyKey: "",
    effectiveFrom: today(),
    payload: "{\n}",
    source: "",
    note: "",
    backdateReason: "",
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const outcome = await listPayrollPolicies(filter || undefined);
      setPolicies(outcome.policies);
    } catch (cause) {
      setError(errorMessage(cause, "Daftar kebijakan gagal dimuat."));
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    setBusy(true);
    setError(null);
    setNotice(null);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(form.payload) as Record<string, unknown>;
    } catch {
      setError("Isi kebijakan harus JSON yang sah.");
      setBusy(false);
      return;
    }
    try {
      await openPayrollPolicyVersion({
        policyKey: form.policyKey,
        effectiveFrom: form.effectiveFrom,
        payload,
        source: form.source,
        ...(form.note ? { note: form.note } : {}),
        ...(form.backdateReason ? { backdateReason: form.backdateReason } : {}),
      });
      setNotice(`Versi ${policyLabel(form.policyKey)} berlaku sejak ${form.effectiveFrom} dibuka.`);
      setForm((current) => ({ ...current, backdateReason: "" }));
      await load();
    } catch (cause) {
      setError(errorMessage(cause, "Versi kebijakan gagal dibuka."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Banner tone="error" text={error} /> : null}
      {notice ? <Banner tone="notice" text={notice} /> : null}

      <section className="rounded-lg border bg-card p-4">
        <h2 className="text-sm font-semibold">Buka versi baru</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Versi tidak pernah diubah di tempat: membuka versi baru menutup versi sebelumnya sehari sebelum tanggal berlaku,
          supaya periode lama tetap dapat dihitung ulang dengan angka yang dipakai saat itu.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Kunci kebijakan</span>
            <input
              value={form.policyKey}
              onChange={(event) => setForm({ ...form, policyKey: event.target.value.toUpperCase() })}
              placeholder="BPJS_KESEHATAN"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Berlaku sejak</span>
            <input
              type="date"
              value={form.effectiveFrom}
              onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-muted-foreground">Isi kebijakan (JSON)</span>
            <textarea
              value={form.payload}
              onChange={(event) => setForm({ ...form, payload: event.target.value })}
              rows={8}
              className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-muted-foreground">Sumber (surat keputusan, peraturan)</span>
            <input
              value={form.source}
              onChange={(event) => setForm({ ...form, source: event.target.value })}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-muted-foreground">Catatan (opsional)</span>
            <input
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-muted-foreground">
              Alasan berlaku mundur — hanya bila tanggal berlaku menyentuh periode yang sudah dihitung
            </span>
            <input
              value={form.backdateReason}
              onChange={(event) => setForm({ ...form, backdateReason: event.target.value })}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            />
          </label>
        </div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !form.policyKey || !form.source}
          className="mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Buka versi
        </button>
      </section>

      <section className="rounded-lg border bg-card">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Versi tercatat</h2>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value.toUpperCase())}
            placeholder="Saring kunci kebijakan"
            className="h-9 rounded-md border bg-background px-3 text-sm"
          />
        </header>
        {policies.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Belum ada versi kebijakan yang tercatat.</p>
        ) : (
          <ul className="divide-y text-sm">
            {policies.map((policy) => (
              <li key={policy.id} className="px-4 py-3">
                <p className="font-medium">{policyLabel(policy.policyKey)}</p>
                <p className="text-xs text-muted-foreground">
                  {policy.effectiveFrom} s.d. {policy.effectiveTo ?? "sekarang"} · {policy.source}
                  {policy.note ? ` · ${policy.note}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function LoanPanel() {
  const [loans, setLoans] = useState<PayrollLoan[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<PayrollEmployment | null>(null);
  const [form, setForm] = useState({ grantedOn: today(), principal: "", instalment: "", note: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      const outcome = await listPayrollLoans({ page, pageSize });
      setLoans(outcome.loans);
      setTotal(outcome.total);
    } catch (cause) {
      setError(errorMessage(cause, "Register kasbon gagal dimuat."));
    }
  }, [page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    if (!picked) return;
    const principal = Number(form.principal);
    if (!Number.isInteger(principal) || principal <= 0) {
      setError("Pokok kasbon harus bilangan bulat lebih dari nol.");
      return;
    }
    const instalment = form.instalment.trim() === "" ? null : Number(form.instalment);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await createPayrollLoan({
        employeeId: picked.employeeId,
        grantedOn: form.grantedOn,
        principal,
        instalment,
        ...(form.note ? { note: form.note } : {}),
      });
      setNotice(`Kasbon ${picked.fullName} tercatat.`);
      setForm({ grantedOn: today(), principal: "", instalment: "", note: "" });
      setPage(1);
      await load();
    } catch (cause) {
      setError(errorMessage(cause, "Kasbon gagal dicatat."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Banner tone="error" text={error} /> : null}
      {notice ? <Banner tone="notice" text={notice} /> : null}

      <section className="rounded-lg border bg-card p-4">
        <h2 className="text-sm font-semibold">Catat kasbon</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Potongan angsuran diisi per periode saat periode masih dikumpulkan; hanya angsuran pada periode yang sudah
          disahkan yang mengurangi sisa.
        </p>
        <div className="mt-3 space-y-3">
          <EmploymentPicker label="Pegawai" picked={picked} onPick={setPicked} />
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Tanggal kasbon</span>
              <input
                type="date"
                value={form.grantedOn}
                onChange={(event) => setForm({ ...form, grantedOn: event.target.value })}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Pokok</span>
              <input
                inputMode="numeric"
                value={form.principal}
                onChange={(event) => setForm({ ...form, principal: event.target.value })}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Angsuran per bulan (opsional)</span>
              <input
                inputMode="numeric"
                value={form.instalment}
                onChange={(event) => setForm({ ...form, instalment: event.target.value })}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Catatan (opsional)</span>
            <input
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            />
          </label>
        </div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !picked || !form.principal}
          className="mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Catat kasbon
        </button>
      </section>

      <section className="rounded-lg border bg-card">
        <header className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Register kasbon</h2>
        </header>
        {loans.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Belum ada kasbon pada halaman ini.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2">Pegawai</th>
                  <th scope="col" className="px-4 py-2">Tanggal</th>
                  <th scope="col" className="px-4 py-2 text-right">Pokok</th>
                  <th scope="col" className="px-4 py-2 text-right">Terbayar</th>
                  <th scope="col" className="px-4 py-2 text-right">Sisa</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loans.map((loan) => (
                  <tr key={loan.id}>
                    <td className="px-4 py-2">
                      {loan.fullName} · {loan.employeeNumber}
                      {loan.closedAt ? <span className="ml-2 text-xs text-muted-foreground">lunas</span> : null}
                    </td>
                    <td className="px-4 py-2">{loan.grantedOn}</td>
                    <td className="px-4 py-2 text-right">{formatRupiah(loan.principal)}</td>
                    <td className="px-4 py-2 text-right">{formatRupiah(loan.deducted)}</td>
                    <td className="px-4 py-2 text-right font-medium">{formatRupiah(loan.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > 0 ? (
          <div className="border-t px-4 py-3">
            <PaginationBar
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(next) => {
                setPageSize(next);
                setPage(1);
              }}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ProfilePanel() {
  const [picked, setPicked] = useState<PayrollEmployment | null>(null);
  const [profiles, setProfiles] = useState<PayrollCompensationProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    effectiveFrom: today(),
    education: "",
    workPattern: "",
    teachingHoursPerWeek: "",
    spouseCount: "0",
    childCount: "0",
    registeredDependants: "0",
    bpjsSegment: "BELUM_TERDAFTAR",
    bankName: "",
    bankAccountNumber: "",
    bankAccountName: "",
    backdateReason: "",
  });

  const load = useCallback(async () => {
    if (!picked) {
      setProfiles([]);
      return;
    }
    setError(null);
    try {
      const outcome = await listCompensationProfiles(picked.employmentId);
      setProfiles(outcome.profiles);
    } catch (cause) {
      setError(errorMessage(cause, "Riwayat profil gagal dimuat."));
    }
  }, [picked]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await openCompensationProfile(picked.employmentId, {
        effectiveFrom: form.effectiveFrom,
        education: form.education || null,
        workPattern: form.workPattern || null,
        teachingHoursPerWeek: form.teachingHoursPerWeek === "" ? null : Number(form.teachingHoursPerWeek),
        spouseCount: Number(form.spouseCount),
        childCount: Number(form.childCount),
        registeredDependants: Number(form.registeredDependants),
        bpjsSegment: form.bpjsSegment,
        bankName: form.bankName || null,
        bankAccountNumber: form.bankAccountNumber || null,
        bankAccountName: form.bankAccountName || null,
        ...(form.backdateReason ? { backdateReason: form.backdateReason } : {}),
      });
      setNotice(`Profil ${picked.fullName} berlaku sejak ${form.effectiveFrom} dibuka.`);
      setForm((current) => ({ ...current, backdateReason: "" }));
      await load();
    } catch (cause) {
      setError(errorMessage(cause, "Profil gagal dibuka."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Banner tone="error" text={error} /> : null}
      {notice ? <Banner tone="notice" text={notice} /> : null}

      <section className="rounded-lg border bg-card p-4">
        <h2 className="text-sm font-semibold">Pilih pegawai</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Profil kompensasi menentukan pendidikan, pola kerja, tanggungan, segmen BPJS, dan rekening tujuan transfer.
          Tanpa profil yang berlaku pada tanggal gajian, perhitungan menolak pegawai itu dengan blocker PROFILE_MISSING.
        </p>
        <div className="mt-3">
          <EmploymentPicker label="Pegawai" picked={picked} onPick={setPicked} />
        </div>
      </section>

      {picked ? (
        <>
          <section className="rounded-lg border bg-card">
            <header className="border-b px-4 py-3">
              <h2 className="text-sm font-semibold">Riwayat profil</h2>
            </header>
            {profiles.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                Pegawai ini belum punya profil kompensasi. Buka satu di bawah sebelum periode dihitung.
              </p>
            ) : (
              <ul className="divide-y text-sm">
                {profiles.map((profile) => (
                  <li key={profile.id} className="px-4 py-3">
                    <p className="font-medium">
                      {profile.effectiveFrom} s.d. {profile.effectiveTo ?? "sekarang"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {profile.education ?? "pendidikan belum diisi"} · {profile.workPattern ?? "pola kerja belum diisi"} ·
                      BPJS {profile.bpjsSegment} · {profile.bankName ?? "bank belum diisi"}
                      {profile.bankAccountNumber ? " · rekening terisi" : " · rekening belum diisi"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-semibold">Buka profil baru</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Berlaku sejak</span>
                <input
                  type="date"
                  value={form.effectiveFrom}
                  onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Pendidikan</span>
                <select
                  value={form.education}
                  onChange={(event) => setForm({ ...form, education: event.target.value })}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Belum diisi</option>
                  {EDUCATION_LEVELS.map((level) => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Pola kerja</span>
                <select
                  value={form.workPattern}
                  onChange={(event) => setForm({ ...form, workPattern: event.target.value })}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Belum diisi</option>
                  {WORK_PATTERNS.map((pattern) => (
                    <option key={pattern} value={pattern}>{pattern}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Jam mengajar per minggu (opsional)</span>
                <input
                  inputMode="numeric"
                  value={form.teachingHoursPerWeek}
                  onChange={(event) => setForm({ ...form, teachingHoursPerWeek: event.target.value })}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Jumlah istri/suami</span>
                <input
                  inputMode="numeric"
                  value={form.spouseCount}
                  onChange={(event) => setForm({ ...form, spouseCount: event.target.value })}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Jumlah anak</span>
                <input
                  inputMode="numeric"
                  value={form.childCount}
                  onChange={(event) => setForm({ ...form, childCount: event.target.value })}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Tanggungan terdaftar BPJS</span>
                <input
                  inputMode="numeric"
                  value={form.registeredDependants}
                  onChange={(event) => setForm({ ...form, registeredDependants: event.target.value })}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Segmen BPJS</span>
                <select
                  value={form.bpjsSegment}
                  onChange={(event) => setForm({ ...form, bpjsSegment: event.target.value })}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                >
                  {BPJS_SEGMENTS.map((segment) => (
                    <option key={segment} value={segment}>{segment}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Bank</span>
                <input
                  value={form.bankName}
                  onChange={(event) => setForm({ ...form, bankName: event.target.value })}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">Nomor rekening</span>
                <input
                  value={form.bankAccountNumber}
                  onChange={(event) => setForm({ ...form, bankAccountNumber: event.target.value })}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </label>
              <label className="text-sm sm:col-span-2">
                <span className="mb-1 block text-muted-foreground">Nama pemilik rekening</span>
                <input
                  value={form.bankAccountName}
                  onChange={(event) => setForm({ ...form, bankAccountName: event.target.value })}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </label>
              <label className="text-sm sm:col-span-2">
                <span className="mb-1 block text-muted-foreground">
                  Alasan berlaku mundur — hanya bila tanggal berlaku menyentuh periode yang sudah dihitung
                </span>
                <input
                  value={form.backdateReason}
                  onChange={(event) => setForm({ ...form, backdateReason: event.target.value })}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy}
              className="mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Buka profil
            </button>
          </section>
        </>
      ) : null}
    </div>
  );
}

/** ENG-LIST-001: employees are picked by searching, never from a dropdown of everyone. */
export function EmploymentPicker({
  label,
  picked,
  onPick,
}: {
  label: string;
  picked: PayrollEmployment | null;
  onPick: (employment: PayrollEmployment | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<PayrollEmployment[]>([]);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setSearching(true);
    setError(null);
    try {
      const outcome = await searchPayrollEmployments({ q: query, pageSize: 10 });
      setMatches(outcome.employments);
      setTotal(outcome.total);
    } catch (cause) {
      setError(errorMessage(cause, "Pencarian pegawai gagal."));
    } finally {
      setSearching(false);
    }
  }

  if (picked) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{label}:</span>
        <span className="font-medium">{picked.fullName} · {picked.employeeNumber}</span>
        <button
          type="button"
          onClick={() => {
            onPick(null);
            setMatches([]);
          }}
          className="rounded-md border px-2 py-1 text-xs"
        >
          Ganti
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error ? <Banner tone="error" text={error} /> : null}
      <div className="flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void search();
            }
          }}
          placeholder="Cari nama atau NIP"
          className="h-9 min-w-56 flex-1 rounded-md border bg-background px-3 text-sm"
        />
        <button
          type="button"
          onClick={() => void search()}
          disabled={searching}
          className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm disabled:opacity-50"
        >
          {searching ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Search className="h-4 w-4" aria-hidden />}
          Cari
        </button>
      </div>
      {matches.length > 0 ? (
        <>
          <ul className="divide-y rounded-md border text-sm">
            {matches.map((employment) => (
              <li key={employment.employmentId}>
                <button
                  type="button"
                  onClick={() => onPick(employment)}
                  className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/50"
                >
                  <span>
                    {employment.fullName} · {employment.employeeNumber}
                    <span className="block text-xs text-muted-foreground">
                      mulai {employment.startedOn}
                      {employment.endedOn ? ` · berakhir ${employment.endedOn}` : ""}
                      {` · ${employment.profileCount} profil`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {total > matches.length ? (
            <p className="text-xs text-muted-foreground">
              {total} pegawai cocok; {matches.length} teratas ditampilkan. Persempit pencarian bila yang dicari belum terlihat.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Banner({ tone, text }: { tone: "error" | "notice"; text: string }) {
  if (tone === "error") {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p>{text}</p>
      </div>
    );
  }
  return <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">{text}</p>;
}

export function AdminPayrollReferencePage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [resolved, setResolved] = useState(false);
  const [tab, setTab] = useState<Tab | null>(null);

  useEffect(() => {
    let active = true;
    void getCurrentSession()
      .then((value) => {
        if (!active) return;
        setSession(value);
        setTab(permittedTabs(value)[0] ?? null);
      })
      .finally(() => {
        if (active) setResolved(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const tabs = permittedTabs(session);

  return (
    <AdminShell
      active="payroll"
      title="Data acuan payroll"
      description="Kebijakan berversi, kasbon, dan profil kompensasi yang dipakai setiap perhitungan periode."
    >
      <div className="space-y-6">
        <nav className="flex flex-wrap gap-2" aria-label="Bagian data acuan">
          {tabs.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={
                "h-9 rounded-md border px-3 text-sm"
                + (tab === key ? " border-primary bg-primary/10 font-medium" : "")
              }
            >
              {TAB_LABELS[key]}
            </button>
          ))}
        </nav>

        {!resolved ? (
          <p className="text-sm text-muted-foreground">Memuat…</p>
        ) : tabs.length === 0 ? (
          <Banner
            tone="notice"
            text="Akun ini tidak memegang satu pun izin data acuan payroll. Kebijakan dibuka oleh Kepala Human Capital, kasbon oleh Keuangan."
          />
        ) : tab === "policies" ? (
          <PolicyPanel />
        ) : tab === "loans" ? (
          <LoanPanel />
        ) : tab === "profiles" ? (
          <ProfilePanel />
        ) : null}
      </div>
    </AdminShell>
  );
}
