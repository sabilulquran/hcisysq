/**
 * Helpers next to `DetailDialog` / `useDialogParam` (components/DetailDialog.tsx).
 *
 * `replaceDialogParam` swaps the open pop-up's value in place, for example after "Simpan" turns a
 * create form (`?program=baru`) into the new item (`?program=<id>`). It replaces the history entry
 * instead of pushing one, so Back still returns to the list. `useDialogParam` listens for the
 * `sq:dialog` event and re-reads the URL.
 */
export function replaceDialogParam(name: string, value: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(name, value);
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event("sq:dialog"));
}

/**
 * A pop-up scrolls inside a fixed layer on screen. When a printable document inside it (surat
 * tugas, SK) is printed, render this in a `<style>` so the layer flows like a page and is not clipped.
 */
export const DIALOG_PRINT_CSS = `
  @media print {
    [role="presentation"]:has(> [role="dialog"]), [role="dialog"] {
      position: static !important; overflow: visible !important; max-height: none !important; height: auto !important;
    }
  }
`;
