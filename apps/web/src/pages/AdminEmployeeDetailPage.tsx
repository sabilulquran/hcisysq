import { ArrowLeft, Copy, Network, ShieldCheck, UserRoundCheck } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { EmploymentActionDialog } from "@/components/employment/EmploymentActionDialog";
import {
  EmploymentActionButtons,
  EmploymentContractPanel,
  PlacementCareerPanel,
} from "@/components/employment/EmploymentPanels";
import type { EmploymentActionType } from "@/lib/employment-actions";
import { AdminShell } from "@/layouts/AdminShell";
import {
  AccountActivationApiError,
  issueAccountActivation,
} from "@/lib/accountActivation";
import { AdminApiError } from "@/lib/adminEmployees";
import {
  getEmployeeDetail,
  prepareEmployeeAccount,
  updateDirectManager,
  updateEmployeeContact,
  type EmployeeDetailResponse,
} from "@/lib/adminOrgAccess";
import { getCurrentSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authorization";
import {
  getEmployeeEmployment,
  getEmployeeEmploymentTimeline,
  viewFromError,
  type EmploymentSummary,
  type EmploymentTimelineItem,
  type EmploymentView,
} from "@/lib/employment";

export type EmployeeDetailTab = "ringkasan" | "kepegawaian" | "penempatan";

const TABS: Array<{ key: EmployeeDetailTab; label: string }> = [
  { key: "ringkasan", label: "Ringkasan" },
  { key: "kepegawaian", label: "Kepegawaian & Kontrak" },
  { key: "penempatan", label: "Penempatan & Karier" },
];

/** Tab bar; employment tabs appear only for employment.read (the API still authorizes). */
export function EmployeeDetailTabs({ active, canReadEmployment, onSelect }: {
  active: EmployeeDetailTab;
  canReadEmployment: boolean;
  onSelect: (tab: EmployeeDetailTab) => void;
}) {
  if (!canReadEmployment) return null;
  return (
    <div role="tablist" aria-label="Bagian detail pegawai" className="mb-5 flex gap-1 overflow-x-auto rounded-2xl border border-border/70 bg-surface p-1">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          onClick={() => onSelect(tab.key)}
          className={`shrink-0 rounded-xl px-4 py-2 text-sm font-bold ${active === tab.key ? "bg-surface-raised text-brand-primary-deep shadow-[var(--shadow-soft)]" : "text-muted-foreground"}`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function accountStatusLabel(status: string | null) {
  if (status === "active") return "Aktif";
  if (status === "invited") return "Menunggu aktivasi";
  if (status === "suspended") return "Ditangguhkan";
  if (status === "inactive") return "Nonaktif";
  return "Belum ada account";
}

export function AdminEmployeeDetailPage({ employeeId }: { employeeId: string }) {
  const [data, setData] = useState<EmployeeDetailResponse | null>(null);
  const [managerId, setManagerId] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [activationLink, setActivationLink] = useState<{
    url: string;
    expiresAt: string;
  } | null>(null);
  const [savingContact, setSavingContact] = useState(false);
  const [savingManager, setSavingManager] = useState(false);
  const [preparingAccount, setPreparingAccount] = useState(false);
  const [issuingActivation, setIssuingActivation] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<EmployeeDetailTab>("ringkasan");
  const [canReadEmployment, setCanReadEmployment] = useState(false);
  const [canManageEmployment, setCanManageEmployment] = useState(false);
  const [employmentAction, setEmploymentAction] = useState<EmploymentActionType | null>(null);
  const [employmentView, setEmploymentView] = useState<EmploymentView<EmploymentSummary> | null>(null);
  const [timelineView, setTimelineView] = useState<EmploymentView<EmploymentTimelineItem[]>>({ kind: "loading" });

  useEffect(() => {
    let mounted = true;
    void getCurrentSession().then((session) => {
      if (!mounted) return;
      setCanReadEmployment(hasPermission(session, "employment.read"));
      setCanManageEmployment(hasPermission(session, "employment.manage"));
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (tab === "ringkasan" || employmentView !== null) return;
    setEmploymentView({ kind: "loading" });
    void getEmployeeEmployment(employeeId)
      .then((data) => setEmploymentView({ kind: "ready", data }))
      .catch((cause: unknown) => setEmploymentView(viewFromError(cause)));
    void getEmployeeEmploymentTimeline(employeeId)
      .then((data) => setTimelineView({ kind: "ready", data: data.items }))
      .catch((cause: unknown) => setTimelineView(viewFromError(cause)));
  }, [tab, employmentView, employeeId]);

  const applyResult = (result: EmployeeDetailResponse) => {
    setData(result);
    setManagerId(result.employee.managerEmployeeId ?? "");
    setAccountEmail(result.employee.accountEmail ?? result.employee.email ?? "");
    setContactEmail(result.employee.email ?? "");
    setContactPhone(result.employee.phone ?? "");
  };

  const reload = async () => {
    applyResult(await getEmployeeDetail(employeeId));
  };

  useEffect(() => {
    let mounted = true;
    void getEmployeeDetail(employeeId)
      .then((result) => {
        if (!mounted) return;
        applyResult(result);
      })
      .catch((cause: unknown) => {
        if (!mounted) return;
        setError(
          cause instanceof AdminApiError ? cause.message : "Detail pegawai tidak dapat dimuat.",
        );
      });
    return () => {
      mounted = false;
    };
  }, [employeeId]);

  const saveContact = async (event: FormEvent) => {
    event.preventDefault();
    setSavingContact(true);
    setError(null);
    setNotice(null);
    try {
      await updateEmployeeContact(employeeId, {
        email: contactEmail.trim() ? contactEmail.trim() : null,
        phone: contactPhone.trim() ? contactPhone.trim() : null,
      });
      setNotice("Kontak employee master berhasil diperbarui. Email account login, bila sudah ada, tidak diubah otomatis.");
      await reload();
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Kontak pegawai gagal diperbarui.");
    } finally {
      setSavingContact(false);
    }
  };

  const saveManager = async (event: FormEvent) => {
    event.preventDefault();
    setSavingManager(true);
    setError(null);
    setNotice(null);
    try {
      await updateDirectManager(employeeId, managerId || null);
      setNotice("Atasan langsung berhasil diperbarui.");
      await reload();
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Atasan langsung gagal diperbarui.");
    } finally {
      setSavingManager(false);
    }
  };

  const issueActivation = async (accountId: string) => {
    setIssuingActivation(true);
    setError(null);
    setNotice(null);
    try {
      const result = await issueAccountActivation(accountId);
      setActivationLink({
        url: new URL(result.activationPath, window.location.origin).toString(),
        expiresAt: result.expiresAt,
      });
      setNotice("Link aktivasi siap dibagikan. Link sebelumnya untuk account ini otomatis tidak berlaku.");
    } catch (cause) {
      setError(
        cause instanceof AccountActivationApiError
          ? cause.message
          : "Link aktivasi gagal dibuat.",
      );
    } finally {
      setIssuingActivation(false);
    }
  };

  const prepareAccount = async () => {
    setPreparingAccount(true);
    setError(null);
    setNotice(null);
    try {
      const account = await prepareEmployeeAccount({
        employeeId,
        ...(accountEmail.trim() ? { email: accountEmail.trim() } : {}),
      });
      const activation = await issueAccountActivation(account.id);
      setActivationLink({
        url: new URL(activation.activationPath, window.location.origin).toString(),
        expiresAt: activation.expiresAt,
      });
      setNotice("Account pegawai disiapkan dan link aktivasi siap dibagikan.");
      await reload();
    } catch (cause) {
      if (cause instanceof AccountActivationApiError || cause instanceof AdminApiError) {
        setError(cause.message);
      } else {
        setError("Account pegawai gagal disiapkan.");
      }
    } finally {
      setPreparingAccount(false);
    }
  };

  const copyActivation = async () => {
    if (!activationLink) return;
    try {
      await navigator.clipboard.writeText(activationLink.url);
      setNotice("Link aktivasi disalin.");
    } catch {
      setNotice("Pilih dan salin link aktivasi secara manual.");
    }
  };

  const employee = data?.employee;

  return (
    <AdminShell
      active="employees"
      title={employee?.fullName ?? "Detail Pegawai"}
      description={employee ? `${employee.employeeNumber} · ${employee.unitName ?? "Tanpa unit"} · ${employee.positionName ?? "Tanpa jabatan"}` : "Memuat employee master..."}
    >
      <a href="/admin/employees" className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-brand-primary-deep">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Kembali ke daftar pegawai
      </a>

      {error ? <div className="mb-4 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
      {notice ? <div className="mb-4 rounded-2xl border border-success-line bg-success-soft p-4 text-sm text-success-ink">{notice}</div> : null}

      {activationLink ? (
        <section className="mb-5 rounded-2xl border border-brand-primary/30 bg-brand-primary-pale p-4">
          <p className="text-sm font-bold text-brand-heading">Link aktivasi</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Berlaku sampai {new Date(activationLink.expiresAt).toLocaleString("id-ID")}. Link hanya ditampilkan pada sesi halaman ini.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              readOnly
              value={activationLink.url}
              onFocus={(event) => event.currentTarget.select()}
              className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-surface-raised px-3 text-xs"
              aria-label="Link aktivasi"
            />
            <button
              type="button"
              onClick={() => void copyActivation()}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground"
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
              Salin link
            </button>
          </div>
        </section>
      ) : null}

      <EmployeeDetailTabs active={tab} canReadEmployment={canReadEmployment} onSelect={setTab} />

      {tab === "kepegawaian" ? (
        <EmploymentContractPanel
          view={employmentView ?? { kind: "loading" }}
          actions={
            employmentView?.kind === "ready" ? (
              <EmploymentActionButtons
                mode={employmentView.data.mode}
                state={employmentView.data.state}
                canManage={canManageEmployment}
                onStart={setEmploymentAction}
              />
            ) : null
          }
        />
      ) : null}
      {employmentAction ? (
        <EmploymentActionDialog
          employeeId={employeeId}
          employeeName={employee?.fullName ?? "Pegawai"}
          actionType={employmentAction}
          onClose={() => setEmploymentAction(null)}
          onRecorded={(message) => {
            setEmploymentAction(null);
            setNotice(message);
            // Reload the derived state: the action moved it.
            setEmploymentView(null);
            setTimelineView({ kind: "loading" });
          }}
        />
      ) : null}
      {tab === "penempatan" ? (
        <PlacementCareerPanel
          view={employmentView ?? { kind: "loading" }}
          timeline={timelineView}
          actions={
            employmentView?.kind === "ready" ? (
              <EmploymentActionButtons
                mode={employmentView.data.mode}
                state={employmentView.data.state}
                canManage={canManageEmployment}
                group="career"
                hasPrimaryPlacement={employmentView.data.current.primaryPlacement !== null}
                onStart={setEmploymentAction}
              />
            ) : null
          }
        />
      ) : null}

      {tab === "ringkasan" ? (<>
      <section className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <article className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
          <div className="flex items-center gap-3">
            <UserRoundCheck className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
            <h2 className="text-base font-bold text-brand-heading">Employee master</h2>
          </div>
          <dl className="mt-5 grid gap-x-5 gap-y-4 sm:grid-cols-2">
            {[
              ["Status", employee?.status ?? "—"],
              ["Status kepegawaian", employee?.employmentStatus ?? "—"],
              ["Unit", employee?.unitName ?? "—"],
              ["Jabatan", employee?.positionName ?? "—"],
              ["Pendidikan", employee?.education ?? "—"],
              ["TMT", employee?.startedOn ?? "—"],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-sm font-semibold text-foreground">{value}</dd>
              </div>
            ))}
          </dl>

          <form onSubmit={saveContact} className="mt-5 rounded-2xl border border-border/70 bg-surface p-4">
            <div>
              <p className="text-sm font-bold text-foreground">Kontak terverifikasi</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Gunakan setelah Admin mengonfirmasi email/nomor HP dengan pegawai. Perubahan ini tidak mengubah email account login yang sudah terpisah.
              </p>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-muted-foreground">
                Email
                <input
                  type="email"
                  value={contactEmail}
                  onChange={(event) => setContactEmail(event.target.value)}
                  placeholder="pegawai@contoh.id"
                  className="mt-1 h-10 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm text-foreground outline-none focus:border-brand-primary"
                />
              </label>
              <label className="text-xs font-semibold text-muted-foreground">
                Nomor HP
                <input
                  value={contactPhone}
                  onChange={(event) => setContactPhone(event.target.value)}
                  placeholder="08xxxxxxxxxx"
                  className="mt-1 h-10 w-full rounded-xl border border-border bg-surface-raised px-3 text-sm text-foreground outline-none focus:border-brand-primary"
                />
              </label>
            </div>
            <button
              type="submit"
              disabled={savingContact || !employee}
              className="mt-3 h-10 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50"
            >
              {savingContact ? "Menyimpan..." : "Simpan kontak"}
            </button>
          </form>
        </article>

        <article className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
          <div className="flex items-center gap-3">
            <Network className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
            <h2 className="text-base font-bold text-brand-heading">Reporting line</h2>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Atasan langsung ini nanti menjadi input resolver approval. Siklus reporting line ditolak oleh backend.
          </p>
          <form onSubmit={saveManager} className="mt-4 space-y-3">
            <select
              value={managerId}
              onChange={(event) => setManagerId(event.target.value)}
              className="h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm outline-none focus:border-brand-primary"
            >
              <option value="">Belum ditetapkan</option>
              {data?.managerCandidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.fullName} · {candidate.employeeNumber} · {candidate.unitName ?? "Tanpa unit"}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={savingManager || !employee}
              className="h-10 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50"
            >
              {savingManager ? "Menyimpan..." : "Simpan atasan langsung"}
            </button>
          </form>
        </article>
      </section>

      <section className="mt-5 grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
        <article className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-brand-primary-deep" aria-hidden="true" />
            <h2 className="text-base font-bold text-brand-heading">Account akses</h2>
          </div>
          <p className="mt-3 text-sm font-semibold">{accountStatusLabel(employee?.accountStatus ?? null)}</p>
          {employee?.accountId ? (
            <>
              <p className="mt-1 break-all text-sm text-muted-foreground">{employee.accountEmail}</p>
              {employee.accountStatus === "invited" ? (
                <button
                  type="button"
                  onClick={() => void issueActivation(employee.accountId!)}
                  disabled={issuingActivation}
                  className="mt-4 h-10 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50"
                >
                  {issuingActivation ? "Membuat link..." : "Buat link aktivasi"}
                </button>
              ) : null}
              <a href="/admin/access" className="mt-4 block text-sm font-semibold text-brand-primary-deep">
                Kelola role & scope →
              </a>
            </>
          ) : (
            <div className="mt-4 space-y-3">
              <input
                value={accountEmail}
                onChange={(event) => setAccountEmail(event.target.value)}
                placeholder="email@contoh.id"
                type="email"
                className="h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm outline-none focus:border-brand-primary"
              />
              <button
                type="button"
                onClick={() => void prepareAccount()}
                disabled={preparingAccount || employee?.status !== "active"}
                className="h-10 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50"
              >
                {preparingAccount ? "Menyiapkan..." : "Siapkan account & link aktivasi"}
              </button>
              <p className="text-xs leading-5 text-muted-foreground">
                Account dibuat sebagai <strong>invited</strong>. Link aktivasi berlaku 24 jam dan password dibuat langsung oleh pegawai.
              </p>
            </div>
          )}
        </article>

        <article className="rounded-2xl border border-border/70 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
          <h2 className="text-base font-bold text-brand-heading">Role tambahan</h2>
          <p className="mt-1 text-xs text-muted-foreground">Base employee self-service tidak ditampilkan sebagai role; hanya assignment tambahan yang tercatat di sini.</p>
          <div className="mt-4 space-y-3">
            {data?.assignments.length ? data.assignments.map((assignment) => (
              <div key={assignment.id} className="rounded-xl border border-border/70 bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-bold">{assignment.roleName}</p>
                  <span className="rounded-full bg-brand-primary-pale px-2.5 py-1 text-xs font-bold text-brand-primary-deep">
                    {assignment.scopeType === "unit" ? assignment.organizationalUnitName : assignment.scopeType}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {assignment.startsOn ?? "mulai sekarang"} → {assignment.endsOn ?? "tanpa batas akhir"}
                  {assignment.reason ? ` · ${assignment.reason}` : ""}
                </p>
              </div>
            )) : (
              <p className="rounded-xl bg-surface p-4 text-sm text-muted-foreground">Belum ada role tambahan.</p>
            )}
          </div>
        </article>
      </section>
      </>) : null}
    </AdminShell>
  );
}
