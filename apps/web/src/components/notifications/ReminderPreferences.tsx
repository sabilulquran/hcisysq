// NOTIF-003 §6 "Pengaturan pengingat": per rule, whether a reminder is also sent by WhatsApp.
// In-app reminders cannot be turned off (D-08). The API owns the catalog and the stored values.

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

export interface ReminderPreference {
  ruleKey: string;
  label: string;
  description: string;
  inApp: boolean;
  whatsapp: boolean;
  whatsappDefault: boolean;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { message?: string } | null;
  if (!response.ok) throw new Error((body as { message?: string } | null)?.message ?? "Pengaturan pengingat tidak dapat diproses.");
  return body as T;
}

export async function getReminderPreferences() {
  return (await readJson<{ items: ReminderPreference[] }>(await fetch("/api/me/reminders/preferences", {
    credentials: "include", headers: { Accept: "application/json" },
  }))).items;
}

export async function setReminderWhatsApp(ruleKey: string, whatsapp: boolean) {
  return (await readJson<{ items: ReminderPreference[] }>(await fetch(`/api/me/reminders/preferences/${encodeURIComponent(ruleKey)}`, {
    method: "PUT",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ whatsapp }),
  }))).items;
}

export function ReminderPreferenceList({ items, busyRule, onToggle }: {
  items: ReminderPreference[];
  busyRule: string | null;
  onToggle: (ruleKey: string, whatsapp: boolean) => void;
}) {
  return (
    <ul className="divide-y divide-border/70">
      {items.map((item) => (
        <li key={item.ruleKey} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-brand-heading">{item.label}</p>
            <p className="text-xs leading-5 text-muted-foreground">{item.description}</p>
          </div>
          <label className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-brand-heading">
            <input
              type="checkbox"
              checked={item.whatsapp}
              disabled={busyRule !== null}
              onChange={(event) => onToggle(item.ruleKey, event.target.checked)}
              className="h-5 w-5"
            />
            WhatsApp
          </label>
        </li>
      ))}
    </ul>
  );
}

export function ReminderPreferences() {
  const [items, setItems] = useState<ReminderPreference[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [busyRule, setBusyRule] = useState<string | null>(null);

  useEffect(() => {
    getReminderPreferences()
      .then((loaded) => { setItems(loaded); setState("ready"); })
      .catch((cause: unknown) => { setMessage(cause instanceof Error ? cause.message : null); setState("error"); });
  }, []);

  const toggle = async (ruleKey: string, whatsapp: boolean) => {
    setBusyRule(ruleKey);
    setMessage(null);
    try {
      setItems(await setReminderWhatsApp(ruleKey, whatsapp));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Pengaturan belum tersimpan.");
    } finally {
      setBusyRule(null);
    }
  };

  return (
    <section className="mt-5 rounded-3xl border border-border/75 bg-surface-raised p-5 shadow-[var(--shadow-soft)]">
      <h2 className="text-sm font-bold text-brand-heading">Pengaturan pengingat</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Pengingat selalu masuk ke Notifikasi ini antara pukul 06.00 dan 21.00 WIB. Pilih pengingat yang juga dikirim lewat WhatsApp ke
        nomor di Data Saya. Pengingat hanya Anda terima bila menyangkut tugas atau data Anda.
      </p>
      {message ? <p role="alert" className="mt-3 text-sm text-danger-ink">{message}</p> : null}
      {state === "loading" ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Memuat pengaturan...</p>
      ) : state === "error" ? (
        <p className="mt-3 text-sm text-muted-foreground">Pengaturan pengingat belum dapat dimuat.</p>
      ) : (
        <div className="mt-2"><ReminderPreferenceList items={items} busyRule={busyRule} onToggle={(key, value) => void toggle(key, value)} /></div>
      )}
    </section>
  );
}
