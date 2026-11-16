// URL helpers for the DetailDialog pop-ups (components/DetailDialog.tsx).

/**
 * Swap the value of an open pop-up's URL parameter without adding a history entry, for example
 * `?claim=baru` becoming `?claim=<id>` once the new draft is saved, so Back still closes the pop-up
 * instead of reopening an empty form. `sq:dialog` is the event useDialogParam listens to.
 */
export function replaceDialogParam(name: string, value: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(name, value);
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event("sq:dialog"));
}
