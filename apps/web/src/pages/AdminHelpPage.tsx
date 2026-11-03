// HELP-001 Human Capital surface: review, write, publish and archive help articles, keep the HC
// contacts, and read the change history. Spec: docs/domain/help-center.md §10.

import { History, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { AdminShell } from "@/layouts/AdminShell";
import {
  archiveHelpArticle,
  auditLabel,
  channelLabel,
  createHelpArticle,
  createHelpContact,
  deleteHelpContact,
  editHelpArticle,
  helpTopics,
  isUnreviewedSeed,
  kindLabel,
  listAdminHelpArticles,
  listHelpAuditEvents,
  listHelpContacts,
  listHelpRevisions,
  paragraphs,
  publishHelpArticle,
  restoreHelpArticle,
  statusLabel,
  topicLabel,
  updateHelpContact,
  type AdminHelpArticle,
  type ArticleFilter,
  type ContactInput,
  type HelpAuditEvent,
  type HelpChannel,
  type HelpContact,
  type HelpKind,
  type HelpRevision,
  type HelpStatus,
  type HelpTopic,
  type Pagination,
} from "@/lib/help";
import { cn } from "@/lib/utils";

type Tab = "articles" | "contacts" | "history";

const inputClass = "mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading";
const cardClass = "rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]";
const primaryButton = "inline-flex min-h-11 items-center gap-1 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50";
const secondaryButton = "inline-flex min-h-11 items-center gap-1 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50";

function formatDateTime(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(value));
}

function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

function StatusBadge({ article }: { article: AdminHelpArticle }) {
  const tone = article.status === "PUBLISHED"
    ? "bg-brand-primary-pale text-brand-primary-deep"
    : article.status === "ARCHIVED" ? "bg-surface text-muted-foreground" : "bg-warning-soft text-warning-ink";
  return (
    <span className="flex flex-wrap gap-1.5">
      <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", tone)}>{statusLabel[article.status]}</span>
      {isUnreviewedSeed(article) ? (
        <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-bold text-warning-ink">Draf awal — perlu ditinjau</span>
      ) : null}
    </span>
  );
}

// ------------------------------------------------------------------ editor

interface EditorState {
  id: string | null;
  version: number;
  kind: HelpKind;
  topic: HelpTopic;
  title: string;
  body: string;
  sortOrder: number;
  changeNote: string;
}

const emptyEditor: EditorState = {
  id: null, version: 1, kind: "FAQ", topic: "GENERAL", title: "", body: "", sortOrder: 100, changeNote: "",
};

function ArticleEditor({ initial, busy, onCancel, onSave }: {
  initial: EditorState;
  busy: boolean;
  onCancel: () => void;
  onSave: (state: EditorState) => void;
}) {
  const [state, setState] = useState(initial);
  useEffect(() => setState(initial), [initial]);
  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]) => setState((current) => ({ ...current, [key]: value }));
  return (
    <form className={cardClass} onSubmit={(event) => { event.preventDefault(); onSave(state); }}>
      <h2 className="text-sm font-bold text-brand-heading">{state.id ? "Ubah artikel" : "Artikel baru"}</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <label className="text-sm font-semibold text-brand-heading">
          Jenis
          <select value={state.kind} onChange={(event) => set("kind", event.target.value as HelpKind)} className={inputClass}>
            <option value="FAQ">FAQ (tanya-jawab)</option>
            <option value="GUIDE">Panduan</option>
          </select>
        </label>
        <label className="text-sm font-semibold text-brand-heading">
          Topik
          <select value={state.topic} onChange={(event) => set("topic", event.target.value as HelpTopic)} className={inputClass}>
            {helpTopics.map((entry) => <option key={entry.topic} value={entry.topic}>{entry.label}</option>)}
          </select>
        </label>
        <label className="text-sm font-semibold text-brand-heading">
          Urutan
          <input type="number" min={0} max={9999} value={state.sortOrder}
            onChange={(event) => set("sortOrder", Number(event.target.value) || 0)} className={inputClass} />
        </label>
        <label className="text-sm font-semibold text-brand-heading sm:col-span-3">
          {state.kind === "FAQ" ? "Pertanyaan" : "Judul"}
          <input required minLength={5} maxLength={200} value={state.title}
            onChange={(event) => set("title", event.target.value)} className={inputClass} />
        </label>
        <label className="text-sm font-semibold text-brand-heading sm:col-span-3">
          {state.kind === "FAQ" ? "Jawaban" : "Isi panduan"}
          <textarea required minLength={20} maxLength={8000} rows={10} value={state.body}
            onChange={(event) => set("body", event.target.value)}
            placeholder="Teks biasa. Pisahkan paragraf dengan baris kosong. Langkah boleh ditulis 1. 2. 3. per baris."
            className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal leading-6 text-brand-heading" />
          <span className="mt-1 block text-right text-[11px] font-normal text-muted-foreground">{state.body.length}/8000</span>
        </label>
        {state.id ? (
          <label className="text-sm font-semibold text-brand-heading sm:col-span-3">
            Catatan perubahan (opsional)
            <input maxLength={300} value={state.changeNote} onChange={(event) => set("changeNote", event.target.value)}
              placeholder="Misalnya: menyesuaikan dengan aturan cuti terbaru" className={inputClass} />
          </label>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={primaryButton}>{state.id ? "Simpan perubahan" : "Simpan sebagai draf"}</button>
        <button type="button" disabled={busy} onClick={onCancel} className={secondaryButton}>Batal</button>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        Perubahan pada artikel yang sudah terbit langsung terlihat oleh pegawai, dan setiap simpan tercatat sebagai revisi.
        Jangan menulis gaji, nomor identitas, atau data pribadi pegawai di dalam artikel.
      </p>
    </form>
  );
}

function RevisionPanel({ article, onClose }: { article: AdminHelpArticle; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<HelpRevision[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [openVersion, setOpenVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    listHelpRevisions(article.id, page)
      .then((result) => { if (active) { setItems(result.items); setPagination(result.pagination); setError(null); } })
      .catch((cause: unknown) => { if (active) setError(message(cause, "Riwayat revisi tidak dapat dimuat.")); });
    return () => { active = false; };
  }, [article.id, page]);
  return (
    <section className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-brand-heading">Riwayat revisi: {article.title}</h2>
        <button type="button" onClick={onClose} className={secondaryButton}>Tutup</button>
      </div>
      {error ? <p className="mt-3 text-sm text-danger-ink">{error}</p> : null}
      {!pagination && !error ? <p className="mt-3 text-sm text-muted-foreground">Memuat revisi...</p> : null}
      <ul className="mt-3 divide-y divide-border/70">
        {items.map((revision) => (
          <li key={revision.id} className="py-3">
            <button type="button" onClick={() => setOpenVersion(openVersion === revision.version ? null : revision.version)}
              aria-expanded={openVersion === revision.version} className="w-full text-left">
              <span className="text-sm font-semibold text-brand-heading">Versi {revision.version} · {revision.title}</span>
              <span className="mt-0.5 block text-[11px] font-semibold text-muted-foreground">
                {formatDateTime(revision.createdAt)} · {revision.actorName ?? "Isi awal sistem"} · {statusLabel[revision.status]}
                {revision.changeNote ? ` · ${revision.changeNote}` : ""}
              </span>
            </button>
            {openVersion === revision.version ? (
              <div className="mt-2 rounded-2xl bg-surface p-3">
                {paragraphs(revision.body).map((paragraph, index) => (
                  <p key={index} className="mt-2 whitespace-pre-line text-sm leading-6 text-brand-heading first:mt-0">{paragraph}</p>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {pagination && pagination.total > pagination.pageSize ? (
        <PaginationBar page={pagination.page} pageSize={pagination.pageSize} total={pagination.total} onPageChange={setPage} />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- articles

function ArticlesTab() {
  const [filter, setFilter] = useState<ArticleFilter>({ q: "", status: "", topic: "", kind: "", page: 1, pageSize: 25 });
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<AdminHelpArticle[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [counts, setCounts] = useState<(Record<HelpStatus, number> & { unreviewedSeed: number }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [revisionsOf, setRevisionsOf] = useState<AdminHelpArticle | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listAdminHelpArticles(filter);
      setItems(result.items);
      setPagination(result.pagination);
      setCounts(result.counts);
      setError(null);
    } catch (cause) {
      setError(message(cause, "Artikel tidak dapat dimuat."));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setTimeout(() => setFilter((current) => (current.q === search ? current : { ...current, q: search, page: 1 })), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await action();
      setNotice(success);
      await load();
      return true;
    } catch (cause) {
      setError(message(cause, "Tindakan belum dapat diselesaikan."));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async (state: EditorState) => {
    const input = { kind: state.kind, topic: state.topic, title: state.title, body: state.body, sortOrder: state.sortOrder };
    const saved = await run(
      () => (state.id
        ? editHelpArticle(state.id, { ...input, version: state.version, ...(state.changeNote ? { changeNote: state.changeNote } : {}) })
        : createHelpArticle(input)),
      state.id ? "Perubahan tersimpan." : "Draf artikel tersimpan. Terbitkan bila sudah siap.",
    );
    if (saved) setEditor(null);
  };

  const archive = (article: AdminHelpArticle) => {
    const reason = window.prompt(`Arsipkan "${article.title}"? Artikel tidak lagi terlihat oleh pegawai dan dapat dipulihkan nanti.\n\nAlasan (boleh kosong):`);
    if (reason === null) return;
    void run(() => archiveHelpArticle(article.id, reason.trim() || undefined), "Artikel diarsipkan.");
  };

  const setField = (patch: Partial<ArticleFilter>) => setFilter((current) => ({ ...current, ...patch, page: 1 }));

  return (
    <div className="grid gap-5">
      {counts ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {(["DRAFT", "PUBLISHED", "ARCHIVED"] as const).map((status) => (
            <button key={status} type="button" onClick={() => setField({ status: filter.status === status ? "" : status })}
              aria-pressed={filter.status === status}
              className={cn(cardClass, "p-4 text-left", filter.status === status && "border-brand-primary")}>
              <span className="block text-xs font-bold text-muted-foreground">{statusLabel[status]}</span>
              <span className="mt-1 block text-2xl font-bold text-brand-heading">{counts[status]}</span>
              {status === "DRAFT" && counts.unreviewedSeed ? (
                <span className="mt-1 block text-xs font-semibold text-warning-ink">{counts.unreviewedSeed} draf awal perlu ditinjau</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {counts?.unreviewedSeed ? (
        <div className="rounded-2xl border border-border bg-surface p-4 text-sm leading-6 text-brand-heading">
          Isi awal Pusat Bantuan dimuat sebagai draf supaya ditinjau dulu. Baca setiap artikel, sesuaikan dengan aturan yang berlaku
          di yayasan, lalu tekan <strong>Terbitkan</strong>. Pegawai hanya melihat artikel yang sudah terbit.
        </div>
      ) : null}

      {error ? <div className="rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
      {notice ? <div className="rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

      {editor ? (
        <ArticleEditor initial={editor} busy={busy} onCancel={() => setEditor(null)} onSave={(state) => void save(state)} />
      ) : null}
      {revisionsOf ? <RevisionPanel article={revisionsOf} onClose={() => setRevisionsOf(null)} /> : null}

      <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto] lg:items-end">
          <label className="text-sm font-semibold text-brand-heading sm:col-span-2 lg:col-span-1">
            Cari
            <input type="text" inputMode="search" value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)}
              placeholder="Judul atau isi" className={inputClass} />
          </label>
          <label className="text-sm font-semibold text-brand-heading">
            Status
            <select value={filter.status ?? ""} onChange={(event) => setField({ status: event.target.value as HelpStatus | "" })} className={inputClass}>
              <option value="">Semua</option>
              {(["DRAFT", "PUBLISHED", "ARCHIVED"] as const).map((status) => <option key={status} value={status}>{statusLabel[status]}</option>)}
            </select>
          </label>
          <label className="text-sm font-semibold text-brand-heading">
            Topik
            <select value={filter.topic ?? ""} onChange={(event) => setField({ topic: event.target.value as HelpTopic | "" })} className={inputClass}>
              <option value="">Semua</option>
              {helpTopics.map((entry) => <option key={entry.topic} value={entry.topic}>{entry.label}</option>)}
            </select>
          </label>
          <label className="text-sm font-semibold text-brand-heading">
            Jenis
            <select value={filter.kind ?? ""} onChange={(event) => setField({ kind: event.target.value as HelpKind | "" })} className={inputClass}>
              <option value="">Semua</option>
              <option value="GUIDE">Panduan</option>
              <option value="FAQ">FAQ</option>
            </select>
          </label>
          <button type="button" disabled={busy} onClick={() => { setEditor({ ...emptyEditor }); setRevisionsOf(null); }} className={primaryButton}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Artikel baru
          </button>
        </div>

        {loading && !items.length ? (
          <div className="flex items-center gap-2 border-t border-border/70 p-5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat artikel...</div>
        ) : items.length ? (
          <ul className={cn("divide-y divide-border/70 border-t border-border/70", loading && "opacity-60")}>
            {items.map((article) => (
              <li key={article.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-brand-heading">{article.title}</p>
                  <p className="mt-1 text-[11px] font-semibold text-muted-foreground">
                    {kindLabel[article.kind]} · {topicLabel(article.topic)} · urutan {article.sortOrder} · versi {article.version}
                    {article.publishedAt ? ` · ${article.status === "PUBLISHED" ? "terbit" : "terakhir terbit"} ${formatDateTime(article.publishedAt)}` : ""}
                  </p>
                  <div className="mt-1.5"><StatusBadge article={article} /></div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {article.status !== "ARCHIVED" ? (
                    <button type="button" disabled={busy} className={secondaryButton}
                      onClick={() => {
                        setRevisionsOf(null);
                        setEditor({
                          id: article.id, version: article.version, kind: article.kind, topic: article.topic,
                          title: article.title, body: article.body, sortOrder: article.sortOrder, changeNote: "",
                        });
                      }}>
                      {isUnreviewedSeed(article) ? "Tinjau" : "Ubah"}
                    </button>
                  ) : null}
                  {article.status === "DRAFT" ? (
                    <button type="button" disabled={busy} className={primaryButton}
                      onClick={() => void run(() => publishHelpArticle(article.id, article.version), "Artikel terbit dan terlihat oleh pegawai.")}>
                      Terbitkan
                    </button>
                  ) : null}
                  {article.status === "ARCHIVED" ? (
                    <button type="button" disabled={busy} className={secondaryButton}
                      onClick={() => void run(() => restoreHelpArticle(article.id), "Artikel dipulihkan sebagai draf.")}>
                      Pulihkan
                    </button>
                  ) : (
                    <button type="button" disabled={busy} className={secondaryButton} onClick={() => archive(article)}>Arsipkan</button>
                  )}
                  <button type="button" className={secondaryButton} aria-label={`Riwayat revisi ${article.title}`}
                    onClick={() => { setEditor(null); setRevisionsOf(article); }}>
                    <History className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="border-t border-border/70 p-5 text-sm text-muted-foreground">
            {filter.q || filter.status || filter.topic || filter.kind ? "Tidak ada artikel yang cocok dengan filter." : "Belum ada artikel."}
          </p>
        )}
        {pagination ? (
          <PaginationBar page={pagination.page} pageSize={pagination.pageSize} total={pagination.total}
            onPageChange={(page) => setFilter((current) => ({ ...current, page }))}
            onPageSizeChange={(pageSize) => setFilter((current) => ({ ...current, pageSize, page: 1 }))} />
        ) : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- contacts

const emptyContact: ContactInput = { label: "", channel: "WHATSAPP", value: "", note: "", sortOrder: 100, active: true };

function ContactsTab() {
  const [items, setItems] = useState<HelpContact[]>([]);
  const [limit, setLimit] = useState(20);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<ContactInput>(emptyContact);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listHelpContacts();
      setItems(result.items);
      setLimit(result.limit);
      setError(null);
    } catch (cause) {
      setError(message(cause, "Kontak tidak dapat dimuat."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await action();
      setNotice(success);
      setForm(emptyContact);
      setEditingId(null);
      await load();
    } catch (cause) {
      setError(message(cause, "Tindakan belum dapat diselesaikan."));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const input = { ...form, ...(form.note?.trim() ? { note: form.note.trim() } : { note: undefined }) };
    void run(
      () => (editingId ? updateHelpContact(editingId, input) : createHelpContact(input)),
      editingId ? "Kontak tersimpan." : "Kontak ditambahkan.",
    );
  };

  const valueHint: Record<HelpChannel, string> = {
    WHATSAPP: "Nomor WhatsApp kantor, misalnya +62 812-xxxx-xxxx",
    PHONE: "Nomor telepon kantor",
    EMAIL: "Alamat email layanan HC",
    OFFICE: "Lokasi, misalnya Ruang HC, gedung utama lantai 1",
  };

  return (
    <div className="grid gap-5">
      {error ? <div className="rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
      {notice ? <div className="rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}
      <form onSubmit={submit} className={cardClass}>
        <h2 className="text-sm font-bold text-brand-heading">{editingId ? "Ubah kontak" : "Tambah kontak"}</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-semibold text-brand-heading">
            Nama layanan
            <input required minLength={2} maxLength={100} value={form.label} placeholder="Misalnya: Layanan HC"
              onChange={(event) => setForm({ ...form, label: event.target.value })} className={inputClass} />
          </label>
          <label className="text-sm font-semibold text-brand-heading">
            Kanal
            <select value={form.channel} onChange={(event) => setForm({ ...form, channel: event.target.value as HelpChannel })} className={inputClass}>
              {(Object.keys(channelLabel) as HelpChannel[]).map((channel) => <option key={channel} value={channel}>{channelLabel[channel]}</option>)}
            </select>
          </label>
          <label className="text-sm font-semibold text-brand-heading">
            {form.channel === "OFFICE" ? "Lokasi" : form.channel === "EMAIL" ? "Alamat email" : "Nomor"}
            <input required maxLength={200} value={form.value} placeholder={valueHint[form.channel]}
              onChange={(event) => setForm({ ...form, value: event.target.value })} className={inputClass} />
          </label>
          <label className="text-sm font-semibold text-brand-heading">
            Catatan (opsional)
            <input maxLength={200} value={form.note ?? ""} placeholder="Misalnya: Senin–Jumat 08.00–15.00"
              onChange={(event) => setForm({ ...form, note: event.target.value })} className={inputClass} />
          </label>
          <label className="text-sm font-semibold text-brand-heading">
            Urutan
            <input type="number" min={0} max={9999} value={form.sortOrder}
              onChange={(event) => setForm({ ...form, sortOrder: Number(event.target.value) || 0 })} className={inputClass} />
          </label>
          <label className="flex min-h-11 items-center gap-2 self-end text-sm font-semibold text-brand-heading">
            <input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} className="h-4 w-4" />
            Tampilkan kepada pegawai
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="submit" disabled={busy || (!editingId && items.length >= limit)} className={primaryButton}>
            {editingId ? "Simpan kontak" : "Tambah kontak"}
          </button>
          {editingId ? (
            <button type="button" disabled={busy} onClick={() => { setEditingId(null); setForm(emptyContact); }} className={secondaryButton}>Batal</button>
          ) : null}
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Pakai kontak kelembagaan, bukan nomor pribadi. Paling banyak {limit} kontak ({items.length} terpakai).
        </p>
      </form>

      <section className={cardClass}>
        <h2 className="text-sm font-bold text-brand-heading">Kontak HC</h2>
        {loading ? (
          <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat kontak...</div>
        ) : items.length ? (
          <ul className="mt-3 divide-y divide-border/70">
            {items.map((contact) => (
              <li key={contact.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-semibold text-brand-heading">{contact.label}{contact.active ? "" : " · disembunyikan"}</p>
                  <p className="mt-0.5 break-words text-[11px] font-semibold text-muted-foreground">
                    {channelLabel[contact.channel]}: {contact.value}{contact.note ? ` · ${contact.note}` : ""} · urutan {contact.sortOrder}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button type="button" disabled={busy} className={secondaryButton}
                    onClick={() => {
                      setEditingId(contact.id);
                      setForm({
                        label: contact.label, channel: contact.channel, value: contact.value, note: contact.note ?? "",
                        sortOrder: contact.sortOrder, active: contact.active ?? true,
                      });
                    }}>
                    Ubah
                  </button>
                  <button type="button" disabled={busy} className={secondaryButton}
                    onClick={() => {
                      if (window.confirm(`Hapus kontak "${contact.label}"? Isinya tetap tercatat di riwayat.`)) {
                        void run(() => deleteHelpContact(contact.id), "Kontak dihapus.");
                      }
                    }}>
                    Hapus
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            Belum ada kontak. Selama kosong, halaman Bantuan pegawai menyarankan bertanya kepada atasan atau datang ke ruang HC.
          </p>
        )}
      </section>
    </div>
  );
}

// ----------------------------------------------------------------- history

function HistoryTab() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [items, setItems] = useState<HelpAuditEvent[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    listHelpAuditEvents(page, pageSize)
      .then((result) => { if (active) { setItems(result.items); setPagination(result.pagination); setError(null); } })
      .catch((cause: unknown) => { if (active) setError(message(cause, "Riwayat tidak dapat dimuat.")); });
    return () => { active = false; };
  }, [page, pageSize]);

  const subject = (event: HelpAuditEvent) =>
    event.metadata.title ?? event.metadata.after?.label ?? event.metadata.before?.label ?? "";

  return (
    <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
      <h2 className="px-5 pt-5 text-sm font-bold text-brand-heading">Riwayat perubahan</h2>
      {error ? <p className="px-5 pt-3 text-sm text-danger-ink">{error}</p> : null}
      {!pagination && !error ? (
        <div className="flex items-center gap-2 p-5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat riwayat...</div>
      ) : items.length ? (
        <ul className="mt-3 divide-y divide-border/70 border-t border-border/70">
          {items.map((event) => (
            <li key={event.id} className="px-5 py-3">
              <p className="text-sm font-semibold text-brand-heading">
                {auditLabel[event.eventType] ?? event.eventType}{subject(event) ? `: ${subject(event)}` : ""}
                {event.metadata.version ? ` (versi ${event.metadata.version})` : ""}
              </p>
              <p className="mt-0.5 text-[11px] font-semibold text-muted-foreground">
                {formatDateTime(event.occurredAt)} · {event.actorName ?? "Isi awal sistem"}{event.reason ? ` · ${event.reason}` : ""}
              </p>
            </li>
          ))}
        </ul>
      ) : pagination ? (
        <p className="p-5 text-sm text-muted-foreground">Belum ada riwayat.</p>
      ) : null}
      {pagination ? (
        <PaginationBar page={pagination.page} pageSize={pagination.pageSize} total={pagination.total} onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} />
      ) : null}
    </section>
  );
}

export function AdminHelpPage() {
  const [tab, setTab] = useState<Tab>("articles");
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "articles", label: "Artikel" },
    { key: "contacts", label: "Kontak HC" },
    { key: "history", label: "Riwayat" },
  ];
  return (
    <AdminShell active="services" title="Pusat Bantuan" description="FAQ, panduan layanan, dan kontak Human Capital untuk pegawai.">
      <div className="mb-5 flex gap-2 overflow-x-auto" role="group" aria-label="Bagian Pusat Bantuan">
        {tabs.map((entry) => (
          <button key={entry.key} type="button" aria-pressed={tab === entry.key} onClick={() => setTab(entry.key)}
            className={cn(
              "min-h-11 whitespace-nowrap rounded-xl border px-4 text-sm font-bold",
              tab === entry.key ? "border-brand-primary bg-brand-primary text-brand-foreground" : "border-border bg-surface-raised text-brand-heading",
            )}>
            {entry.label}
          </button>
        ))}
      </div>
      {tab === "articles" ? <ArticlesTab /> : tab === "contacts" ? <ContactsTab /> : <HistoryTab />}
    </AdminShell>
  );
}
