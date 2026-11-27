// rmapi-js relies on ambient Web API globals (`fetch`, `crypto.subtle`,
// `TextEncoder`). Zotero's bootstrap sandbox does not reliably expose them, so
// we source them from a main Zotero window. That window is privileged
// (chrome), so its `fetch` performs cross-origin requests without CORS issues —
// exactly what we need to reach the reMarkable cloud.

import { liveMainWindow } from "./window";

let ensured = false;

// Abort a single reMarkable HTTP request after this long (per request, not per
// sync). Uploads of large PDFs are chunked, so no single request should approach
// this.
const FETCH_TIMEOUT_MS = 90_000;

/**
 * Expose a main-window global on the sandbox, resolved on every access: Zotero
 * 11 has several main windows and any may close, so binding to one window would
 * leave a dead wrapper ("can't access dead object") once it is gone.
 */
function windowGlobal(g: any, name: string): void {
  if (typeof g[name] !== "undefined") return;
  Object.defineProperty(g, name, {
    configurable: true,
    enumerable: false,
    get: () => liveWindow()[name],
  });
}

function liveWindow(): any {
  const win = liveMainWindow();
  if (!win) {
    throw new Error(
      "reMarkable Sync: no Zotero main window available to source network globals",
    );
  }
  return win;
}

export function ensureNetworkGlobals(): void {
  if (ensured) return;
  const g = globalThis as any;
  liveWindow(); // fail early, with a clear message, when there is no window
  if (typeof g.fetch === "undefined") {
    // The reMarkable cloud occasionally accepts a connection then never replies;
    // rmapi-js has no per-request timeout, so a single stalled request hangs the
    // whole sync ("Resolving reMarkable folder…" forever). Abort after a generous
    // window so a stall surfaces as an error we can report and retry.
    g.fetch = (input: any, init: any = {}) => {
      const win = liveWindow();
      // Call with the window as `this`, otherwise Gecko throws "illegal invocation".
      if (init?.signal) return win.fetch(input, init); // caller manages its own
      const ctrl = new win.AbortController();
      const timer = win.setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      return win
        .fetch(input, { ...init, signal: ctrl.signal })
        .finally(() => win.clearTimeout(timer));
    };
  }
  for (const name of [
    "Headers",
    "Request",
    "Response",
    "Blob",
    "AbortController",
    "crypto",
    "TextEncoder",
    "TextDecoder",
  ]) {
    windowGlobal(g, name);
  }
  ensured = true;
}
