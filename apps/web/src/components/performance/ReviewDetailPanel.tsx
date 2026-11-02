// PERF-001 one review: rubric with self and rater scores side by side, the result once the server
// shows it, notes, history, and a slot for the actions the caller may take.

import { useState, type ReactNode } from "react";

import {
  eventLabel,
  formatPeriod,
  formatScore,
  formatTimestamp,
  raterSourceLabel,
  reviewStatusLabel,
  SCALE_OPTIONS,
  trendLabel,
  type ReviewDetail,
  type Rubric,
  type Scores,
} from "@/lib/performance";

export function ReviewDetailPanel({ review, actions, form }: { review: ReviewDetail; actions?: ReactNode; form?: ReactNode }) {
  const rater = review.rating?.scores ?? null;
  const self = review.selfAssessment?.scores ?? null;
  return (
    <div className="space-y-5 text-sm">
      <header>
        <p className="text-xs font-semibold text-muted-foreground">{review.cycleName} · {formatPeriod(review.periodStart, review.periodEnd)}</p>
        <h2 className="mt-1 text-lg font-bold text-brand-heading">{review.employeeName}</h2>
        <p className="text-xs text-muted-foreground">{review.employeeNumber}{review.unitName ? ` · ${review.unitName}` : ""}</p>
        <p className="mt-2 inline-flex rounded-full bg-muted px-3 py-1 text-xs font-bold text-brand-heading">{reviewStatusLabel(review.status)}</p>
        <dl className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
          <div><dt className="inline font-semibold">Penilai: </dt><dd className="inline">{review.raterName ?? "belum ada"} ({raterSourceLabel(review.raterSource)})</dd></div>
          <div><dt className="inline font-semibold">Batas penilaian diri: </dt><dd className="inline">{review.selfDueOn}</dd></div>
          {review.raterName && review.raterAccountReady === false ? (
            <div className="sm:col-span-2 text-danger-ink">Akun penilai belum aktif; penilaian menunggu akun itu diaktifkan.</div>
          ) : null}
        </dl>
      </header>

      {review.finalScore !== null ? (
        <div className="rounded-2xl border border-border/70 bg-surface p-4">
          <p className="text-xs font-semibold text-muted-foreground">Nilai akhir</p>
          <p className="mt-1 text-2xl font-bold text-brand-heading">
            {formatScore(review.finalScore)} <span className="text-base">· {review.predicateCode} {review.predicateLabel}</span>
          </p>
          {review.status === "HC_VALIDATION" ? <p className="mt-1 text-xs text-muted-foreground">Belum disahkan Human Capital.</p> : null}
          {review.trend ? <p className="mt-1 text-xs text-muted-foreground">{trendLabel(review.trend)}</p> : null}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr><th className="py-2 pr-3">Indikator</th><th className="py-2 pr-3">Bobot</th><th className="py-2 pr-3">Diri</th><th className="py-2">Penilai</th></tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {review.rubric.indicators.map((indicator) => (
              <tr key={indicator.code}>
                <td className="py-2 pr-3">
                  <span className="font-semibold text-brand-heading">{indicator.label}</span>
                  {indicator.description ? <span className="block text-xs text-muted-foreground">{indicator.description}</span> : null}
                </td>
                <td className="py-2 pr-3">{indicator.weight}%</td>
                <td className="py-2 pr-3">{self?.[indicator.code] ?? "-"}</td>
                <td className="py-2">{rater?.[indicator.code] ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {review.selfAssessment?.note ? <Note title="Catatan penilaian diri" text={review.selfAssessment.note} /> : null}
      {review.rating?.strengths ? <Note title="Kekuatan" text={review.rating.strengths} /> : null}
      {review.rating?.improvements ? <Note title="Area perbaikan" text={review.rating.improvements} /> : null}
      {review.rating?.note ? <Note title="Catatan penilai" text={review.rating.note} /> : null}
      {review.acknowledgementComment ? <Note title="Tanggapan pegawai" text={review.acknowledgementComment} /> : null}
      {review.removedReason && review.status === "REMOVED" ? <Note title="Alasan dikeluarkan" text={review.removedReason} /> : null}

      {form}
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}

      <section>
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Riwayat</h3>
        <ol className="mt-2 space-y-2">
          {review.events.map((event) => (
            <li key={event.id} className="text-xs">
              <span className="font-semibold text-brand-heading">{eventLabel(event.eventType)}</span>
              <span className="text-muted-foreground"> · {formatTimestamp(event.occurredAt)}{event.actorName ? ` · ${event.actorName}` : ""}</span>
              {event.note ? <span className="block text-muted-foreground">{event.note}</span> : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Note({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <p className="text-xs font-semibold text-muted-foreground">{title}</p>
      <p className="mt-1 whitespace-pre-line text-brand-heading">{text}</p>
    </div>
  );
}

const area = "mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal text-brand-heading";

/**
 * Self-assessment (notes only) or rating (strengths, improvements, notes). The server validates
 * the scores and computes the result; the form only collects one whole number per indicator.
 */
export function ScoreForm({ rubric, initial, initialText, kind, busy, onSubmit }: {
  rubric: Rubric;
  initial?: Scores | null;
  /** A returned rating keeps its written feedback; otherwise resubmitting would erase it. */
  initialText?: { strengths: string | null; improvements: string | null; note: string | null } | null;
  kind: "self" | "rating";
  busy: boolean;
  onSubmit: (input: { scores: Scores; strengths: string | null; improvements: string | null; note: string | null }) => void;
}) {
  const [scores, setScores] = useState<Scores>(() => ({ ...(initial ?? {}) }));
  const [strengths, setStrengths] = useState(initialText?.strengths ?? "");
  const [improvements, setImprovements] = useState(initialText?.improvements ?? "");
  const [note, setNote] = useState(initialText?.note ?? "");
  const complete = rubric.indicators.every((indicator) => scores[indicator.code] !== undefined);

  return (
    <form
      className="rounded-2xl border border-border/70 bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          scores,
          strengths: kind === "rating" ? strengths.trim() || null : null,
          improvements: kind === "rating" ? improvements.trim() || null : null,
          note: note.trim() || null,
        });
      }}
    >
      <h3 className="text-sm font-bold text-brand-heading">{kind === "self" ? "Penilaian diri" : "Nilai dari penilai"}</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {kind === "self"
          ? "Penilaian diri menjadi bahan pertimbangan penilai dan tidak dihitung ke nilai akhir."
          : "Nilai akhir dan predikat dihitung sistem dari bobot indikator, lalu disahkan Human Capital."}
      </p>
      <div className="mt-3 space-y-3">
        {rubric.indicators.map((indicator) => (
          <label key={indicator.code} className="block text-sm font-semibold text-brand-heading">
            {indicator.label} <span className="font-normal text-muted-foreground">({indicator.weight}%)</span>
            <select required value={scores[indicator.code] ?? ""} className="mt-1.5 h-11 w-full rounded-xl border bg-surface px-3 text-sm font-normal"
              onChange={(event) => setScores((current) => ({ ...current, [indicator.code]: Number(event.target.value) }))}>
              <option value="" disabled>Pilih nilai</option>
              {SCALE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        ))}
        {kind === "rating" ? (
          <>
            <label className="block text-sm font-semibold text-brand-heading">
              Kekuatan
              <textarea rows={2} maxLength={2000} value={strengths} onChange={(event) => setStrengths(event.target.value)} className={area} />
            </label>
            <label className="block text-sm font-semibold text-brand-heading">
              Area perbaikan
              <textarea rows={2} maxLength={2000} value={improvements} onChange={(event) => setImprovements(event.target.value)} className={area} />
            </label>
          </>
        ) : null}
        <label className="block text-sm font-semibold text-brand-heading">
          {kind === "self" ? "Capaian dan kendala (opsional)" : "Catatan penilai (opsional)"}
          <textarea rows={2} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} className={area} />
        </label>
      </div>
      <button type="submit" disabled={busy || !complete}
        className="mt-4 min-h-11 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50">
        {kind === "self" ? "Kirim penilaian diri" : "Kirim nilai"}
      </button>
    </form>
  );
}
