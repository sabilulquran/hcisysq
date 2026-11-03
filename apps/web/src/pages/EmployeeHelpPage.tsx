// HELP-001 employee surface: read and search FAQs and guides, and find the HC contacts.
// Spec: docs/domain/help-center.md §10.

import { ArrowRight, ChevronDown, LifeBuoy, Loader2, Mail, MapPin, MessageCircle, Phone, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { AppShell } from "@/layouts/AppShell";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";
import {
  channelLabel,
  contactHref,
  getHelpOverview,
  helpTopics,
  listHelpArticles,
  paragraphs,
  topicHref,
  topicLabel,
  type HelpArticle,
  type HelpContact,
  type HelpOverview,
  type HelpTopic,
  type Pagination,
} from "@/lib/help";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;

function ArticleBody({ body }: { body: string }) {
  // D-05: plain text with paragraphs, rendered as text, never as HTML.
  return (
    <>
      {paragraphs(body).map((paragraph, index) => (
        <p key={index} className="mt-2 whitespace-pre-line text-sm leading-6 text-brand-heading first:mt-0">{paragraph}</p>
      ))}
    </>
  );
}

const channelIcon = { WHATSAPP: MessageCircle, PHONE: Phone, EMAIL: Mail, OFFICE: MapPin } as const;

function ContactCard({ contacts, failed }: { contacts: HelpContact[]; failed: boolean }) {
  return (
    <section className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
      <h2 className="text-sm font-bold text-brand-heading">Hubungi Human Capital</h2>
      {contacts.length ? (
        <ul className="mt-3 grid gap-3">
          {contacts.map((contact) => {
            const Icon = channelIcon[contact.channel];
            const href = contactHref(contact);
            return (
              <li key={contact.id} className="flex items-start gap-3">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary-deep" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-brand-heading">{contact.label}</p>
                  {href ? (
                    <a href={href} target={contact.channel === "WHATSAPP" ? "_blank" : undefined} rel="noreferrer"
                      className="break-words text-sm font-semibold text-brand-primary-deep underline-offset-2 hover:underline">
                      {channelLabel[contact.channel]}: {contact.value}
                    </a>
                  ) : (
                    <p className="break-words text-sm text-brand-heading">{contact.value}</p>
                  )}
                  {contact.note ? <p className="mt-0.5 text-xs text-muted-foreground">{contact.note}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {failed
            ? "Kontak belum dapat dimuat. Coba muat ulang halaman ini."
            : "Kontak resmi Human Capital belum diisi. Sementara itu, sampaikan pertanyaan Anda kepada atasan langsung atau datangi ruang Human Capital."}
        </p>
      )}
    </section>
  );
}

function FaqItem({ article, open, onToggle, showTopic }: {
  article: HelpArticle; open: boolean; onToggle: () => void; showTopic: boolean;
}) {
  const href = topicHref(article.topic);
  return (
    <li className="py-1">
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex min-h-11 w-full items-start justify-between gap-3 py-2 text-left">
        <span>
          <span className="block text-sm font-bold text-brand-heading">{article.title}</span>
          {showTopic ? (
            <span className="mt-0.5 block text-[11px] font-semibold text-muted-foreground">
              {topicLabel(article.topic)}{article.kind === "GUIDE" ? " · Panduan" : ""}
            </span>
          ) : null}
        </span>
        <ChevronDown className={cn("mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? (
        <div className="mb-3 rounded-2xl bg-surface p-4">
          <ArticleBody body={article.body} />
          {href ? (
            <a href={href} className="mt-3 inline-flex min-h-11 items-center gap-1 text-sm font-bold text-brand-primary-deep">
              Buka layanan {topicLabel(article.topic)} <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function EmployeeHelpPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [overview, setOverview] = useState<HelpOverview | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState<HelpTopic | "">("");
  const [page, setPage] = useState(1);
  const [articles, setArticles] = useState<HelpArticle[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const user = useMemo(() => employeeShellUser(employee), [employee]);
  const searching = query.trim().length >= 2;
  const browsing = !searching && !topic;

  useEffect(() => {
    void Promise.allSettled([getEmployeeLeaveSummary(), getHelpOverview()]).then(([summary, help]) => {
      if (summary.status === "fulfilled") setEmployee(summary.value.employee);
      if (help.status === "fulfilled") {
        setOverview(help.value);
        setOverviewFailed(false);
      } else {
        setOverviewFailed(true);
      }
    });
  }, [attempt]);

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (browsing) {
      setArticles([]);
      setPagination(null);
      return;
    }
    let active = true;
    setLoading(true);
    listHelpArticles({ q: searching ? query : undefined, topic, page, pageSize: PAGE_SIZE })
      .then((result) => {
        if (!active) return;
        setArticles(result.items);
        setPagination(result.pagination);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Artikel bantuan tidak dapat dimuat.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [browsing, searching, query, topic, page, attempt]);

  const chooseTopic = (next: HelpTopic | "") => {
    setTopic(next);
    setPage(1);
    setOpenId(null);
  };

  const counts = new Map(overview?.topics.map((entry) => [entry.topic, entry.faqCount + entry.guideCount]) ?? []);
  const totalPublished = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const guides = searching ? [] : articles.filter((article) => article.kind === "GUIDE");
  const faqs = searching ? articles : articles.filter((article) => article.kind === "FAQ");
  const topicService = topic ? topicHref(topic) : null;

  return (
    <AppShell user={user} activeItem="Bantuan">
      <section className="mx-auto max-w-5xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Bantuan</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Pusat Bantuan</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Panduan singkat dan jawaban atas pertanyaan yang sering diajukan tentang layanan HCIS.
        </p>

        <label className="relative mt-5 block">
          <span className="sr-only">Cari bantuan</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input type="search" value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)}
            placeholder="Cari, misalnya: saldo cuti, lupa clock out, slip gaji"
            className="min-h-12 w-full rounded-2xl border border-border bg-surface-raised pl-10 pr-10 text-sm text-brand-heading shadow-[var(--shadow-soft)]" />
          {search ? (
            <button type="button" onClick={() => setSearch("")} aria-label="Hapus pencarian"
              className="absolute right-2 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-xl text-muted-foreground">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
        </label>
        {search.trim().length === 1 ? <p className="mt-2 text-xs text-muted-foreground">Ketik minimal dua huruf untuk mencari.</p> : null}

        <div className="-mx-4 mt-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" role="group" aria-label="Topik bantuan">
          <div className="flex w-max gap-2 sm:w-auto sm:flex-wrap">
            {[{ topic: "" as const, label: "Semua topik" }, ...helpTopics].map((entry) => (
              <button key={entry.topic || "all"} type="button" aria-pressed={topic === entry.topic}
                onClick={() => chooseTopic(entry.topic)}
                className={cn(
                  "min-h-10 whitespace-nowrap rounded-full border px-3 text-xs font-bold",
                  topic === entry.topic
                    ? "border-brand-primary bg-brand-primary text-brand-foreground"
                    : "border-border bg-surface-raised text-brand-heading",
                )}>
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
            <span>{error}</span>
            <button type="button" onClick={() => setAttempt((value) => value + 1)}
              className="min-h-10 rounded-xl border border-danger-line px-3 text-sm font-bold">Coba lagi</button>
          </div>
        ) : null}

        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0">
            {browsing ? (
              overview === null && !overviewFailed ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat Pusat Bantuan...</div>
              ) : totalPublished === 0 ? (
                <div className="rounded-3xl border border-border/75 bg-surface-raised p-10 text-center shadow-[var(--shadow-soft)]">
                  <LifeBuoy className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
                  <p className="mt-3 font-bold text-brand-heading">{overviewFailed ? "Pusat Bantuan belum dapat dimuat" : "Panduan sedang disiapkan"}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {overviewFailed ? "Periksa koneksi Anda lalu coba lagi." : "Human Capital sedang meninjau panduan dan FAQ. Sementara itu, hubungi Human Capital bila ada pertanyaan."}
                  </p>
                  {overviewFailed ? (
                    <button type="button" onClick={() => setAttempt((value) => value + 1)}
                      className="mt-4 min-h-11 rounded-xl border border-border px-4 text-sm font-bold text-brand-heading">Coba lagi</button>
                  ) : null}
                </div>
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2">
                  {helpTopics.filter((entry) => (counts.get(entry.topic) ?? 0) > 0).map((entry) => (
                    <li key={entry.topic}>
                      <button type="button" onClick={() => chooseTopic(entry.topic)}
                        className="flex min-h-20 w-full items-center justify-between gap-3 rounded-3xl border border-border/75 bg-surface-raised p-4 text-left shadow-[var(--shadow-soft)]">
                        <span>
                          <span className="block font-bold text-brand-heading">{entry.label}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">{counts.get(entry.topic)} artikel</span>
                        </span>
                        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : loading && !articles.length ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat artikel...</div>
            ) : !articles.length && !error ? (
              <div className="rounded-3xl border border-border/75 bg-surface-raised p-8 text-center shadow-[var(--shadow-soft)]">
                <Search className="mx-auto h-7 w-7 text-muted-foreground" aria-hidden="true" />
                <p className="mt-3 font-bold text-brand-heading">
                  {searching ? `Tidak ada hasil untuk "${query.trim()}"` : `Belum ada artikel untuk ${topicLabel(topic as HelpTopic)}`}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {searching ? "Coba kata lain yang lebih umum, atau pilih topik." : "Hubungi Human Capital bila ada pertanyaan tentang layanan ini."}
                </p>
              </div>
            ) : (
              <div className={cn("grid gap-5", loading && "opacity-60")}>
                {guides.map((guide) => (
                  <article key={guide.id} className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand-primary-deep">Panduan</p>
                    <h2 className="mt-1 text-lg font-bold text-brand-heading">{guide.title}</h2>
                    <div className="mt-3"><ArticleBody body={guide.body} /></div>
                  </article>
                ))}
                {faqs.length ? (
                  <section className="rounded-3xl border border-border/75 bg-surface-raised px-5 py-3 shadow-[var(--shadow-soft)]">
                    <h2 className="pt-2 text-sm font-bold text-brand-heading">
                      {searching ? `Hasil pencarian (${pagination?.total ?? faqs.length})` : "Pertanyaan yang sering diajukan"}
                    </h2>
                    <ul className="divide-y divide-border/70">
                      {faqs.map((article) => (
                        <FaqItem key={article.id} article={article} showTopic={searching}
                          open={openId === article.id} onToggle={() => setOpenId(openId === article.id ? null : article.id)} />
                      ))}
                    </ul>
                  </section>
                ) : null}
                {topicService && !searching ? (
                  <a href={topicService} className="inline-flex min-h-11 items-center gap-1 text-sm font-bold text-brand-primary-deep">
                    Buka layanan {topicLabel(topic as HelpTopic)} <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </a>
                ) : null}
                {pagination && pagination.total > PAGE_SIZE ? (
                  <div className="overflow-hidden rounded-2xl border border-border/75">
                    <PaginationBar page={pagination.page} pageSize={pagination.pageSize} total={pagination.total} onPageChange={setPage} />
                  </div>
                ) : null}
              </div>
            )}
          </div>
          <aside className="grid content-start gap-5">
            <ContactCard contacts={overview?.contacts ?? []} failed={overviewFailed} />
            <p className="px-1 text-xs leading-5 text-muted-foreground">
              Untuk menjaga kerahasiaan, jangan mengirim nomor identitas, data gaji, atau kata sandi lewat pesan.
            </p>
          </aside>
        </div>
      </section>
    </AppShell>
  );
}
