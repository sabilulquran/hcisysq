// REWARD-001 Penghargaan (pegawai): recipients of published rounds, one's own awards with the
// certificate, and the way into the Al-Qur'an application. Spec: docs/domain/rewards.md §9.
// Reading data stays in the Al-Qur'an application; HCIS only links to it.

import { Award as AwardIcon, BookOpen, Download, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { AppShell } from "@/layouts/AppShell";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";
import {
  certificateHref,
  getMyAwards,
  getRecipients,
  type MyAward,
  type Pagination,
  type Recipient,
} from "@/lib/rewards";
import { QURAN_APP_URL } from "@/lib/sqCore";

export function QuranLinkCard() {
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
      <div className="flex items-start gap-3">
        <BookOpen className="mt-0.5 h-5 w-5 text-brand-primary" aria-hidden="true" />
        <div>
          <p className="font-bold text-brand-heading">Baca Al-Qur&apos;an</p>
          <p className="text-sm text-muted-foreground">Membaca, menandai bacaan, dan papan skor ada di aplikasi Al-Qur&apos;an.</p>
        </div>
      </div>
      <a href={QURAN_APP_URL} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground">
        Buka Al-Qur&apos;an<ExternalLink className="h-4 w-4" aria-hidden="true" />
      </a>
    </div>
  );
}

export function MyAwardsList({ items }: { items: MyAward[] }) {
  if (!items.length) {
    return <p className="rounded-2xl border border-border/75 bg-surface p-4 text-sm text-muted-foreground">Anda belum menerima penghargaan.</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((award) => (
        <li key={award.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/75 bg-surface-raised p-4">
          <span>
            <span className="block font-bold text-brand-heading">{award.categoryLabel}</span>
            <span className="block text-xs text-muted-foreground">
              {award.monthLabel}{award.status === "REVOKED" ? ` · Dicabut: ${award.revokeReason}` : ""}
            </span>
          </span>
          {award.status === "ACTIVE" && award.certificateReady ? (
            <a href={certificateHref(award.id)} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading">
              <Download className="h-4 w-4" aria-hidden="true" />Sertifikat
            </a>
          ) : award.status === "ACTIVE" ? (
            <span className="text-xs text-muted-foreground">Sertifikat sedang disiapkan</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function RecipientsList({ items }: { items: Recipient[] }) {
  if (!items.length) {
    return (
      <div className="rounded-2xl border border-border/75 bg-surface p-8 text-center text-sm text-muted-foreground">
        <AwardIcon className="mx-auto h-8 w-8" aria-hidden="true" />
        <p className="mt-2">Belum ada penerima penghargaan yang diumumkan.</p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border/70">
      {items.map((recipient) => (
        <li key={recipient.id} className="px-4 py-3">
          <span className="block font-semibold text-brand-heading">{recipient.recipientName}</span>
          <span className="block text-xs text-muted-foreground">
            {recipient.categoryLabel} · {recipient.monthLabel}{recipient.unitName ? ` · ${recipient.unitName}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function EmployeeRewardsPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [mine, setMine] = useState<MyAward[]>([]);
  const [minePaging, setMinePaging] = useState<Pagination | null>(null);
  const [minePage, setMinePage] = useState(1);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [month, setMonth] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const user = useMemo(() => employeeShellUser(employee), [employee]);

  useEffect(() => {
    void getEmployeeLeaveSummary().then((summary) => setEmployee(summary.employee)).catch(() => setEmployee(null));
  }, []);
  useEffect(() => {
    void getMyAwards(minePage).then((result) => { setMine(result.items); setMinePaging(result.pagination); }).catch(() => setMine([]));
  }, [minePage]);
  useEffect(() => {
    setLoading(true);
    getRecipients({ page, month: month || undefined })
      .then((result) => { setRecipients(result.items); setPaging(result.pagination); setError(null); })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Daftar penerima tidak dapat dimuat."))
      .finally(() => setLoading(false));
  }, [page, month]);

  return (
    <AppShell user={user} activeItem="Semua Layanan">
      <section className="mx-auto max-w-3xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Kinerja &amp; Pengembangan</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Penghargaan</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Penghargaan bulanan bagi pegawai yang paling istiqamah membaca Al-Qur&apos;an, ditetapkan Kepala HCM dari papan skor aplikasi Al-Qur&apos;an.
          Penghargaan ini tidak memengaruhi penilaian kinerja atau gaji.
        </p>
        <QuranLinkCard />

        <h2 className="mt-8 text-lg font-bold text-brand-heading">Riwayat saya</h2>
        <div className="mt-3"><MyAwardsList items={mine} /></div>
        {minePaging && minePaging.total > minePaging.pageSize ? (
          <PaginationBar page={minePaging.page} pageSize={minePaging.pageSize} total={minePaging.total} onPageChange={setMinePage} />
        ) : null}

        <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-lg font-bold text-brand-heading">Penerima</h2>
          <label className="text-xs font-semibold text-muted-foreground">Bulan
            <input type="month" value={month} onChange={(event) => { setPage(1); setMonth(event.target.value); }}
              className="mt-1 h-11 rounded-xl border bg-surface px-3 text-sm text-foreground" />
          </label>
        </div>
        {error ? <div role="alert" className="mt-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
        <div className="mt-3 overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
          {loading ? (
            <div className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat penerima...</div>
          ) : <RecipientsList items={recipients} />}
          {paging && paging.total > 0 ? (
            <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={setPage} />
          ) : null}
        </div>
      </section>
    </AppShell>
  );
}
