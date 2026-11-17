// TRAIN-001 R3 HC surface: instruments (forms, tests, rubrics) with an item builder. Components
// copy an instrument when added to a plan, so editing one never changes an existing plan.

import { Loader2, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { DetailDialog } from "@/components/DetailDialog";
import { DialogLoading } from "@/components/DetailDialogParts";
import { PaginationBar } from "@/components/PaginationBar";
import type { Pagination } from "@/lib/training";
import {
  archiveInstrument,
  blankItem,
  cleanItems,
  createInstrument,
  getInstrument,
  getInstruments,
  INSTRUMENT_KIND_LABELS,
  ITEM_TYPE_LABELS,
  ITEM_TYPES_FOR,
  updateInstrument,
  type InstrumentKind,
  type InstrumentSummary,
  type Item,
  type ItemType,
} from "@/lib/trainingEvaluation";

const input = "mt-1 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading";
const label = "text-xs font-semibold text-muted-foreground";
const card = "rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]";
const primary = "inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50";
const secondary = "inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50";

const lines = (value: string[] | undefined) => (value ?? []).join("\n");

/** One item in the builder. Options and accepted answers are typed one per line. */
export function ItemEditor({ item, onChange, onRemove, readOnly }: {
  item: Item;
  onChange: (item: Item) => void;
  onRemove: () => void;
  readOnly: boolean;
}) {
  const options = item.options ?? [];
  return (
    <fieldset disabled={readOnly} className="grid gap-2 rounded-2xl border border-border/70 p-3 sm:grid-cols-4">
      <label className={`${label} sm:col-span-3`}>
        {ITEM_TYPE_LABELS[item.type]}
        <input className={input} maxLength={500} value={item.prompt} onChange={(event) => onChange({ ...item, prompt: event.target.value })} />
      </label>
      {item.points !== undefined ? (
        <label className={label}>
          Poin
          <input type="number" min={1} max={10} className={input} value={item.points} onChange={(event) => onChange({ ...item, points: Number(event.target.value) })} />
        </label>
      ) : item.required !== undefined ? (
        <label className={`${label} flex items-center gap-2 pt-5`}>
          <input type="checkbox" checked={item.required} onChange={(event) => onChange({ ...item, required: event.target.checked })} />Wajib
        </label>
      ) : <span />}
      {item.options ? (
        <label className={`${label} sm:col-span-2`}>
          Pilihan (satu per baris)
          <textarea rows={Math.max(2, options.length)} className={`${input} py-2`} value={lines(options)}
            onChange={(event) => onChange({ ...item, options: event.target.value.split("\n") })} />
        </label>
      ) : null}
      {item.type === "SINGLE" ? (
        <label className={`${label} sm:col-span-2`}>
          Jawaban benar
          <select className={input} value={String(item.correct ?? 0)} onChange={(event) => onChange({ ...item, correct: Number(event.target.value) })}>
            {options.map((text, position) => <option key={position} value={position}>{position + 1}. {text}</option>)}
          </select>
        </label>
      ) : null}
      {item.type === "MULTI" ? (
        <div className={`${label} sm:col-span-2`}>
          Jawaban benar (semua harus dipilih)
          {options.map((text, position) => {
            const correct = Array.isArray(item.correct) ? item.correct : [];
            return (
              <label key={position} className="mt-1 flex items-center gap-2 text-sm font-normal text-brand-heading">
                <input type="checkbox" checked={correct.includes(position)}
                  onChange={(event) => onChange({ ...item, correct: event.target.checked ? [...correct, position] : correct.filter((entry) => entry !== position) })} />
                {position + 1}. {text}
              </label>
            );
          })}
        </div>
      ) : null}
      {item.type === "TRUE_FALSE" ? (
        <label className={`${label} sm:col-span-2`}>
          Jawaban benar
          <select className={input} value={String(item.correct)} onChange={(event) => onChange({ ...item, correct: event.target.value === "true" })}>
            <option value="true">Benar</option>
            <option value="false">Salah</option>
          </select>
        </label>
      ) : null}
      {item.type === "SHORT" ? (
        <label className={`${label} sm:col-span-2`}>
          Jawaban yang diterima (satu per baris; huruf besar/kecil dan spasi diabaikan)
          <textarea rows={2} className={`${input} py-2`} value={lines(item.accepted)} onChange={(event) => onChange({ ...item, accepted: event.target.value.split("\n") })} />
        </label>
      ) : null}
      {item.type === "CRITERION" ? (
        <div className="grid gap-2 sm:col-span-4 sm:grid-cols-4">
          {(item.levels ?? []).map((text, position) => (
            <label key={position} className={label}>
              Tingkat {position + 1}
              <input className={input} maxLength={300} value={text}
                onChange={(event) => onChange({ ...item, levels: (item.levels ?? []).map((entry, index) => (index === position ? event.target.value : entry)) })} />
            </label>
          ))}
        </div>
      ) : null}
      {readOnly ? null : (
        <div className="sm:col-span-4">
          <button type="button" className={secondary} onClick={onRemove}><Trash2 className="h-4 w-4" />Hapus butir</button>
        </div>
      )}
    </fieldset>
  );
}

function InstrumentEditor({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const creating = id === "baru";
  const [kind, setKind] = useState<InstrumentKind>("FORM");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [items, setItems] = useState<Item[]>([blankItem("SCALE")]);
  const [system, setSystem] = useState(false);
  const [archived, setArchived] = useState(false);
  const [loaded, setLoaded] = useState(creating);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readOnly = system || archived;

  useEffect(() => {
    if (creating) return;
    void getInstrument(id).then((instrument) => {
      setKind(instrument.kind);
      setTitle(instrument.title);
      setDescription(instrument.description ?? "");
      setItems(instrument.items);
      setSystem(instrument.isSystem);
      setArchived(instrument.status === "ARCHIVED");
      setLoaded(true);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Instrumen tidak dapat dibuka."));
  }, [id, creating]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { title: title.trim(), description: description.trim() || null, items: cleanItems(items) };
      if (creating) await createInstrument({ kind, ...payload });
      else await updateInstrument(id, payload);
      await onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Instrumen tidak dapat disimpan.");
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!window.confirm("Arsipkan instrumen? Rencana yang sudah memakainya tidak berubah.")) return;
    setBusy(true);
    try {
      await archiveInstrument(id);
      await onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Instrumen tidak dapat diarsipkan.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DetailDialog wide title={creating ? "Instrumen baru" : title || "Instrumen"}
      description={system ? "Instrumen standar dari sistem; tidak dapat diubah." : archived ? "Diarsipkan." : "Mengubah instrumen tidak mengubah rencana evaluasi yang sudah memakainya."}
      onClose={onClose}>
      {error ? <div role="alert" className="mb-3 rounded-2xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">{error}</div> : null}
      {!loaded ? <DialogLoading /> : (
        <form onSubmit={save} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className={label}>
              Jenis
              <select className={input} value={kind} disabled={!creating}
                onChange={(event) => { const next = event.target.value as InstrumentKind; setKind(next); setItems([blankItem(ITEM_TYPES_FOR[next][0]!)]); }}>
                {Object.entries(INSTRUMENT_KIND_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            </label>
            <label className={`${label} sm:col-span-2`}>
              Judul
              <input required minLength={3} maxLength={200} disabled={readOnly} className={input} value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className={`${label} sm:col-span-3`}>
              Keterangan (opsional)
              <input maxLength={1000} disabled={readOnly} className={input} value={description} onChange={(event) => setDescription(event.target.value)} />
            </label>
          </div>
          <ol className="space-y-2">
            {items.map((item, position) => (
              <li key={position}>
                <ItemEditor item={item} readOnly={readOnly}
                  onChange={(next) => setItems(items.map((entry, index) => (index === position ? next : entry)))}
                  onRemove={() => setItems(items.filter((_, index) => index !== position))} />
              </li>
            ))}
          </ol>
          {readOnly ? null : (
            <div className="flex flex-wrap gap-2">
              {ITEM_TYPES_FOR[kind].map((type: ItemType) => (
                <button key={type} type="button" className={secondary} disabled={items.length >= 50} onClick={() => setItems([...items, blankItem(type)])}>
                  <Plus className="h-4 w-4" />{ITEM_TYPE_LABELS[type]}
                </button>
              ))}
            </div>
          )}
          {readOnly ? null : (
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={primary} disabled={busy || title.trim().length < 3 || items.length === 0}>Simpan instrumen</button>
              {creating ? null : <button type="button" className={secondary} disabled={busy} onClick={() => void archive()}>Arsipkan</button>}
            </div>
          )}
        </form>
      )}
    </DetailDialog>
  );
}

export function InstrumentsTab({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<InstrumentSummary[]>([]);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState<InstrumentKind | "">("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const result = await getInstruments({ page, kind, q: q.trim() || undefined });
      setItems(result.items);
      setPaging(result.pagination);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Instrumen tidak dapat dimuat.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), q ? 250 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, kind, q]);

  return (
    <>
      {error ? <div role="alert" className="mb-4 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
      <section className={`${card} overflow-hidden`}>
        <div className="grid gap-3 p-5 sm:grid-cols-2">
          <label className={label}>
            Jenis
            <select className={input} value={kind} onChange={(event) => { setPage(1); setKind(event.target.value as InstrumentKind | ""); }}>
              <option value="">Semua</option>
              {Object.entries(INSTRUMENT_KIND_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </label>
          <label className={label}>
            Cari judul
            <input className={input} value={q} maxLength={100} onChange={(event) => { setPage(1); setQ(event.target.value); }} />
          </label>
        </div>
        {canManage ? <div className="px-5 pb-3"><button type="button" className={secondary} onClick={() => setEditing("baru")}>Instrumen baru</button></div> : null}
        {loading ? (
          <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
        ) : items.length === 0 ? <p className="px-5 py-8 text-sm text-muted-foreground">Belum ada instrumen pada filter ini.</p> : (
          <ul className="divide-y divide-border/70 border-t border-border/70">
            {items.map((item) => (
              <li key={item.id}>
                <button type="button" className="w-full px-5 py-3 text-left hover:bg-muted/50" onClick={() => setEditing(item.id)}>
                  <span className="block font-semibold text-brand-heading">{item.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {INSTRUMENT_KIND_LABELS[item.kind]} · {item.itemCount} butir · dipakai {item.usedBy} komponen
                    {item.isSystem ? " · standar sistem" : ""}{item.status === "ARCHIVED" ? " · diarsipkan" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {paging && paging.total > 0 ? <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={setPage} /> : null}
      </section>
      {editing ? <InstrumentEditor key={editing} id={editing} onClose={() => setEditing(null)} onSaved={load} /> : null}
    </>
  );
}
