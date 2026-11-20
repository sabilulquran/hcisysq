import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Info, Loader2 } from "lucide-react";

import { AdminApiError } from "@/lib/adminEmployees";
import {
  APPROVAL_SEAT_KEYS,
  APPROVAL_SEAT_LABELS,
  APPROVAL_SEAT_ORDER,
  APPROVAL_SEAT_STATE_HINTS,
  APPROVAL_SEAT_STATE_LABELS,
  approvalSeatSummary,
  dayAfter,
  endApprovalSeatMapping,
  getApprovalSeats,
  mapApprovalSeat,
  searchApprovalSeatTargets,
  type ApprovalSeatKey,
  type ApprovalSeatReadiness,
  type ApprovalSeatRow,
  type ApprovalSeatState,
  type ApprovalSeatTarget,
} from "@/lib/approvalSeats";
import { cn } from "@/lib/utils";

/**
 * LOAN-002 / APR-002 — Pengaturan > Kursi persetujuan (employee-loans.md §16.2).
 *
 * Five seats, always all five, in the owner's order. A seat that has **never** been mapped reads as
 * such rather than being missing from a list: production starts with all five unmapped, and that is
 * the state most likely to confuse, so the screen says it in words before the table.
 *
 * The position is always chosen from the published structure. There is no free-text field for a job
 * title anywhere on this screen, and none in the request either — the stored label is derived by the
 * server (AUTH-010-K).
 */

const STATE_TONES: Readonly<Record<ApprovalSeatState, string>> = {
  READY: "border-success-line bg-success-soft text-success-ink",
  UNMAPPED: "border-warning-line bg-warning-soft text-warning-ink",
  POSITION_NOT_IN_FORCE: "border-danger-line bg-danger-soft text-danger-ink",
  VACANT: "border-danger-line bg-danger-soft text-danger-ink",
  SEAT_HELD_BY_REQUESTER: "border-info-line bg-info-soft text-info-ink",
  ACCOUNT_CAPABILITY_MISSING: "border-danger-line bg-danger-soft text-danger-ink",
};

function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function errorMessage(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  return "Permintaan kursi persetujuan tidak dapat diproses.";
}

interface MapFormState {
  seatKey: ApprovalSeatKey;
  positionKey: string;
  effectiveFrom: string;
}

/**
 * F3: ending a mapping is shown before it happens, not reported after. HC chooses the last day
 * too — "HC decides" has to mean deciding when, not only whether.
 */
interface EndFormState {
  mappingId: string;
  seatKey: ApprovalSeatKey;
  seatLabel: string;
  lastDay: string;
  reason: string;
}

export function ApprovalSeatsTab() {
  const [readiness, setReadiness] = useState<ApprovalSeatReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<MapFormState | null>(null);
  const [endForm, setEndForm] = useState<EndFormState | null>(null);
  const [targets, setTargets] = useState<ApprovalSeatTarget[]>([]);
  const [targetQuery, setTargetQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReadiness(await getApprovalSeats({}));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadTargets = useCallback(async (q: string) => {
    try {
      setTargets((await searchApprovalSeatTargets({ q: q.trim() || undefined })).items);
    } catch {
      setTargets([]);
    }
  }, []);

  useEffect(() => {
    if (!form) return;
    const handle = window.setTimeout(() => { void loadTargets(targetQuery); }, 200);
    return () => window.clearTimeout(handle);
  }, [form, targetQuery, loadTargets]);

  async function submitMapping() {
    if (!form || !form.positionKey) return;
    setBusy(true);
    setFormError(null);
    try {
      const result = await mapApprovalSeat(form);
      setReadiness(result.readiness);
      setForm(null);
      setTargetQuery("");
      setNotice(
        `Kursi ${APPROVAL_SEAT_LABELS[result.seatKey]} dipetakan ke ${result.seatLabel}, berlaku ${result.effectiveFrom}.`
        + (result.readiness.ready ? " Kelima kursi kini siap." : ""),
      );
    } catch (cause) {
      setFormError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function openEndForm(seat: ApprovalSeatRow) {
    const mapping = readiness?.history.find(
      (item) => item.seatKey === seat.seatKey && item.effectiveTo === null,
    );
    if (!mapping) return;
    setEndForm({
      mappingId: mapping.id,
      seatKey: seat.seatKey,
      seatLabel: mapping.seatLabel,
      // The earliest the server allows: ending today means the seat still explains today.
      lastDay: today(),
      reason: "",
    });
    setFormError(null);
    setNotice(null);
  }

  async function submitEnd() {
    if (!endForm || endForm.reason.trim().length < 3) return;
    setBusy(true);
    setFormError(null);
    try {
      const result = await endApprovalSeatMapping({
        id: endForm.mappingId, reason: endForm.reason.trim(), lastDay: endForm.lastDay,
      });
      setEndForm(null);
      setNotice(
        `Pemetaan kursi ${APPROVAL_SEAT_LABELS[endForm.seatKey]} berakhir pada ${result.effectiveTo}.`
        + (result.stopsEmployeeLoans
          ? ` Mulai ${dayAfter(result.effectiveTo)} tidak ada kasbon yang dapat diajukan sampai kursi itu dipetakan lagi.`
          : ""),
      );
      await load();
    } catch (cause) {
      setFormError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !readiness) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-border bg-surface p-6 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Memuat kursi persetujuan…
      </div>
    );
  }

  if (error && !readiness) {
    return (
      <div role="alert" className="flex items-start gap-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          {error}
          <button type="button" className="ml-2 underline" onClick={() => void load()}>Coba lagi</button>
        </span>
      </div>
    );
  }

  if (!readiness) return null;

  return (
    <div className="space-y-4">
      <div
        role="status"
        className={cn(
          "flex items-start gap-3 rounded-2xl border p-4 text-sm",
          readiness.ready ? "border-success-line bg-success-soft text-success-ink" : "border-warning-line bg-warning-soft text-warning-ink",
        )}
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          <span className="block font-bold">{approvalSeatSummary(readiness)}</span>
          <span className="mt-0.5 block leading-5">
            Rantai kasbon: approver unit, lalu kelima kursi di bawah ini. Rantai ini hanya berjalan
            saat alur <code>LOAN</code> berada di mode <code>STRUCTURE</code>.
          </span>
        </span>
      </div>

      {notice ? (
        <div role="status" className="rounded-2xl border border-info-line bg-info-soft p-4 text-sm text-info-ink">{notice}</div>
      ) : null}
      {error ? (
        <div role="alert" className="rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink">{error}</div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted text-xs uppercase">
            <tr>
              <th scope="col" className="p-3">Kursi</th>
              <th scope="col" className="p-3">Keadaan</th>
              <th scope="col" className="p-3">Jabatan yang dipetakan</th>
              <th scope="col" className="p-3">Tindakan</th>
            </tr>
          </thead>
          <tbody>
            {readiness.items.map((seat) => (
              <tr key={seat.seatKey} className="border-t border-border align-top">
                <td className="p-3">
                  <span className="block font-bold">{APPROVAL_SEAT_LABELS[seat.seatKey]}</span>
                  <span className="block text-xs text-muted-foreground">{APPROVAL_SEAT_ORDER[seat.seatKey]}</span>
                </td>
                <td className="p-3">
                  <span className={cn("inline-block rounded-full border px-2 py-0.5 text-xs font-bold", STATE_TONES[seat.state])}>
                    {APPROVAL_SEAT_STATE_LABELS[seat.state]}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    {APPROVAL_SEAT_STATE_HINTS[seat.state]}
                  </span>
                </td>
                <td className="p-3">
                  {seat.positionKey ? (
                    <>
                      <span className="block">{seat.positionTitle ?? seat.seatLabel}</span>
                      {seat.unitName ? <span className="block text-xs text-muted-foreground">{seat.unitName}</span> : null}
                      {seat.holderSource === "ACCOUNT" ? (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          Jabatan ini dipegang akun Organ Yayasan, yang juga harus memegang peran
                          penyetuju pinjaman.
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="p-3">
                  {seat.positionKey ? (
                    <button
                      type="button"
                      className="underline disabled:opacity-50"
                      disabled={busy}
                      onClick={() => openEndForm(seat)}
                    >
                      Akhiri pemetaan
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="underline disabled:opacity-50"
                      disabled={busy || !readiness.structurePublished}
                      onClick={() => {
                        setForm({ seatKey: seat.seatKey, positionKey: "", effectiveFrom: today() });
                        setTargetQuery("");
                        setFormError(null);
                      }}
                    >
                      Petakan kursi
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {endForm ? (
        <form
          className="space-y-3 rounded-2xl border border-danger-line bg-danger-soft p-4 text-sm text-danger-ink"
          onSubmit={(event) => { event.preventDefault(); void submitEnd(); }}
        >
          <h3 className="font-bold">Akhiri pemetaan kursi {APPROVAL_SEAT_LABELS[endForm.seatKey]}</h3>
          {/* D-18: the consequence is shown before the button is pressed, not reported after. */}
          <p className="leading-5">
            Kursi ini sekarang dipetakan ke <strong>{endForm.seatLabel}</strong>. Setelah pemetaan
            berakhir, kursi {APPROVAL_SEAT_LABELS[endForm.seatKey]} menjadi kosong, dan mulai{" "}
            <strong>{dayAfter(endForm.lastDay)}</strong> <strong>tidak ada kasbon yang dapat
            diajukan siapa pun</strong> — bukan hanya pengajuan satu orang — sampai kursi itu
            dipetakan lagi. Kasbon yang sudah berjalan tidak terpengaruh: langkahnya sudah
            disnapshot saat pengajuan.
          </p>

          <label className="block">
            <span className="mb-1 block text-xs font-bold">Berlaku terakhir pada</span>
            <input
              type="date"
              className="rounded-xl border border-border px-3 py-2 text-ink"
              value={endForm.lastDay}
              min={today()}
              onChange={(event) => setEndForm({ ...endForm, lastDay: event.target.value })}
              required
            />
            <span className="mt-1 block text-xs">
              Paling awal hari ini: pemetaan yang berlaku hari ini sudah menjelaskan kasbon yang
              diajukan hari ini, jadi tidak dapat dinyatakan tidak berlaku surut.
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-bold">Alasan (minimal 3 karakter)</span>
            <input
              type="text"
              className="w-full rounded-xl border border-border px-3 py-2 text-ink"
              value={endForm.reason}
              onChange={(event) => setEndForm({ ...endForm, reason: event.target.value })}
              minLength={3}
              required
              placeholder="Misalnya: pergantian jabatan"
            />
          </label>

          {formError ? <p role="alert" className="font-bold">{formError}</p> : null}

          <div className="flex gap-2">
            <button
              type="submit"
              className="rounded-xl border border-danger-line px-3 py-2 font-bold disabled:opacity-50"
              disabled={busy || endForm.reason.trim().length < 3}
            >
              Akhiri pemetaan
            </button>
            <button type="button" className="underline" onClick={() => { setEndForm(null); setFormError(null); }}>
              Batal
            </button>
          </div>
        </form>
      ) : null}

      {form ? (
        <form
          className="space-y-3 rounded-2xl border border-border bg-surface p-4 text-sm"
          onSubmit={(event) => { event.preventDefault(); void submitMapping(); }}
        >
          <h3 className="font-bold">Petakan kursi {APPROVAL_SEAT_LABELS[form.seatKey]}</h3>
          <p className="text-xs leading-5 text-muted-foreground">
            Pilih jabatan dari struktur yang berlaku. Nama jabatan tidak diketik: yang disimpan
            diambil dari strukturnya sendiri. Tanggal berlaku paling awal hari ini — pemetaan
            mundur tidak mengubah rantai yang sudah berjalan, hanya menjelaskannya ulang.
          </p>

          <label className="block">
            <span className="mb-1 block text-xs font-bold">Cari jabatan</span>
            <input
              type="search"
              className="w-full rounded-xl border border-border px-3 py-2"
              value={targetQuery}
              onChange={(event) => setTargetQuery(event.target.value)}
              placeholder="Nama jabatan atau unit"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-bold">Jabatan</span>
            <select
              className="w-full rounded-xl border border-border px-3 py-2"
              value={form.positionKey}
              onChange={(event) => setForm({ ...form, positionKey: event.target.value })}
              required
            >
              <option value="">Pilih jabatan…</option>
              {targets.map((target) => (
                <option key={target.key} value={target.key}>
                  {target.label}{target.detail ? ` — ${target.detail}` : ""}
                  {target.holderSource === "ACCOUNT" ? " (dipegang akun Organ Yayasan)" : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-bold">Berlaku mulai</span>
            <input
              type="date"
              className="rounded-xl border border-border px-3 py-2"
              value={form.effectiveFrom}
              min={today()}
              onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })}
              required
            />
          </label>

          {formError ? <p role="alert" className="text-danger-ink">{formError}</p> : null}

          <div className="flex gap-2">
            <button type="submit" className="rounded-xl border border-border px-3 py-2 font-bold disabled:opacity-50" disabled={busy || !form.positionKey}>
              Simpan pemetaan
            </button>
            <button type="button" className="underline" onClick={() => { setForm(null); setFormError(null); }}>
              Batal
            </button>
          </div>
        </form>
      ) : null}

      {readiness.history.length > 0 ? (
        <details className="rounded-2xl border border-border bg-surface p-4 text-sm">
          <summary className="cursor-pointer font-bold">Riwayat pemetaan ({readiness.history.length})</summary>
          <ul className="mt-3 space-y-2">
            {readiness.history.map((item) => (
              <li key={item.id} className="border-t border-border pt-2 text-xs leading-5 first:border-0 first:pt-0">
                <span className="font-bold">{APPROVAL_SEAT_LABELS[item.seatKey]}</span> — {item.seatLabel}
                <span className="block text-muted-foreground">
                  Berlaku {item.effectiveFrom}
                  {item.effectiveTo ? ` sampai ${item.effectiveTo}` : " sampai sekarang"}
                  {item.createdByName ? `, dipetakan oleh ${item.createdByName}` : ""}
                  {item.endReason ? `. Diakhiri: ${item.endReason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <p className="text-xs leading-5 text-muted-foreground">
        Kunci kursi adalah himpunan tertutup ({APPROVAL_SEAT_KEYS.length} kursi). Menambah kursi baru
        adalah perubahan sistem, bukan data.
      </p>
    </div>
  );
}
