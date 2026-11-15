// Sync status of a PDF attachment or a paper, and the icon that shows it. The
// item tree (column.ts) and the item pane section (ui.ts) share both, so the
// pane's legend documents the icons of the item tree.

import {
  getRecordCached,
  lastSyncedCached,
  type SyncRecord,
} from "./sync/state";
import { getSyncTag } from "./sync/engine";
import { pushFingerprint } from "./sync/annotations";

/** Synced within this window counts as "recently". */
const FRESH_MS = 24 * 60 * 60 * 1000;
const PUSHABLE = new Set(["highlight", "underline", "ink"]);

export type SyncState = "fresh" | "stale" | "changed" | "never" | "";

/** Order of the legend, and which state a paper shows for several PDFs. */
export const STATES: Exclude<SyncState, "">[] = [
  "changed",
  "never",
  "fresh",
  "stale",
];

const COLORS: Record<Exclude<SyncState, "">, string> = {
  fresh: "#3fae4a",
  stale: "#9b9b9b",
  changed: "#e67e22",
  never: "#9b9b9b",
};

/** True if the PDF has Zotero-side changes not yet on the device. */
function isDirty(att: Zotero.Item, rec: SyncRecord): boolean {
  // Already-pushed annotation key -> its fingerprint when pushed, to tell a
  // brand-new annotation from an edited one (same key).
  const pushedSig = new Map<string, string | undefined>();
  for (const p of rec.pushedItems ?? []) pushedSig.set(p.key, p.rev);
  const pulled = new Set(rec.annotationKeys ?? []);
  const present = new Set<string>();
  for (const a of att.getAnnotations()) {
    if (!PUSHABLE.has(a.annotationType) || pulled.has(a.key)) continue;
    present.add(a.key);
    if (!pushedSig.has(a.key)) return true; // never pushed
    const was = pushedSig.get(a.key);
    if (was && pushFingerprint(a) !== was) return true; // edited since pushed
  }
  // A pulled annotation deleted in Zotero is still on the device until the
  // next push.
  for (const key of Object.keys(rec.annotationSources ?? {})) {
    const it = Zotero.Items.getByLibraryAndKey(att.libraryID, key);
    if (!it || (it as Zotero.Item).deleted) return true;
  }
  // A pushed annotation deleted in Zotero is still on the device too.
  for (const key of pushedSig.keys()) if (!present.has(key)) return true;
  return false;
}

/** Status of one PDF attachment ("" when not synced). */
export function pdfState(att: Zotero.Item): SyncState {
  const rec = getRecordCached(att.key);
  if (!rec) return att.hasTag(getSyncTag()) ? "never" : "";
  if (isDirty(att, rec)) return "changed";
  const at = lastSyncedCached(att.key) ?? 0;
  return Date.now() - at < FRESH_MS ? "fresh" : "stale";
}

/** The PDF attachments of a paper, or the PDF itself. */
export function pdfsOf(item: Zotero.Item): Zotero.Item[] {
  if (item?.isPDFAttachment?.()) return [item];
  if (!item?.isRegularItem?.()) return [];
  return Zotero.Items.get(item.getAttachments()).filter((a) =>
    a.isPDFAttachment(),
  );
}

/** Status of a paper (its most pressing PDF state) or of a PDF. */
export function stateOf(item: Zotero.Item): SyncState {
  const states = new Set(pdfsOf(item).map(pdfState));
  return STATES.find((s) => states.has(s)) ?? "";
}

/** Icon outlines on a 16×16 grid (stroked, no fill). */
const SHAPES: Record<Exclude<SyncState, "">, string[]> = {
  // check mark: synced
  fresh: ["M3 8.5 6.5 12 13 4.5"],
  stale: ["M3 8.5 6.5 12 13 4.5"],
  // arrow up: changes to send
  changed: ["M8 13.5V3", "M3.5 7.5 8 3l4.5 4.5"],
  // clock: waiting for the first sync
  never: [
    "M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 1 0 0-12.5",
    "M8 4.5V8l2.5 1.75",
  ],
};

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The status icon: a check mark (green: synced recently; grey: synced
 * earlier), an orange arrow up (changes waiting to be sent) or a grey clock
 * (waiting for its first sync), all the same size.
 */
export function statusIcon(
  doc: Document,
  state: Exclude<SyncState, "">,
  size = 12,
): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg") as unknown as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  Object.assign(svg.style, {
    flex: "none",
    verticalAlign: "middle",
    overflow: "visible",
  });
  for (const d of SHAPES[state]) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", COLORS[state]);
    path.setAttribute("stroke-width", "2.2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
  }
  return svg;
}
