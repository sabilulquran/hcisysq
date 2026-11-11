import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AttendanceWorkforceShell } from "@/components/attendance/workforce/AttendanceWorkforceShell";
import {
  createOvertimeEligibilityRule,
  endOvertimeEligibilityRule,
  getOvertimePolicy,
  listOvertimeEligibilityRules,
  searchOvertimeRuleTargets,
  setOvertimePolicy,
  type OvertimeEligibilityRule,
  type OvertimePolicyVersion,
} from "@/lib/workforceAttendance";

// ATT-011-6b-3 Pengaturan > Aturan lembur (§7.7, §7.8): the PP 35/2021 warning thresholds and the
// positions/roles to which overtime does not apply. attendance.policy.manage; the API checks it again.

function todayJakarta() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()); }

export function hoursLabel(minutes: number) {
  const value = Math.round((minutes / 60) * 10) / 10;
  return `${String(value).replace(".", ",")} jam`;
}

export function ruleStateLabel(rule: Pick<OvertimeEligibilityRule, "state" | "effectiveFrom" | "effectiveTo">) {
  if (rule.state === "ended") return `Berakhir ${rule.effectiveTo}`;
  if (rule.state === "scheduled") return `Berlaku mulai ${rule.effectiveFrom}`;
  return rule.effectiveTo ? `Berlaku sampai ${rule.effectiveTo}` : `Berlaku sejak ${rule.effectiveFrom}`;
}

function Notice({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <>
      {error ? <div role="alert" className="mb-4 flex gap-2 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div> : null}
      {notice ? <div role="status" className="mb-4 flex gap-2 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink"><CheckCircle2 className="h-4 w-4 shrink-0" />{notice}</div> : null}
    </>
  );
}

function PolicySection({ onDone }: { onDone: (error: string | null, notice: string | null) => void }) {
  const [current, setCurrent] = useState<OvertimePolicyVersion | null>(null);
  const [history, setHistory] = useState<OvertimePolicyVersion[]>([]);
  const [form, setForm] = useState({ effectiveFrom: todayJakarta(), daily: "4", weekly: "18", reason: "" });
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const result = await getOvertimePolicy();
    setCurrent(result.current);
    setHistory(result.items);
    setForm((value) => ({ ...value, daily: String(result.current.dailyWarningMinutes / 60), weekly: String(result.current.weeklyWarningMinutes / 60) }));
  }, []);
  useEffect(() => { void load().catch((cause) => onDone(cause instanceof Error ? cause.message : "Batas peringatan tidak dapat dimuat.", null)); }, [load, onDone]);
  const daily = Math.round(Number(form.daily.replace(",", ".")) * 60);
  const weekly = Math.round(Number(form.weekly.replace(",", ".")) * 60);
  const valid = daily >= 1 && daily <= 1440 && weekly >= 1 && weekly <= 10080 && form.effectiveFrom >= todayJakarta();
  const save = async () => {
    setBusy(true);
    try {
      await setOvertimePolicy({ effectiveFrom: form.effectiveFrom, dailyWarningMinutes: daily, weeklyWarningMinutes: weekly, reason: form.reason.trim() || null });
      await load();
      onDone(null, "Batas peringatan disimpan.");
    } catch (cause) {
      onDone(cause instanceof Error ? cause.message : "Batas peringatan gagal disimpan.", null);
    } finally { setBusy(false); }
  };
  return (
    <section aria-labelledby="overtime-policy-title" className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
      <h2 id="overtime-policy-title" className="font-bold text-brand-heading">Peringatan batas PP 35/2021</h2>
      <p className="mt-1 text-xs text-muted-foreground">Peringatan muncul bila lembur disetujui + menunggu seorang pegawai melewati batas ini. Peringatan tidak menghalangi pengajuan atau persetujuan.</p>
      {current ? (
        <p className="mt-3 text-sm">
          Berlaku hari ini: <strong>{hoursLabel(current.dailyWarningMinutes)} per hari</strong> dan <strong>{hoursLabel(current.weeklyWarningMinutes)} per minggu</strong>
          {current.source === "default" ? <span className="text-muted-foreground"> (nilai awal, belum pernah diubah)</span> : current.effectiveFrom ? <span className="text-muted-foreground"> (sejak {current.effectiveFrom})</span> : null}
        </p>
      ) : null}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="text-xs font-semibold text-muted-foreground">Berlaku mulai<input type="date" min={todayJakarta()} className="mt-1 h-11 w-full rounded-xl border px-3 text-sm" value={form.effectiveFrom} onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })} /></label>
        <label className="text-xs font-semibold text-muted-foreground">Batas per hari (jam)<input inputMode="decimal" className="mt-1 h-11 w-full rounded-xl border px-3 text-sm" value={form.daily} onChange={(event) => setForm({ ...form, daily: event.target.value })} /></label>
        <label className="text-xs font-semibold text-muted-foreground">Batas per minggu (jam)<input inputMode="decimal" className="mt-1 h-11 w-full rounded-xl border px-3 text-sm" value={form.weekly} onChange={(event) => setForm({ ...form, weekly: event.target.value })} /></label>
        <label className="text-xs font-semibold text-muted-foreground">Keterangan (opsional)<input className="mt-1 h-11 w-full rounded-xl border px-3 text-sm" value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} /></label>
      </div>
      <button type="button" disabled={busy || !valid} onClick={() => void save()} className="mt-3 inline-flex h-10 items-center rounded-xl bg-brand-primary px-4 text-xs font-bold text-brand-foreground disabled:opacity-50">Simpan batas</button>
      {history.length ? (
        <details className="mt-4 text-xs">
          <summary className="cursor-pointer font-semibold text-muted-foreground">Riwayat perubahan</summary>
          <ul className="mt-2 divide-y rounded-xl border">
            {history.map((item) => <li key={item.id ?? item.effectiveFrom} className="p-2">Mulai {item.effectiveFrom}: {hoursLabel(item.dailyWarningMinutes)}/hari, {hoursLabel(item.weeklyWarningMinutes)}/minggu{item.createdByName ? ` · ${item.createdByName}` : ""}{item.reason ? ` · ${item.reason}` : ""}</li>)}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function RuleForm({ onSaved, onError }: { onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const [kind, setKind] = useState<"position" | "role">("position");
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Array<{ key: string; label: string; detail: string }>>([]);
  const [target, setTarget] = useState<{ key: string; label: string; detail: string } | null>(null);
  const [reasonLabel, setReasonLabel] = useState("Direktur — tidak menerima upah lembur");
  const [effectiveFrom, setEffectiveFrom] = useState(todayJakarta());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (target) return undefined;
    const timer = setTimeout(() => { void searchOvertimeRuleTargets(kind, query).then((result) => setOptions(result.items)).catch(() => setOptions([])); }, 250);
    return () => clearTimeout(timer);
  }, [kind, query, target]);
  const save = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await createOvertimeEligibilityRule({ targetKind: kind, targetRef: target.key, reasonLabel: reasonLabel.trim(), effectiveFrom });
      setTarget(null); setQuery("");
      await onSaved();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Aturan gagal disimpan.");
    } finally { setBusy(false); }
  };
  return (
    <div className="mt-4 rounded-xl border p-4">
      <h3 className="text-sm font-semibold">Tambah aturan</h3>
      <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Berlaku untuk">
        {(["position", "role"] as const).map((value) => (
          <button key={value} type="button" role="radio" aria-checked={kind === value} onClick={() => { setKind(value); setTarget(null); setQuery(""); }}
            className={`min-h-10 rounded-full border px-4 text-xs font-bold ${kind === value ? "bg-brand-primary-pale text-brand-primary-deep" : "text-muted-foreground"}`}>{value === "position" ? "Jabatan" : "Peran akses"}</button>
        ))}
      </div>
      {target ? (
        <div className="mt-3 flex items-start justify-between gap-2 rounded-xl bg-surface p-3 text-sm">
          <div><p className="font-semibold">{target.label}</p>{target.detail ? <p className="text-xs text-muted-foreground">{target.detail}</p> : null}</div>
          <button type="button" className="text-xs font-bold text-brand-primary" onClick={() => setTarget(null)}>Ganti</button>
        </div>
      ) : (
        <>
          <label className="mt-3 block text-xs font-semibold text-muted-foreground">{kind === "position" ? "Cari jabatan (nama atau unit)" : "Cari peran"}
            <input className="mt-1 h-11 w-full rounded-xl border px-3 text-sm" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={kind === "position" ? "Mis. Direktur" : "Nama peran"} />
          </label>
          <ul className="mt-2 max-h-48 overflow-y-auto rounded-xl border">
            {options.map((option) => (
              <li key={option.key}><button type="button" className="min-h-11 w-full px-3 py-2 text-left text-sm hover:bg-surface" onClick={() => setTarget(option)}>{option.label}{option.detail ? <span className="block text-xs text-muted-foreground">{option.detail}</span> : null}</button></li>
            ))}
            {options.length === 0 ? <li className="p-3 text-xs text-muted-foreground">{kind === "position" ? "Tidak ada jabatan aktif yang cocok pada struktur yang berlaku." : "Tidak ada peran yang cocok."}</li> : null}
          </ul>
        </>
      )}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-muted-foreground">Alasan (tampil ke pegawai)<input className="mt-1 h-11 w-full rounded-xl border px-3 text-sm" value={reasonLabel} onChange={(event) => setReasonLabel(event.target.value)} /></label>
        <label className="text-xs font-semibold text-muted-foreground">Berlaku mulai<input type="date" min={todayJakarta()} className="mt-1 h-11 w-full rounded-xl border px-3 text-sm" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></label>
      </div>
      <button type="button" disabled={busy || !target || reasonLabel.trim().length < 3 || effectiveFrom < todayJakarta()} onClick={() => void save()}
        className="mt-3 inline-flex h-10 items-center gap-1 rounded-xl bg-brand-primary px-4 text-xs font-bold text-brand-foreground disabled:opacity-50"><Plus className="h-4 w-4" /> Simpan aturan</button>
    </div>
  );
}

function EndRule({ rule, onEnded, onError }: { rule: OvertimeEligibilityRule; onEnded: () => Promise<void>; onError: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  if (rule.state === "ended" || rule.effectiveTo) return null;
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="min-h-10 rounded-xl border px-3 text-xs font-bold">Akhiri aturan</button>;
  return (
    <div className="grid gap-2 sm:min-w-[260px]">
      <input className="h-10 rounded-xl border px-3 text-xs" placeholder="Alasan (wajib)" value={reason} onChange={(event) => setReason(event.target.value)} />
      <p className="text-[11px] text-muted-foreground">Lembur dihitung lagi mulai hari ini. Aturan tidak dihapus, tetap tercatat di riwayat.</p>
      <div className="flex gap-2">
        <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void (async () => {
          setBusy(true);
          try { await endOvertimeEligibilityRule(rule.id, { reason: reason.trim() }); await onEnded(); }
          catch (cause) { onError(cause instanceof Error ? cause.message : "Aturan gagal diakhiri."); }
          finally { setBusy(false); }
        })()} className="min-h-10 rounded-xl bg-brand-primary px-3 text-xs font-bold text-brand-foreground disabled:opacity-50">Akhiri</button>
        <button type="button" onClick={() => setOpen(false)} className="min-h-10 rounded-xl border px-3 text-xs font-bold">Batal</button>
      </div>
    </div>
  );
}

export function AdminAttendanceOvertimeRulesPage() {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<"current" | "ended">("current");
  const [page, setPage] = useState(1);
  const [rules, setRules] = useState<Awaited<ReturnType<typeof listOvertimeEligibilityRules>> | null>(null);
  const report = useCallback((nextError: string | null, nextNotice: string | null) => { setError(nextError); setNotice(nextNotice); }, []);
  const load = useCallback(async () => setRules(await listOvertimeEligibilityRules(status, page)), [status, page]);
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Aturan lembur tidak dapat dimuat.")); }, [load]);

  return (
    <AttendanceWorkforceShell tab="overtimeRules" title="Aturan lembur" description="Batas peringatan PP 35/2021 dan jabatan atau peran yang tidak berhak lembur. Perubahan tercatat dan berlaku mulai tanggal yang dipilih.">
      <Notice error={error} notice={notice} />
      <div className="grid gap-5">
        <PolicySection onDone={report} />
        <section aria-labelledby="overtime-rules-title" className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="overtime-rules-title" className="font-bold text-brand-heading">Lembur tidak berlaku</h2>
              <p className="mt-1 max-w-2xl text-xs text-muted-foreground">Pegawai yang memegang jabatan atau peran ini (termasuk pelaksana tugas) tidak dapat mengajukan atau diperintahkan lembur, dan tidak tampil di laporan lembur pada tanggal aturan berlaku. Aturan menunjuk jabatan, bukan nama orang.</p>
            </div>
            <nav className="flex gap-2" role="tablist" aria-label="Status aturan">
              {(["current", "ended"] as const).map((value) => (
                <button key={value} type="button" role="tab" aria-selected={status === value} onClick={() => { setStatus(value); setPage(1); }}
                  className={`min-h-10 rounded-full border px-3 text-xs font-bold ${status === value ? "bg-brand-primary-pale text-brand-primary-deep" : "text-muted-foreground"}`}>{value === "current" ? "Berlaku" : "Berakhir"}</button>
              ))}
            </nav>
          </div>
          {status === "current" ? <RuleForm onError={(message) => report(message, null)} onSaved={async () => { await load(); report(null, "Aturan lembur disimpan."); }} /> : null}
          <ul className="mt-4 grid gap-3">
            {rules?.items.map((rule) => (
              <li key={rule.id} className="flex flex-col gap-3 rounded-xl border p-4 text-sm sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="font-semibold">{rule.targetLabel}</p>
                  <p className="text-xs text-muted-foreground">{rule.targetKind === "position" ? "Jabatan" : "Peran akses"} · {ruleStateLabel(rule)}</p>
                  <p className="mt-1 text-xs">{rule.reasonLabel}</p>
                  {rule.targetActive === false ? <p className="mt-1 text-xs font-semibold text-warning-ink">Jabatan ini tidak aktif lagi pada struktur yang berlaku. Periksa apakah aturan perlu dipindahkan ke jabatan baru.</p> : null}
                  {rule.endReason ? <p className="mt-1 text-xs text-muted-foreground">Diakhiri: {rule.endReason}</p> : null}
                </div>
                <EndRule rule={rule} onError={(message) => report(message, null)} onEnded={async () => { await load(); report(null, "Aturan diakhiri."); }} />
              </li>
            ))}
            {rules && rules.items.length === 0 ? <li className="rounded-xl border p-6 text-center text-sm text-muted-foreground">{status === "current" ? "Belum ada aturan. Tambahkan jabatan Direktur agar lembur tidak berlaku untuknya." : "Belum ada aturan yang berakhir."}</li> : null}
            {!rules && !error ? <li className="p-6 text-sm text-muted-foreground">Memuat…</li> : null}
          </ul>
          {rules && rules.pageCount > 1 ? (
            <footer className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>{rules.total} aturan · halaman {page} dari {rules.pageCount}</span>
              <div className="flex gap-2">
                <button type="button" aria-label="Halaman sebelumnya" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-lg border p-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
                <button type="button" aria-label="Halaman berikutnya" disabled={page >= rules.pageCount} onClick={() => setPage(page + 1)} className="rounded-lg border p-1.5 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
              </div>
            </footer>
          ) : null}
        </section>
      </div>
    </AttendanceWorkforceShell>
  );
}
