// TRAIN-001 R3: one evaluation form, as a participant, supervisor or HC answers it. The items
// come from the API without answer keys; the API validates and scores what is sent.

import { useState } from "react";

import {
  formatScore,
  missingRequired,
  SCALE_LABELS,
  type Answers,
  type EvaluationForm,
  type Item,
  type Submitted,
} from "@/lib/trainingEvaluation";

const box = "mt-1 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm font-normal text-brand-heading";
const primary = "inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-primary px-4 text-sm font-bold text-brand-foreground disabled:opacity-50";

function ItemField({ item, value, onChange }: { item: Item; value: Answers[string] | undefined; onChange: (value: Answers[string] | undefined) => void }) {
  const id = item.id ?? "";
  if (item.type === "SCALE" || item.type === "CRITERION") {
    const levels = item.type === "SCALE" ? SCALE_LABELS : item.levels ?? [];
    return (
      <div role="radiogroup" aria-label={item.prompt} className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {levels.map((text, position) => (
          <label key={position} className={`flex min-h-11 cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-xs ${value === position + 1 ? "border-brand-primary bg-muted" : "border-border"}`}>
            <input type="radio" name={id} checked={value === position + 1} onChange={() => onChange(position + 1)} className="mt-0.5" />
            <span><span className="font-bold">{position + 1}</span> {text}</span>
          </label>
        ))}
      </div>
    );
  }
  if (item.type === "CHOICE" || item.type === "SINGLE") {
    return (
      <div role="radiogroup" aria-label={item.prompt} className="mt-2 space-y-2">
        {(item.options ?? []).map((text, position) => (
          <label key={position} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-border px-3 text-sm">
            <input type="radio" name={id} checked={value === position} onChange={() => onChange(position)} />
            {text}
          </label>
        ))}
      </div>
    );
  }
  if (item.type === "MULTI") {
    const picked = Array.isArray(value) ? value : [];
    return (
      <div className="mt-2 space-y-2">
        {(item.options ?? []).map((text, position) => (
          <label key={position} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-border px-3 text-sm">
            <input type="checkbox" checked={picked.includes(position)}
              onChange={(event) => {
                const next = event.target.checked ? [...picked, position] : picked.filter((entry) => entry !== position);
                onChange(next.length ? next.sort((a, b) => a - b) : undefined);
              }} />
            {text}
          </label>
        ))}
      </div>
    );
  }
  if (item.type === "TRUE_FALSE") {
    return (
      <div role="radiogroup" aria-label={item.prompt} className="mt-2 flex gap-2">
        {([[true, "Benar"], [false, "Salah"]] as const).map(([option, text]) => (
          <label key={text} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-border px-4 text-sm">
            <input type="radio" name={id} checked={value === option} onChange={() => onChange(option)} />
            {text}
          </label>
        ))}
      </div>
    );
  }
  const long = item.type === "TEXT";
  return long ? (
    <textarea aria-label={item.prompt} maxLength={2000} rows={3} className={`${box} py-2`} value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value || undefined)} />
  ) : (
    <input aria-label={item.prompt} maxLength={200} className={box} value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value || undefined)} />
  );
}

/** Renders the form; `onSubmit` sends the answers and resolves with the API result. */
export function EvaluationFormView({ form, onSubmit }: { form: EvaluationForm; onSubmit: (answers: Answers) => Promise<Submitted> }) {
  const [answers, setAnswers] = useState<Answers>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Submitted | null>(null);

  if (result) {
    return (
      <div role="status" className="rounded-2xl border border-border bg-surface p-4 text-sm text-brand-heading">
        <p className="font-bold">Terima kasih, jawaban tersimpan.</p>
        {result.score !== null ? (
          <p className="mt-1">Skor Anda: <span className="font-bold">{formatScore(result.score)}</span>
            {result.pointsMax ? ` (${formatScore(result.pointsEarned)} dari ${formatScore(result.pointsMax)} poin)` : ""}</p>
        ) : null}
        {result.anonymous ? <p className="mt-1 text-xs text-muted-foreground">Jawaban disimpan tanpa nama Anda.</p> : null}
      </div>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const missing = missingRequired(form.items, answers);
    if (missing.length > 0) {
      setError(`Masih ada ${missing.length} butir wajib yang belum dijawab.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(await onSubmit(answers));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Jawaban tidak dapat dikirim.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {form.component.anonymous ? (
        <p className="rounded-2xl border border-border bg-surface p-3 text-xs text-muted-foreground">
          Formulir ini anonim: HC hanya tahu Anda sudah mengisi, bukan isi jawaban Anda.
        </p>
      ) : null}
      {form.subject ? <p className="text-sm text-brand-heading">Yang dinilai: <span className="font-bold">{form.subject.fullName}</span></p> : null}
      <ol className="space-y-4">
        {form.items.map((item, position) => (
          <li key={item.id ?? position} className="rounded-2xl border border-border/70 p-3">
            <p className="text-sm font-semibold text-brand-heading">
              {position + 1}. {item.prompt}
              {item.points ? <span className="ml-1 text-xs font-normal text-muted-foreground">({item.points} poin)</span> : null}
              {(item.type === "SCALE" || item.type === "CHOICE" || item.type === "TEXT") && item.required === false
                ? <span className="ml-1 text-xs font-normal text-muted-foreground">(opsional)</span> : null}
            </p>
            <ItemField item={item} value={answers[item.id ?? ""]}
              onChange={(value) => {
                const next = { ...answers };
                if (value === undefined) delete next[item.id ?? ""];
                else next[item.id ?? ""] = value;
                setAnswers(next);
              }} />
          </li>
        ))}
      </ol>
      {error ? <div role="alert" className="rounded-2xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">{error}</div> : null}
      <button type="submit" className={primary} disabled={busy}>Kirim jawaban</button>
      <p className="text-xs text-muted-foreground">Jawaban yang sudah dikirim tidak dapat diubah.</p>
    </form>
  );
}
