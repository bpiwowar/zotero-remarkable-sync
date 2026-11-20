// Lightweight logging that avoids zotero-plugin-toolkit's console path (which is
// broken on Zotero 9: it calls the removed `ChromeUtils.import`). Writes to
// Zotero's debug log — visible in the `zotero-plugin serve` terminal and in
// Help → Debug Output Logging.

const PREFIX = "[remarkablesync]";

export function log(...args: unknown[]): void {
  try {
    const text = args
      .map((a) =>
        a instanceof Error
          ? `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`
          : typeof a === "string"
            ? a
            : safeStringify(a),
      )
      .join(" ");
    const line = `${PREFIX} ${text}`;
    // Debug log (serve terminal / Help -> Debug Output Logging). We deliberately
    // do NOT touch `window.console` — on Zotero 9 first access lazy-loads
    // Console.sys.mjs via the removed `ChromeUtils.import`, spamming warnings.
    Zotero.debug(line);
  } catch {
    // never let logging throw
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Normalise any thrown value into a readable string. */
export function errMsg(e: unknown): string {
  if (e === undefined) return "undefined error (no message)";
  if (e === null) return "null error";
  if (typeof e === "string") return e;
  // Errors thrown from Zotero's realm fail `instanceof Error` here, and their
  // message/stack are non-enumerable (so JSON.stringify gives "{}"). Read the
  // common properties defensively.
  const a = e as any;
  if (typeof a.message === "string" && a.message) return a.message;
  if (typeof a.name === "string" && a.name) return a.name;
  try {
    const s = a.toString?.();
    if (s && s !== "[object Object]") return s;
  } catch {
    /* ignore */
  }
  return safeStringify(e);
}
