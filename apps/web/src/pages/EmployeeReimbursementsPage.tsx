// REIMB-001 employee surface: build a draft claim, upload receipts, check the approvers, submit,
// follow approval, verification and payment, discard or withdraw. Spec: docs/domain/reimbursement.md.

import { Loader2, Plus, Receipt, Trash2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PaginationBar } from "@/components/PaginationBar";
import { ReimbursementDetailPanel } from "@/components/reimbursements/ReimbursementDetailPanel";
import { AppShell } from "@/layouts/AppShell";
import { employeeShellUser } from "@/lib/employeeIdentity";
import { getEmployeeLeaveSummary, type EmployeeLeaveSummary } from "@/lib/employeeLeave";
import {
  approverRoleLabel,
  cancelMyClaim,
  claimStatusLabel,
  createDraft,
  formatClaimDate,
  formatRupiah,
  getLinkableTrips,
  getMyClaim,
  getMyClaims,
  myReceiptHref,
  parseRupiahInput,
  previewApprovers,
  readReceiptFile,
  RECEIPT_ACCEPT,
  removeReceipt,
  submitClaim,
  todayInJakarta,
  updateDraft,
  uploadReceipt,
  type Category,
  type CategoryKey,
  type ClaimDetail,
  type ClaimPolicy,
  type ClaimSummary,
  type LinkableTrip,
  type Pagination,
} from "@/lib/reimbursements";

interface ItemRow { category: CategoryKey; expenseDate: string; description: string; amount: string }
interface Editor { id: string | null; title: string; businessTripId: string; items: ItemRow[] }

const emptyRow = (): ItemRow => ({ category: "TRANSPORT", expenseDate: todayInJakarta(), description: "", amount: "" });
const emptyEditor = (): Editor => ({ id: null, title: "", businessTripId: "", items: [emptyRow()] });

export function EmployeeReimbursementsPage() {
  const [employee, setEmployee] = useState<EmployeeLeaveSummary["employee"] | null>(null);
  const [items, setItems] = useState<ClaimSummary[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [policy, setPolicy] = useState<ClaimPolicy | null>(null);
  const [page, setPage] = useState(1);
  const [paging, setPaging] = useState<Pagination | null>(null);
  const [selected, setSelected] = useState<ClaimDetail | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  // One key per new draft form: a double click or a retry replays instead of creating two drafts.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [trips, setTrips] = useState<LinkableTrip[]>([]);
  const [tripPaging, setTripPaging] = useState<Pagination | null>(null);
  const [approvers, setApprovers] = useState<Array<{ employeeId: string; name: string; sources: string[] }> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const user = useMemo(() => employeeShellUser(employee), [employee]);

  const loadList = async (target = page) => {
    const result = await getMyClaims(target);
    setItems(result.items);
    setPaging(result.pagination);
    setCategories(result.categories);
    setPolicy(result.policy);
  };

  const loadTrips = async (target: number) => {
    const result = await getLinkableTrips(target);
    setTrips((current) => (target === 1 ? result.items : [...current, ...result.items]));
    setTripPaging(result.pagination);
  };

  const open = async (id: string) => {
    setError(null);
    setApprovers(null);
    try {
      setSelected(await getMyClaim(id));
      setEditor(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Klaim tidak dapat dibuka.");
    }
  };

  useEffect(() => {
    void getEmployeeLeaveSummary().then((summary) => setEmployee(summary.employee)).catch(() => undefined);
    void loadList(1)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Reimbursement tidak dapat dimuat."))
      .finally(() => setLoading(false));
    // A notification links here with ?claim=<id>.
    const linked = new URLSearchParams(window.location.search).get("claim");
    if (linked) void open(linked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changePage = (next: number) => {
    setPage(next);
    void loadList(next).catch((cause) => setError(cause instanceof Error ? cause.message : "Halaman tidak dapat dimuat."));
  };

  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  const startEditor = (claim: ClaimDetail | null) => {
    setSelected(claim);
    setApprovers(null);
    setEditor(claim ? {
      id: claim.id,
      title: claim.title,
      businessTripId: claim.businessTripId ?? "",
      items: claim.items.map((item) => ({
        category: item.category, expenseDate: item.expenseDate, description: item.description, amount: String(item.amount),
      })),
    } : emptyEditor());
    if (!claim) setIdempotencyKey(crypto.randomUUID());
    void loadTrips(1).catch(() => setTrips([]));
  };

  const updateRow = (index: number, patch: Partial<ItemRow>) => {
    setEditor((current) => current && ({ ...current, items: current.items.map((row, at) => (at === index ? { ...row, ...patch } : row)) }));
  };

  const parsed = editor?.items.map((row) => parseRupiahInput(row.amount)) ?? [];
  const editorValid = Boolean(editor && editor.title.trim().length >= 5 && editor.items.length > 0
    && editor.items.every((row, index) => parsed[index] !== null && row.description.trim().length >= 3 && row.expenseDate));
  // Display only: the API computes and enforces the total.
  const editorTotal = parsed.reduce<number>((total, value) => total + (value ?? 0), 0);

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (!editor || !editorValid) return;
    void run(async () => {
      const input = {
        title: editor.title.trim(),
        businessTripId: editor.businessTripId || null,
        items: editor.items.map((row, index) => ({
          category: row.category, expenseDate: row.expenseDate, description: row.description.trim(), amount: parsed[index]!,
        })),
      };
      const id = editor.id ?? (await createDraft({ ...input, idempotencyKey })).id;
      if (editor.id) await updateDraft(editor.id, input);
      setIdempotencyKey(crypto.randomUUID());
      setNotice("Draf tersimpan. Unggah bukti pembayaran, lalu kirim klaim.");
      setPage(1);
      await loadList(1);
      await open(id);
    }, "Draf tidak dapat disimpan.");
  };

  const attach = (claim: ClaimDetail, files: FileList | null) => {
    if (!files?.length) return;
    void run(async () => {
      for (const file of Array.from(files)) {
        await uploadReceipt(claim.id, await readReceiptFile(file));
      }
      setNotice(files.length > 1 ? `${files.length} bukti diunggah.` : "Bukti diunggah.");
      await open(claim.id);
    }, "Bukti tidak dapat diunggah.");
  };

  const detach = (claim: ClaimDetail, receiptId: string) => {
    if (!window.confirm("Hapus bukti ini? Berkasnya dihapus untuk selamanya.")) return;
    void run(async () => {
      await removeReceipt(claim.id, receiptId);
      await open(claim.id);
    }, "Bukti tidak dapat dihapus.");
  };

  const checkApprovers = () => run(async () => {
    setApprovers((await previewApprovers()).approvalChain);
  }, "Penyetuju tidak dapat diperiksa.");

  const submit = (claim: ClaimDetail) => {
    if (!window.confirm(`Kirim klaim ${formatRupiah(claim.claimedTotal)}? Setelah dikirim, isinya tidak dapat diubah.`)) return;
    void run(async () => {
      await submitClaim(claim.id);
      setNotice("Klaim dikirim dan sedang menunggu persetujuan.");
      await Promise.all([loadList(), open(claim.id)]);
    }, "Klaim tidak dapat dikirim.");
  };

  const cancel = (claim: ClaimDetail) => {
    const draft = claim.status === "DRAFT";
    let reason: string | null = null;
    if (draft) {
      if (!window.confirm("Buang draf ini? Bukti yang sudah diunggah ikut dihapus.")) return;
    } else {
      reason = window.prompt("Alasan pembatalan (minimal 5 karakter)");
      if (!reason || reason.trim().length < 5) return;
    }
    void run(async () => {
      await cancelMyClaim(claim.id, reason?.trim() ?? null);
      setNotice(draft ? "Draf dibuang." : "Klaim dibatalkan.");
      await loadList();
      if (draft) setSelected(null); else await open(claim.id);
    }, "Klaim tidak dapat dibatalkan.");
  };

  const input = "mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading";
  const categoryLabel = (key: CategoryKey) => categories.find((category) => category.key === key);

  return (
    <AppShell user={user} activeItem="Reimbursement">
      <section className="mx-auto max-w-5xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-primary-deep">Keuangan Saya</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Reimbursement</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Klaim penggantian biaya kerja yang sudah Anda bayar sendiri. Atasan langsung lalu approver unit menyetujui, kemudian
          Keuangan memeriksa bukti dan membayar secara tunai atau transfer, di luar slip gaji.
        </p>

        {error ? <div role="alert" className="mt-5 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div> : null}
        {notice ? <div role="status" className="mt-5 rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">{notice}</div> : null}

        <div className="mt-6 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => startEditor(null)}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
            <Plus className="h-4 w-4" aria-hidden="true" /> Buat klaim
          </button>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <section className="overflow-hidden rounded-3xl border border-border/75 bg-surface-raised shadow-[var(--shadow-soft)]">
            <h2 className="px-5 pt-5 text-sm font-bold text-brand-heading">Klaim saya</h2>
            {loading ? (
              <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat...</div>
            ) : items.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted-foreground">Belum ada klaim. Tekan Buat klaim untuk mulai.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border/70">
                {items.map((claim) => (
                  <li key={claim.id}>
                    <button type="button" onClick={() => void open(claim.id)}
                      className={`flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-muted/50 ${selected?.id === claim.id ? "bg-muted/60" : ""}`}>
                      <Receipt className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary-deep" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-brand-heading">{claim.title}</span>
                        <span className="block text-xs tabular-nums text-muted-foreground">
                          {formatRupiah(claim.claimedTotal)} · {claim.itemCount} baris{claim.tripDestination ? ` · ${claim.tripDestination}` : ""}
                        </span>
                        <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
                          {claimStatusLabel(claim.status)}
                          {claim.currentApproverName ? ` · menunggu ${claim.currentApproverName}` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {paging && paging.total > 0 ? (
              <PaginationBar page={paging.page} pageSize={paging.pageSize} total={paging.total} onPageChange={changePage} />
            ) : null}
          </section>

          <section className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
            {editor ? (
              <form onSubmit={save} className="space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-bold text-brand-heading">{editor.id ? "Ubah draf" : "Klaim baru"}</h2>
                  <button type="button" aria-label="Tutup formulir" onClick={() => setEditor(null)} className="rounded-lg p-1 hover:bg-muted">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <label className="block text-sm font-semibold text-brand-heading">
                  Judul klaim
                  <input required minLength={5} maxLength={200} value={editor.title} placeholder="Contoh: Rapat koordinasi di Bandung"
                    onChange={(event) => setEditor({ ...editor, title: event.target.value })} className={input} />
                </label>
                <label className="block text-sm font-semibold text-brand-heading">
                  Perjalanan dinas (opsional)
                  <select value={editor.businessTripId} onChange={(event) => setEditor({ ...editor, businessTripId: event.target.value })} className={input}>
                    <option value="">Tidak terkait perjalanan dinas</option>
                    {trips.map((trip) => (
                      <option key={trip.id} value={trip.id}>{trip.destination} · {formatClaimDate(trip.startOn)}</option>
                    ))}
                  </select>
                  {tripPaging && trips.length < tripPaging.total ? (
                    <button type="button" onClick={() => void loadTrips(tripPaging.page + 1)} className="mt-1 text-xs font-semibold text-brand-primary-deep underline">
                      Tampilkan perjalanan lebih lama ({tripPaging.total - trips.length} lagi)
                    </button>
                  ) : null}
                </label>

                <div className="space-y-3">
                  {editor.items.map((row, index) => {
                    const category = categoryLabel(row.category);
                    return (
                      <fieldset key={index} className="rounded-2xl border border-border/70 bg-surface p-3">
                        <legend className="px-1 text-xs font-bold text-muted-foreground">Biaya {index + 1}</legend>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="text-xs font-semibold text-muted-foreground">Kategori
                            <select value={row.category} onChange={(event) => updateRow(index, { category: event.target.value as CategoryKey })} className={input}>
                              {categories.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
                            </select>
                            {category ? <span className="mt-1 block font-normal">Batas {formatRupiah(category.maxPerItem)} per baris</span> : null}
                          </label>
                          <label className="text-xs font-semibold text-muted-foreground">Tanggal
                            <input type="date" required max={todayInJakarta()} value={row.expenseDate}
                              onChange={(event) => updateRow(index, { expenseDate: event.target.value })} className={input} />
                          </label>
                          <label className="text-xs font-semibold text-muted-foreground sm:col-span-2">Uraian
                            <input required minLength={3} maxLength={300} value={row.description} placeholder="Contoh: tiket kereta Jakarta–Bandung"
                              onChange={(event) => updateRow(index, { description: event.target.value })} className={input} />
                          </label>
                          <label className="text-xs font-semibold text-muted-foreground">Nominal (Rp)
                            <input required inputMode="numeric" autoComplete="off" value={row.amount} placeholder="Contoh: 150.000"
                              onChange={(event) => updateRow(index, { amount: event.target.value })} className={input} />
                            {row.amount && parsed[index] === null ? (
                              <span className="mt-1 block font-normal text-danger-ink">Hanya angka dan titik ribuan, tanpa koma.</span>
                            ) : null}
                          </label>
                          {editor.items.length > 1 ? (
                            <div className="flex items-end">
                              <button type="button" onClick={() => setEditor({ ...editor, items: editor.items.filter((_, at) => at !== index) })}
                                className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-border px-3 text-xs font-bold text-danger-ink">
                                <Trash2 className="h-4 w-4" aria-hidden="true" /> Hapus baris
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </fieldset>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button type="button" disabled={editor.items.length >= (policy?.maxItems ?? 10)}
                    onClick={() => setEditor({ ...editor, items: [...editor.items, emptyRow()] })}
                    className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50">
                    <Plus className="h-4 w-4" aria-hidden="true" /> Tambah baris
                  </button>
                  <p className="text-sm font-semibold tabular-nums text-brand-heading">Total {formatRupiah(editorTotal)}</p>
                </div>
                {policy ? (
                  <p className="text-xs text-muted-foreground">
                    Paling banyak {policy.maxItems} baris, total {formatRupiah(policy.maxClaimTotal)}. Tanggal biaya paling lama {policy.maxExpenseAgeDays} hari
                    sebelum klaim dikirim.
                  </p>
                ) : null}
                <button type="submit" disabled={busy || !editorValid}
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} Simpan draf
                </button>
              </form>
            ) : selected ? (
              <>
                <div className="flex justify-end">
                  <button type="button" aria-label="Tutup detail" onClick={() => setSelected(null)} className="rounded-lg p-1 hover:bg-muted">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <ReimbursementDetailPanel
                  claim={selected}
                  receiptHref={(receipt) => myReceiptHref(selected.id, receipt.id)}
                  receiptAction={selected.status === "DRAFT" ? (receipt) => (
                    <button type="button" disabled={busy} onClick={() => detach(selected, receipt.id)}
                      className="min-h-9 rounded-lg border border-border px-2 text-xs font-bold text-danger-ink disabled:opacity-50">
                      Hapus
                    </button>
                  ) : undefined}
                  actions={(
                    <div className="w-full space-y-3">
                      {selected.status === "DRAFT" ? (
                        <>
                          <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-border px-3 text-sm font-bold text-brand-heading">
                            <Upload className="h-4 w-4" aria-hidden="true" /> Unggah bukti (PDF, JPG, PNG, maks. 4 MB)
                            <input type="file" multiple accept={RECEIPT_ACCEPT} className="sr-only" disabled={busy}
                              onChange={(event) => { attach(selected, event.target.files); event.target.value = ""; }} />
                          </label>
                          {approvers ? (
                            <div className="rounded-2xl border border-border/70 bg-surface p-3 text-sm">
                              <p className="font-semibold text-brand-heading">Penyetuju</p>
                              <ol className="mt-1 list-decimal pl-5 text-muted-foreground">
                                {approvers.map((step) => <li key={step.employeeId}>{step.name} ({approverRoleLabel(step.sources)})</li>)}
                              </ol>
                            </div>
                          ) : null}
                          <div className="flex flex-wrap gap-2">
                            <button type="button" disabled={busy} onClick={() => startEditor(selected)}
                              className="min-h-11 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50">
                              Ubah draf
                            </button>
                            <button type="button" disabled={busy} onClick={() => void checkApprovers()}
                              className="min-h-11 rounded-xl border border-border px-3 text-sm font-bold text-brand-heading disabled:opacity-50">
                              Periksa penyetuju
                            </button>
                            <button type="button" disabled={busy || selected.receipts.length === 0} onClick={() => submit(selected)}
                              className="min-h-11 rounded-xl bg-brand-primary px-3 text-sm font-bold text-brand-foreground disabled:opacity-50">
                              Kirim klaim
                            </button>
                            <button type="button" disabled={busy} onClick={() => cancel(selected)}
                              className="min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50">
                              Buang draf
                            </button>
                          </div>
                          {selected.receipts.length === 0 ? <p className="text-xs text-muted-foreground">Unggah minimal satu bukti sebelum mengirim.</p> : null}
                        </>
                      ) : null}
                      {selected.status === "IN_REVIEW" || selected.status === "APPROVED" ? (
                        <button type="button" disabled={busy} onClick={() => cancel(selected)}
                          className="min-h-11 rounded-xl border border-danger-line px-3 text-sm font-bold text-danger-ink disabled:opacity-50">
                          Batalkan klaim
                        </button>
                      ) : null}
                    </div>
                  )}
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Pilih klaim untuk melihat rincian, bukti, persetujuan, dan pembayarannya.</p>
            )}
          </section>
        </div>
      </section>
    </AppShell>
  );
}
