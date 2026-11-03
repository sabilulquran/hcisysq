// CAL-001 §12 meeting form: typeahead participant picker, Rahasia and WhatsApp switches, and an
// availability panel. The WhatsApp switch shows only while the API reports the Kirim SQ adapter
// as active (K-16); in dry run the form says plainly that only in-app notifications go out. The
// availability panel shows conflicts (red) and warnings (yellow) before sending. The panel
// is a preview; the API checks again, under lock, when the meeting is saved.

import { AlertTriangle, Loader2, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  addDays,
  checkMeetingAvailability,
  createMeeting,
  jakartaDate,
  jakartaTime,
  MeetingApiError,
  searchParticipants,
  updateMeeting,
  wibInstant,
  type Availability,
  type AvailabilityIssue,
  type MeetingDetail,
  type ParticipantOption,
} from "@/lib/meetings";

interface Chosen {
  id: string;
  name: string;
  unitName: string | null;
  hasAccount: boolean | null;
  hasWhatsApp: boolean | null;
}

function initialState(defaultDate: string, editing: MeetingDetail | null) {
  if (editing) {
    return {
      title: editing.title,
      description: editing.description ?? "",
      location: editing.location ?? "",
      startDate: jakartaDate(editing.startAt),
      startTime: jakartaTime(editing.startAt),
      endDate: jakartaDate(new Date(Date.parse(editing.endAt) - 1)),
      endTime: jakartaTime(editing.endAt),
      confidential: editing.confidential,
      notifyWhatsApp: editing.notifyWhatsApp,
    };
  }
  // §12: tapping a date proposes 08:00–09:00.
  return {
    title: "", description: "", location: "", startDate: defaultDate, startTime: "08:00",
    endDate: defaultDate, endTime: "09:00", confidential: false, notifyWhatsApp: true,
  };
}

function IssueList({ issues, tone }: { issues: AvailabilityIssue[]; tone: "danger" | "warning" }) {
  if (issues.length === 0) return null;
  const classes = tone === "danger"
    ? "border-danger-line bg-danger-soft text-danger-ink"
    : "border-warning-line bg-warning-soft text-warning-ink";
  return (
    <ul className={`mt-2 space-y-1 rounded-2xl border p-3 text-sm ${classes}`}>
      {issues.map((issue, index) => (
        <li key={`${issue.reason}-${issue.employeeId ?? "day"}-${index}`} className="flex gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function MeetingForm({
  defaultDate,
  editing,
  whatsappActive,
  onSaved,
  onClose,
}: {
  defaultDate: string;
  editing: MeetingDetail | null;
  whatsappActive: boolean;
  onSaved: (id: string, notice: string) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState(() => initialState(defaultDate, editing));
  const [chosen, setChosen] = useState<Chosen[]>(() => (editing?.participants ?? [])
    .filter((participant) => participant.role === "ATTENDEE")
    .map((participant) => ({
      id: participant.employeeId, name: participant.name, unitName: participant.unitName,
      hasAccount: participant.hasAccount, hasWhatsApp: participant.hasWhatsApp,
    })));
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<ParticipantOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [checking, setChecking] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<AvailabilityIssue[]>([]);
  // One key per filled-in form: a double click or a retry replays instead of inviting twice.
  const idempotencyKey = useRef(crypto.randomUUID());

  const startAt = useMemo(() => (form.startDate && form.startTime ? wibInstant(form.startDate, form.startTime) : null), [form.startDate, form.startTime]);
  const endAt = useMemo(() => (form.endDate && form.endTime ? wibInstant(form.endDate, form.endTime) : null), [form.endDate, form.endTime]);
  const timesValid = Boolean(startAt && endAt && Date.parse(endAt) > Date.parse(startAt));
  const participantIds = useMemo(() => chosen.map((person) => person.id), [chosen]);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setOptions([]);
      return;
    }
    let active = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchParticipants(term)
        .then((result) => { if (active) setOptions(result.items); })
        .catch(() => { if (active) setOptions([]); })
        .finally(() => { if (active) setSearching(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query]);

  useEffect(() => {
    if (!timesValid || !startAt || !endAt) {
      setAvailability(null);
      return;
    }
    let active = true;
    setChecking(true);
    const timer = window.setTimeout(() => {
      void checkMeetingAvailability({ startAt, endAt, participantEmployeeIds: participantIds, excludeMeetingId: editing?.id ?? null })
        .then((result) => { if (active) { setAvailability(result); setAvailabilityError(null); } })
        .catch((cause) => {
          if (!active) return;
          setAvailability(null);
          setAvailabilityError(cause instanceof Error ? cause.message : "Ketersediaan tidak dapat diperiksa.");
        })
        .finally(() => { if (active) setChecking(false); });
    }, 400);
    return () => { active = false; window.clearTimeout(timer); };
  }, [startAt, endAt, participantIds, timesValid, editing?.id]);

  const update = (patch: Partial<typeof form>) => {
    setForm((current) => {
      const next = { ...current, ...patch };
      // Keep the end after the start when the start date moves forward.
      if (patch.startDate && next.endDate < patch.startDate) next.endDate = patch.startDate;
      return next;
    });
    setConflicts([]);
  };

  const add = (option: ParticipantOption) => {
    setChosen((current) => (current.some((person) => person.id === option.id) ? current : [...current, option]));
    setQuery("");
    setOptions([]);
    setConflicts([]);
  };

  const remove = (id: string) => {
    setChosen((current) => current.filter((person) => person.id !== id));
    setConflicts([]);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!startAt || !endAt) return;
    setBusy(true);
    setError(null);
    setConflicts([]);
    const input = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      location: form.location.trim() || null,
      startAt,
      endAt,
      participantEmployeeIds: participantIds,
      confidential: form.confidential,
      notifyWhatsApp: form.notifyWhatsApp,
    };
    void (editing ? updateMeeting(editing.id, { ...input, expectedVersion: editing.version }) : createMeeting(input, idempotencyKey.current))
      .then((result) => {
        const missing = whatsappActive && form.notifyWhatsApp ? result.whatsappWithoutNumber.length : 0;
        const names = chosen.filter((person) => result.whatsappWithoutNumber.includes(person.id)).map((person) => person.name);
        onSaved(result.id, [
          editing ? "Perubahan rapat disimpan." : "Undangan rapat terkirim.",
          missing > 0 ? `Tanpa nomor WhatsApp: ${names.join(", ") || `${missing} peserta`}.` : null,
        ].filter(Boolean).join(" "));
      })
      .catch((cause) => {
        if (cause instanceof MeetingApiError && cause.code === "MEETING_CONFLICT" && cause.conflicts.length > 0) {
          setConflicts(cause.conflicts);
          setError("Jadwal bentrok. Ubah waktu atau peserta, lalu kirim lagi.");
        } else {
          setError(cause instanceof Error ? cause.message : "Rapat tidak dapat disimpan.");
        }
      })
      .finally(() => setBusy(false));
  };

  const input = "mt-1.5 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading";
  const label = "text-sm font-semibold text-brand-heading";
  const blocked = (availability?.conflicts.length ?? 0) > 0;
  const today = jakartaDate();

  return (
    <form onSubmit={submit} className="rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-bold text-brand-heading">{editing ? "Ubah rapat" : "Buat undangan rapat"}</h2>
        <button type="button" aria-label="Tutup formulir" onClick={onClose} className="rounded-lg p-1 hover:bg-muted">
          <X className="h-4 w-4" />
        </button>
      </div>

      {error ? <div role="alert" className="mt-4 rounded-2xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">{error}</div> : null}
      <IssueList issues={conflicts} tone="danger" />

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className={`${label} sm:col-span-2`}>
          Judul
          <input required minLength={3} maxLength={200} value={form.title} placeholder="Contoh: Rapat koordinasi kurikulum tahfidz"
            onChange={(event) => update({ title: event.target.value })} className={input} />
        </label>
        <label className={label}>
          Tanggal mulai
          <input type="date" required min={editing ? undefined : today} value={form.startDate}
            onChange={(event) => update({ startDate: event.target.value })} className={input} />
        </label>
        <label className={label}>
          Jam mulai (WIB)
          <input type="time" required step={300} value={form.startTime}
            onChange={(event) => update({ startTime: event.target.value })} className={input} />
        </label>
        <label className={label}>
          Tanggal selesai
          <input type="date" required min={form.startDate} max={addDays(form.startDate || today, 7)} value={form.endDate}
            onChange={(event) => update({ endDate: event.target.value })} className={input} />
        </label>
        <label className={label}>
          Jam selesai (WIB)
          <input type="time" required step={300} value={form.endTime}
            onChange={(event) => update({ endTime: event.target.value })} className={input} />
        </label>
        <label className={`${label} sm:col-span-2`}>
          Lokasi
          <input maxLength={255} value={form.location} placeholder="Contoh: Ruang guru lantai 2, atau tautan Zoom"
            onChange={(event) => update({ location: event.target.value })} className={input} />
        </label>
        <label className={`${label} sm:col-span-2`}>
          Keterangan <span className="font-normal text-muted-foreground">(hanya terlihat oleh peserta)</span>
          <textarea maxLength={3000} rows={3} value={form.description}
            onChange={(event) => update({ description: event.target.value })}
            className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal text-brand-heading" />
        </label>
      </div>

      <fieldset className="mt-4">
        <legend className={label}>Peserta</legend>
        <div className="relative mt-1.5">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ketik minimal 2 huruf nama pegawai"
            aria-label="Cari pegawai" role="combobox" aria-expanded={options.length > 0} aria-controls="meeting-participant-options"
            className={`${input} mt-0 pl-9`} />
          {searching ? <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
          {options.length > 0 ? (
            <ul id="meeting-participant-options" role="listbox"
              className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-2xl border border-border bg-surface-raised p-1 shadow-[var(--shadow-soft)]">
              {options.map((option) => (
                <li key={option.id} role="option" aria-selected={participantIds.includes(option.id)}>
                  <button type="button" onClick={() => add(option)}
                    className="flex w-full flex-col items-start rounded-xl px-3 py-2 text-left text-sm hover:bg-muted">
                    <span className="font-semibold text-brand-heading">{option.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {option.unitName ?? "Tanpa unit"}
                      {!option.hasAccount ? " · belum punya akun" : ""}
                      {whatsappActive && !option.hasWhatsApp ? " · tanpa nomor WA" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : query.trim().length >= 2 && !searching ? (
            <p className="mt-1 text-xs text-muted-foreground">Tidak ada pegawai aktif dengan nama itu.</p>
          ) : null}
        </div>
        {chosen.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">Belum ada peserta. Anda otomatis ikut sebagai penyelenggara.</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {chosen.map((person) => (
              <li key={person.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-3 py-1 text-xs font-semibold text-brand-heading">
                {person.name}
                {person.hasAccount === false ? <span className="font-normal text-muted-foreground">· belum punya akun</span> : null}
                <button type="button" aria-label={`Hapus ${person.name}`} onClick={() => remove(person.id)} className="ml-1 rounded-full p-0.5 hover:bg-muted">
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <div className="mt-4 space-y-2">
        <label className="flex items-start gap-3 text-sm text-brand-heading">
          <input type="checkbox" checked={form.confidential} onChange={(event) => update({ confidential: event.target.checked })} className="mt-1 h-4 w-4" />
          <span><span className="font-semibold">Rahasia</span> — pegawai lain hanya melihat "Sibuk" di kalender, tanpa judul dan lokasi.</span>
        </label>
        {whatsappActive ? (
          <label className="flex items-start gap-3 text-sm text-brand-heading">
            <input type="checkbox" checked={form.notifyWhatsApp} onChange={(event) => update({ notifyWhatsApp: event.target.checked })} className="mt-1 h-4 w-4" />
            <span><span className="font-semibold">Kirim juga lewat WhatsApp</span> — undangan, perubahan, dan pembatalan. Pengingat 30 menit sebelum rapat selalu dikirim.</span>
          </label>
        ) : (
          <p className="text-xs text-muted-foreground">
            Peserta menerima undangan dan pengingat sebagai notifikasi di HCIS. Pemberitahuan WhatsApp belum aktif.
          </p>
        )}
      </div>

      <section aria-live="polite" className="mt-4">
        <h3 className="text-sm font-bold text-brand-heading">Ketersediaan</h3>
        {!timesValid ? (
          <p className="mt-1 text-sm text-muted-foreground">Isi waktu mulai dan selesai untuk memeriksa jadwal peserta.</p>
        ) : availabilityError ? (
          <p className="mt-1 rounded-2xl border border-warning-line bg-warning-soft p-3 text-sm text-warning-ink">{availabilityError}</p>
        ) : checking && !availability ? (
          <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memeriksa jadwal...</p>
        ) : availability && availability.conflicts.length === 0 && availability.warnings.length === 0 ? (
          <p className="mt-1 rounded-2xl border border-success-line bg-success-soft p-3 text-sm text-success-ink">Semua peserta tersedia pada waktu ini.</p>
        ) : availability ? (
          <>
            <IssueList issues={availability.conflicts} tone="danger" />
            <IssueList issues={availability.warnings} tone="warning" />
          </>
        ) : null}
      </section>

      <div className="mt-5 flex flex-wrap gap-2">
        <button type="submit" disabled={busy || blocked || !timesValid || chosen.length === 0 || form.title.trim().length < 3}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {editing ? "Simpan perubahan" : "Kirim undangan"}
        </button>
        <button type="button" onClick={onClose} className="min-h-11 rounded-xl border border-border px-4 text-sm font-bold text-brand-heading">
          Batal
        </button>
      </div>
    </form>
  );
}
