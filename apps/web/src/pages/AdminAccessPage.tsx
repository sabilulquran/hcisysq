import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import { Copy, KeyRound, ShieldCheck, UserPlus, UsersRound } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { AdminShell } from "@/layouts/AdminShell";
import {
  AccountActivationApiError,
  issueAccountActivation,
  prepareBoardAccount,
} from "@/lib/accountActivation";
import { AdminApiError } from "@/lib/adminEmployees";
import {
  createRoleAssignment,
  getAccessAdmin,
  removeRoleAssignment,
  updateAccountStatus,
  type AccessAdminResponse,
} from "@/lib/adminOrgAccess";

function statusLabel(status: string) {
  if (status === "active") return "Aktif";
  if (status === "invited") return "Disiapkan";
  if (status === "suspended") return "Ditangguhkan";
  return "Nonaktif";
}

export function AdminAccessPage() {
  const [canPrepareBoard, setCanPrepareBoard] = useState(false);
  useEffect(() => {
    let active = true;
    void getCurrentSession().then((session) => { if (active) setCanPrepareBoard(hasPermission(session, "access.governance.manage")); });
    return () => { active = false; };
  }, []);
  const [data, setData] = useState<AccessAdminResponse | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [scopeType, setScopeType] = useState<"own" | "unit" | "organization">("unit");
  const [unitId, setUnitId] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [reason, setReason] = useState("");
  const [boardEmail, setBoardEmail] = useState("");
  const [activationLink, setActivationLink] = useState<{
    accountId: string;
    url: string;
    expiresAt: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = async () => {
    const result = await getAccessAdmin();
    setData(result);
    if (!selectedAccountId) {
      setSelectedAccountId(
        result.accounts.find((account) => account.principalType === "EMPLOYEE")?.id ?? "",
      );
    }
    if (!roleId) setRoleId(result.roles[0]?.id ?? "");
    if (!unitId) setUnitId(result.units[0]?.id ?? "");
  };

  useEffect(() => {
    let mounted = true;
    void getAccessAdmin()
      .then((result) => {
        if (!mounted) return;
        setData(result);
        setSelectedAccountId(
          result.accounts.find((account) => account.principalType === "EMPLOYEE")?.id ?? "",
        );
        setRoleId(result.roles[0]?.id ?? "");
        setUnitId(result.units[0]?.id ?? "");
      })
      .catch((cause: unknown) => {
        if (!mounted) return;
        setError(cause instanceof AdminApiError ? cause.message : "Data akses tidak dapat dimuat.");
      });
    return () => {
      mounted = false;
    };
  }, []);

  const employeeAccounts = useMemo(
    () => data?.accounts.filter((account) => account.principalType === "EMPLOYEE") ?? [],
    [data],
  );

  const publishActivationLink = async (accountId: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await issueAccountActivation(accountId);
      setActivationLink({
        accountId,
        url: new URL(result.activationPath, window.location.origin).toString(),
        expiresAt: result.expiresAt,
      });
      setNotice("Link aktivasi baru dibuat. Link sebelumnya untuk account ini otomatis tidak berlaku.");
    } catch (cause) {
      setError(
        cause instanceof AccountActivationApiError
          ? cause.message
          : "Link aktivasi gagal dibuat.",
      );
    } finally {
      setBusy(false);
    }
  };

  const submitBoardAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (!boardEmail.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const account = await prepareBoardAccount(boardEmail.trim());
      const activation = await issueAccountActivation(account.id);
      setActivationLink({
        accountId: account.id,
        url: new URL(activation.activationPath, window.location.origin).toString(),
        expiresAt: activation.expiresAt,
      });
      setBoardEmail("");
      setNotice("Account Organ Yayasan disiapkan dan link aktivasi siap dibagikan.");
      await reload();
    } catch (cause) {
      setError(
        cause instanceof AccountActivationApiError
          ? cause.message
          : "Account Organ Yayasan gagal disiapkan.",
      );
    } finally {
      setBusy(false);
    }
  };

  const copyActivationLink = async () => {
    if (!activationLink) return;
    try {
      await navigator.clipboard.writeText(activationLink.url);
      setNotice("Link aktivasi disalin.");
    } catch {
      setNotice("Pilih dan salin link aktivasi secara manual.");
    }
  };

  const submitAssignment = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedAccountId || !roleId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await createRoleAssignment(selectedAccountId, {
        roleId,
        scopeType,
        organizationalUnitId: scopeType === "unit" ? unitId : null,
        startsOn: startsOn || null,
        endsOn: endsOn || null,
        reason: reason.trim() || null,
      });
      setNotice("Role assignment berhasil ditambahkan.");
      setReason("");
      await reload();
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Role assignment gagal disimpan.");
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (
    accountId: string,
    status: "invited" | "active" | "suspended" | "inactive",
  ) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await updateAccountStatus(accountId, status);
      setNotice("Status account berhasil diperbarui.");
      await reload();
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Status account gagal diperbarui.");
    } finally {
      setBusy(false);
    }
  };

  const removeAssignment = async (assignmentId: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await removeRoleAssignment(assignmentId);
      setNotice("Role assignment berhasil dicabut.");
      await reload();
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Role assignment gagal dicabut.");
    } finally {
      setBusy(false);
    }
  };

  const summary = data?.summary ?? {
    accounts: 0,
    active: 0,
    invited: 0,
    unaccountedActiveEmployees: 0,
  };
  const summaryCards = [
    { label: "Semua account", value: summary.accounts, icon: UsersRound },
    { label: "Account aktif", value: summary.active, icon: ShieldCheck },
    { label: "Disiapkan", value: summary.invited, icon: UserPlus },
    {
      label: "Pegawai aktif tanpa account",
      value: summary.unaccountedActiveEmployees,
      icon: KeyRound,
    },
  ];

  return (
    <AdminShell
      active="access"
      title="Account, Role & Scope"
      description="Account type tetap terpisah dari role. Employee aktif memperoleh base self-service setelah account aktif; assignment di bawah hanya untuk akses tambahan."
    >
      {error ? <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div> : null}
      {notice ? <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{notice}</div> : null}

      {activationLink ? (
        <section className="mb-5 rounded-2xl border border-brand-primary/30 bg-brand-primary-pale p-4">
          <p className="text-sm font-bold text-brand-heading">Link aktivasi — tampil sekali di sesi ini</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Berlaku sampai {new Date(activationLink.expiresAt).toLocaleString("id-ID")}. Membuat link baru akan menonaktifkan link sebelumnya.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              readOnly
              value={activationLink.url}
              onFocus={(event) => event.currentTarget.select()}
              className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-white px-3 text-xs"
              aria-label="Link aktivasi"
            />
            <button
              type="button"
              onClick={() => void copyActivationLink()}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-white"
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
              Salin link
            </button>
          </div>
        </section>
      ) : null}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {summaryCards.map(({ label, value, icon: Icon }) => (
          <article key={label} className="rounded-2xl border border-border/70 bg-white p-4 shadow-[var(--shadow-soft)]">
            <Icon className="h-4 w-4 text-brand-primary-deep" aria-hidden="true" />
            <p className="mt-3 text-2xl font-bold text-brand-heading">{value}</p>
            <p className="mt-1 text-xs font-semibold text-muted-foreground">{label}</p>
          </article>
        ))}
      </section>

      {canPrepareBoard ? (
      <section className="mt-5 rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="text-base font-bold text-brand-heading">Account Organ Yayasan</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Account ini terpisah dari employee master dan setelah aktif masuk ke dashboard Organ Yayasan.
        </p>
        <form onSubmit={submitBoardAccount} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            type="email"
            value={boardEmail}
            onChange={(event) => setBoardEmail(event.target.value)}
            placeholder="email@contoh.id"
            className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 text-sm"
          />
          <button
            type="submit"
            disabled={busy || !boardEmail.trim()}
            className="h-10 rounded-xl bg-brand-primary px-4 text-sm font-bold text-white disabled:opacity-50"
          >
            Siapkan account & link aktivasi
          </button>
        </form>
      </section>
      ) : null}

      <section className="mt-5 rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="text-base font-bold text-brand-heading">Tambah role tambahan</h2>
        <p className="mt-1 text-xs text-muted-foreground">Scope unit wajib menunjuk satu unit; scope organization berlaku lintas organisasi sesuai permission role.</p>
        <form onSubmit={submitAssignment} className="mt-4 grid gap-3 lg:grid-cols-3">
          <select
            value={selectedAccountId}
            onChange={(event) => setSelectedAccountId(event.target.value)}
            className="h-10 rounded-xl border border-border bg-surface px-3 text-sm"
          >
            <option value="">Pilih account pegawai</option>
            {employeeAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.employeeName ?? account.email} · {account.unitName ?? "Tanpa unit"}
              </option>
            ))}
          </select>
          <select value={roleId} onChange={(event) => setRoleId(event.target.value)} className="h-10 rounded-xl border border-border bg-surface px-3 text-sm">
            {data?.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
          </select>
          <select value={scopeType} onChange={(event) => setScopeType(event.target.value as typeof scopeType)} className="h-10 rounded-xl border border-border bg-surface px-3 text-sm">
            <option value="unit">Scope unit</option>
            <option value="organization">Scope organisasi</option>
            <option value="own">Scope own</option>
          </select>
          {scopeType === "unit" ? (
            <select value={unitId} onChange={(event) => setUnitId(event.target.value)} className="h-10 rounded-xl border border-border bg-surface px-3 text-sm">
              <option value="">Pilih unit</option>
              {data?.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
            </select>
          ) : <div />}
          <input type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} className="h-10 rounded-xl border border-border bg-surface px-3 text-sm" aria-label="Tanggal mulai assignment" />
          <input type="date" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} className="h-10 rounded-xl border border-border bg-surface px-3 text-sm" aria-label="Tanggal selesai assignment" />
          <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Alasan / mandat (opsional)" className="h-10 rounded-xl border border-border bg-surface px-3 text-sm lg:col-span-2" />
          <button type="submit" disabled={busy || !selectedAccountId || !roleId} className="h-10 rounded-xl bg-brand-primary px-4 text-sm font-bold text-white disabled:opacity-50">
            Tambah assignment
          </button>
        </form>
      </section>

      <section className="mt-5 space-y-3">
        {data?.accounts.map((account) => (
          <article key={account.id} className="rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-bold text-brand-heading">{account.employeeName ?? account.email}</h2>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-700">{account.principalType}</span>
                  <span className="rounded-full bg-brand-primary-pale px-2.5 py-1 text-[11px] font-bold text-brand-primary-deep">{statusLabel(account.status)}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{account.email}{account.employeeNumber ? ` · ${account.employeeNumber}` : ""}{account.unitName ? ` · ${account.unitName}` : ""}</p>
              </div>
              {account.principalType !== "SUPER_ADMIN" ? (
                <div className="flex flex-wrap gap-2">
                  {account.status === "invited" ? (
                    <button
                      type="button"
                      onClick={() => void publishActivationLink(account.id)}
                      disabled={busy}
                      className="h-9 rounded-xl bg-brand-primary px-3 text-xs font-bold text-white disabled:opacity-50"
                    >
                      Buat link aktivasi
                    </button>
                  ) : null}
                  <select
                    value={account.status}
                    onChange={(event) => void changeStatus(account.id, event.target.value as "invited" | "active" | "suspended" | "inactive")}
                    disabled={busy}
                    className="h-9 rounded-xl border border-border bg-surface px-3 text-xs font-semibold"
                  >
                    <option value="invited">Disiapkan</option>
                    <option value="active">Aktif</option>
                    <option value="suspended">Ditangguhkan</option>
                    <option value="inactive">Nonaktif</option>
                  </select>
                </div>
              ) : null}
            </div>

            {account.assignments.length ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {account.assignments.map((assignment) => (
                  <div key={assignment.id} className="flex items-center gap-2 rounded-xl border border-border/70 bg-surface px-3 py-2 text-xs">
                    <span className="font-bold">{assignment.roleName}</span>
                    <span className="text-muted-foreground">· {assignment.scopeType === "unit" ? assignment.organizationalUnitName : assignment.scopeType}</span>
                    <button type="button" onClick={() => void removeAssignment(assignment.id)} disabled={busy} className="ml-1 font-bold text-red-700 disabled:opacity-50">Cabut</button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-xs text-muted-foreground">Tidak ada role tambahan.</p>
            )}
          </article>
        ))}
      </section>

      <section className="mt-5 rounded-2xl border border-border/70 bg-white p-5 shadow-[var(--shadow-soft)]">
        <h2 className="text-base font-bold text-brand-heading">Role system</h2>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {data?.roles.map((role) => (
            <div key={role.id} className="rounded-xl bg-surface p-4">
              <p className="text-sm font-bold">{role.name}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{role.description ?? "—"}</p>
              <p className="mt-2 text-[11px] font-semibold text-brand-primary-deep">{role.permissions.join(" · ") || "Belum ada permission"}</p>
            </div>
          ))}
        </div>
      </section>
    </AdminShell>
  );
}
