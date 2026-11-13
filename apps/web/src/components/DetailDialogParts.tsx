// Small pieces shared by the employee pages that show an item in a DetailDialog pop-up.

import { Loader2 } from "lucide-react";

/** Shown inside the pop-up while the item named in the URL is being fetched. */
export function DialogLoading({ label = "Memuat..." }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {label}
    </div>
  );
}

/**
 * The page's error and notice, shown inside the pop-up while it is open: the banners on the page
 * sit behind the dimmed backdrop, so the result of an action taken in the pop-up must show here.
 */
export function DialogMessages({ error, notice }: { error?: string | null; notice?: string | null }) {
  if (!error && !notice) return null;
  return (
    <div className="mb-4 space-y-2">
      {error ? <div role="alert" className="rounded-2xl border border-danger-line bg-danger-soft p-3 text-sm text-danger-ink">{error}</div> : null}
      {notice ? <div role="status" className="rounded-2xl border border-border bg-surface p-3 text-sm text-brand-heading">{notice}</div> : null}
    </div>
  );
}
