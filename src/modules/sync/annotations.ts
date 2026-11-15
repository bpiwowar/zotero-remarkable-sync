// Create native Zotero annotations (highlights + ink) on a PDF attachment from
// parsed reMarkable pages.
//
// Pull mirrors the device for annotations *we* created: device annotations are
// deduped by a content signature against what is on the attachment, missing
// ones are created, and ours that vanished from the device are removed. The
// user's own annotations are never touched, and neither is any comment or tag
// the user added to a pulled annotation (see applyAnnotations).

import {
  rectToZotero,
  strokeToPath,
  inkWidth,
  pageSizeAt,
  type PdfPageSize,
} from "../remarkable/geometry";
import type { RmDocPage, RmPageTags } from "../remarkable/rmdoc";
import type { RmHighlight, RmStroke } from "../remarkable/rmlines";
import { rmToZoteroHex } from "../remarkable/colors";
import { log, errMsg } from "../../utils/log";

// Zotero object-key charset (excludes 0/1/I/O).
const KEY_CHARS = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";

function generateKey(): string {
  const gen = (Zotero as any).DataObjectUtilities?.generateKey;
  if (typeof gen === "function") return gen();
  let k = "";
  for (let i = 0; i < 8; i++) {
    k += KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)];
  }
  return k;
}

function colorToHex(
  colorIndex: number,
  rgba?: [number, number, number, number],
): string {
  return rmToZoteroHex(colorIndex, rgba);
}

/**
 * Join consecutive same-colour GlyphRanges that sit on adjacent lines into one
 * highlight, so a multi-line highlight becomes a single multi-rect Zotero
 * highlight (the inverse of how push splits per line).
 */
function mergeHighlights(hls: RmHighlight[]): RmHighlight[] {
  const out: RmHighlight[] = [];
  for (const hl of hls) {
    if (!hl.rects.length) continue;
    const prev = out[out.length - 1];
    const last = prev?.rects[prev.rects.length - 1];
    const first = hl.rects[0];
    const sameColor =
      prev &&
      prev.colorIndex === hl.colorIndex &&
      JSON.stringify(prev.rgba) === JSON.stringify(hl.rgba);
    // Next line: first rect sits just below the previous last rect.
    const gap = last ? first.y - (last.y + last.h) : Infinity;
    const adjacent = !!last && gap > -last.h * 0.5 && gap < last.h * 0.8;
    if (prev && sameColor && adjacent) {
      prev.rects.push(...hl.rects);
      if (hl.text) prev.text = prev.text ? `${prev.text} ${hl.text}` : hl.text;
    } else {
      out.push({ ...hl, rects: [...hl.rects] });
    }
  }
  return out;
}

function sortIndex(pageIndex: number, yFromTop: number): string {
  const top = Math.max(0, Math.min(99999, Math.round(yFromTop)));
  return [
    String(pageIndex).padStart(5, "0"),
    "000000",
    String(top).padStart(5, "0"),
  ].join("|");
}

// --- Content signatures (for dedup against existing annotations) ------------

function sig(
  type: string,
  pageIndex: number,
  x: number,
  y: number,
  extra = "",
): string {
  return `${type}|${pageIndex}|${Math.round(x)}|${Math.round(y)}|${extra}`;
}

/** Signature of an annotation already saved in Zotero. */
export function existingSig(item: Zotero.Item): string | null {
  try {
    const type = item.annotationType;
    const pos = JSON.parse(item.annotationPosition) as {
      pageIndex: number;
      rects?: number[][];
      paths?: number[][];
    };
    if (type === "highlight" || type === "underline") {
      const r = pos.rects?.[0];
      if (!r) return null;
      return sig(
        type,
        pos.pageIndex,
        r[0],
        r[1],
        (item.annotationText || "").slice(0, 24),
      );
    }
    if (type === "ink") {
      const p = pos.paths?.[0];
      if (!p || p.length < 2) return null;
      return sig("ink", pos.pageIndex, p[0], p[1]);
    }
    if (type === "note") {
      const names = pageTagNames(item.annotationComment);
      const r = pos.rects?.[0];
      if (!names || !r) return null;
      return pageTagSig(pos.pageIndex, r[0], r[1], names);
    }
  } catch {
    /* ignore unparseable */
  }
  return null;
}

/**
 * Fingerprint of everything that is pushed to the device for a Zotero
 * annotation (type, colour, text, exact position), to detect edits since push.
 */
export function pushFingerprint(item: Zotero.Item): string {
  return [
    item.annotationType,
    item.annotationColor ?? "",
    item.annotationText ?? "",
    item.annotationPosition ?? "",
  ].join("\u0000");
}

async function save(
  attachment: Zotero.Item,
  json: Record<string, unknown>,
  key: string = generateKey(),
): Promise<string | null> {
  try {
    await Zotero.Annotations.saveFromJSON(attachment, { key, ...json } as any);
    return key;
  } catch (e) {
    log(`saveAnnotation(${json.type}) failed:`, errMsg(e));
    return null;
  }
}

// --- User edits (comment / tags) on pulled annotations ----------------------

/**
 * True if the user added a comment or tags to this annotation in Zotero. For a
 * page-tag note, only tags that are not device tags count (a device tag the user
 * removed is pushed to the device, not kept as an edit).
 */
function isUserEdited(item: Zotero.Item): boolean {
  try {
    const tags = item.getTags().map((t) => t.tag);
    const names = pageTagNames(item.annotationComment);
    if (names) {
      const set = new Set(names);
      return tags.some((t) => !set.has(t));
    }
    return !!item.annotationComment?.trim() || tags.length > 0;
  } catch {
    return false;
  }
}

/**
 * Comment and tags for the in-place update of an edited annotation `a` to the
 * device's `p`: keep the user's comment (unless it is our generated page-tag
 * text, then take the new one) and the user's own tags, plus the device tags.
 */
function mergedEdits(
  a: Zotero.Item,
  p: Pending,
): { comment: string; tags: { name: string; type: number }[] } {
  const generated = pageTagNames(a.annotationComment);
  const comment = generated
    ? String(p.json.comment ?? "")
    : (a.annotationComment ?? "");
  const tags = new Map<string, number>();
  for (const t of (p.json.tags as { name: string }[] | undefined) ?? []) {
    tags.set(t.name, 0);
  }
  for (const t of a.getTags()) {
    if (generated?.includes(t.tag)) continue; // old device tag
    tags.set(t.tag, t.type ?? 0);
  }
  return {
    comment,
    tags: [...tags].map(([name, type]) => ({ name, type })),
  };
}

type BBox = [number, number, number, number];

/** Bounding box of an annotation position (rects or ink paths). */
function positionBBox(pos: {
  rects?: number[][];
  paths?: number[][];
}): BBox | null {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const r of pos.rects ?? []) {
    x0 = Math.min(x0, r[0]);
    y0 = Math.min(y0, r[1]);
    x1 = Math.max(x1, r[2]);
    y1 = Math.max(y1, r[3]);
  }
  for (const p of pos.paths ?? []) {
    for (let i = 0; i + 1 < p.length; i += 2) {
      x0 = Math.min(x0, p[i]);
      x1 = Math.max(x1, p[i]);
      y0 = Math.min(y0, p[i + 1]);
      y1 = Math.max(y1, p[i + 1]);
    }
  }
  return x0 <= x1 && y0 <= y1 ? [x0, y0, x1, y1] : null;
}

function overlapArea(a: BBox, b: BBox): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Among the not-yet-consumed pendings, find the one that most likely replaces
 * `item` on the device: same type, same page, largest overlapping area.
 */
function findReplacement(
  item: Zotero.Item,
  pendings: Pending[],
  consumed: Set<Pending>,
): Pending | null {
  let pos: { pageIndex: number; rects?: number[][]; paths?: number[][] };
  try {
    pos = JSON.parse(item.annotationPosition);
  } catch {
    return null;
  }
  const box = positionBBox(pos);
  if (!box) return null;
  let best: Pending | null = null;
  let bestArea = 0;
  for (const p of pendings) {
    if (consumed.has(p) || p.json.type !== item.annotationType) continue;
    const ppos = p.json.position as typeof pos;
    if (ppos.pageIndex !== pos.pageIndex) continue;
    const pbox = positionBBox(ppos);
    const area = pbox ? overlapArea(box, pbox) : 0;
    if (area > bestArea) {
      best = p;
      bestArea = area;
    }
  }
  return best;
}

// --- Builders ---------------------------------------------------------------

interface Pending {
  signature: string;
  json: Record<string, unknown>;
}

function buildHighlight(
  pageIndex: number,
  hl: RmHighlight,
  size: PdfPageSize,
): Pending | null {
  const rects = hl.rects.map((r) => rectToZotero(r, size));
  if (!rects.length) return null;
  log(
    `pull HL colorIndex=${hl.colorIndex} rgba=${JSON.stringify(hl.rgba)} text=${JSON.stringify(
      hl.text.slice(0, 16),
    )}`,
  );
  const topY = Math.max(...rects.map((r) => r[3]));
  return {
    signature: sig(
      "highlight",
      pageIndex,
      rects[0][0],
      rects[0][1],
      (hl.text || "").slice(0, 24),
    ),
    json: {
      type: "highlight",
      color: colorToHex(hl.colorIndex, hl.rgba),
      pageLabel: String(pageIndex + 1),
      sortIndex: sortIndex(pageIndex, size.height - topY),
      position: { pageIndex, rects },
      text: hl.text ?? "",
      comment: "",
    },
  };
}

/**
 * A freehand (non-snapping) highlighter stroke. Rendered as a translucent
 * Zotero highlight (bounding rect) rather than opaque ink so the text underneath
 * stays readable.
 */
function buildHighlighterStroke(
  pageIndex: number,
  stroke: RmStroke,
  size: PdfPageSize,
): Pending | null {
  const path = strokeToPath(stroke.points, size);
  if (path.length < 4) return null;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (let i = 0; i < path.length; i += 2) {
    minX = Math.min(minX, path[i]);
    maxX = Math.max(maxX, path[i]);
    minY = Math.min(minY, path[i + 1]);
    maxY = Math.max(maxY, path[i + 1]);
  }
  const halfW = inkWidth(stroke.pointWidth) / 2;
  const rect: [number, number, number, number] = [
    minX,
    minY - halfW,
    maxX,
    maxY + halfW,
  ];
  return {
    signature: sig("highlight", pageIndex, rect[0], rect[1], "fh"),
    json: {
      type: "highlight",
      color: colorToHex(stroke.colorIndex, stroke.rgba),
      pageLabel: String(pageIndex + 1),
      sortIndex: sortIndex(pageIndex, size.height - rect[3]),
      position: { pageIndex, rects: [rect] },
      text: "",
      comment: "",
    },
  };
}

// --- Page tags --------------------------------------------------------------

/** Comment prefix identifying a note created from reMarkable page tags. */
const PAGE_TAG_PREFIX = "reMarkable page tags: ";
/** Note icon size and margin from the page's top-left corner, in PDF points. */
const NOTE_SIZE = 22;
const NOTE_MARGIN = 8;

function pageTagComment(names: string[]): string {
  return PAGE_TAG_PREFIX + names.join(", ");
}

/** Tag names encoded in a page-tag note's comment, or null if not one. */
export function pageTagNames(
  comment: string | undefined | null,
): string[] | null {
  if (!comment?.startsWith(PAGE_TAG_PREFIX)) return null;
  return comment
    .slice(PAGE_TAG_PREFIX.length)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

function pageTagSig(
  pageIndex: number,
  x: number,
  y: number,
  names: string[],
): string {
  return sig("note", pageIndex, x, y, `tags:${[...names].sort().join(",")}`);
}

/**
 * A note annotation in the page's top-left corner carrying the page's device
 * tags as Zotero tags (filterable in the reader sidebar / tag selector).
 */
function buildPageTagNote(
  pageIndex: number,
  names: string[],
  size: PdfPageSize,
): Pending {
  const x1 = NOTE_MARGIN;
  const y2 = size.height - NOTE_MARGIN;
  const rect = [x1, y2 - NOTE_SIZE, x1 + NOTE_SIZE, y2];
  return {
    signature: pageTagSig(pageIndex, rect[0], rect[1], names),
    json: {
      type: "note",
      color: "#ffd400",
      pageLabel: String(pageIndex + 1),
      sortIndex: sortIndex(pageIndex, 0),
      position: { pageIndex, rects: [rect] },
      comment: pageTagComment(names),
      tags: names.map((name) => ({ name })),
    },
  };
}

function buildInk(
  pageIndex: number,
  stroke: RmStroke,
  size: PdfPageSize,
): Pending | null {
  const path = strokeToPath(stroke.points, size);
  if (path.length < 4) return null;
  let topY = 0;
  for (let i = 1; i < path.length; i += 2) topY = Math.max(topY, path[i]);
  return {
    signature: sig("ink", pageIndex, path[0], path[1]),
    json: {
      type: "ink",
      color: colorToHex(stroke.colorIndex, stroke.rgba),
      pageLabel: String(pageIndex + 1),
      sortIndex: sortIndex(pageIndex, size.height - topY),
      position: {
        pageIndex,
        paths: [path],
        width: inkWidth(stroke.pointWidth),
      },
      comment: "",
    },
  };
}

export interface ApplyResult {
  /** updated full set of keys for annotations this plugin created on pull */
  keys: string[];
  added: number;
  removed: number;
  /** pulled annotations with user edits updated in place to match the device */
  updated: number;
}

/**
 * Mirror the device's annotations onto the attachment:
 *  - add device annotations not already present,
 *  - remove annotations WE previously pulled (`ourKeys`) that have disappeared
 *    from the device.
 * Never touches the user's own annotations. Returns the updated key set.
 */
export async function applyAnnotations(
  attachment: Zotero.Item,
  docPages: RmDocPage[],
  sizes: PdfPageSize[],
  ourKeys: string[] = [],
  deletedSigs: string[] = [],
  pageTags: RmPageTags[] = [],
): Promise<ApplyResult> {
  const suppressed = new Set(deletedSigs);
  // Build the device's current set: pendings to create + their signatures.
  const pendings: Pending[] = [];
  const incoming = new Set<string>();
  for (const { pdfPageIndex, names } of pageTags) {
    const p = buildPageTagNote(
      pdfPageIndex,
      names,
      pageSizeAt(sizes, pdfPageIndex),
    );
    pendings.push(p);
    incoming.add(p.signature);
  }
  for (const { pdfPageIndex, page } of docPages) {
    const size = pageSizeAt(sizes, pdfPageIndex);
    const built = [
      ...mergeHighlights(page.highlights).map((hl) =>
        buildHighlight(pdfPageIndex, hl, size),
      ),
      ...page.strokes.map((st) =>
        st.isHighlighter
          ? buildHighlighterStroke(pdfPageIndex, st, size)
          : buildInk(pdfPageIndex, st, size),
      ),
    ];
    for (const p of built) {
      if (p) {
        pendings.push(p);
        incoming.add(p.signature);
      }
    }
  }

  const ourSet = new Set(ourKeys);
  const present = new Set<string>();
  const keptKeys: string[] = [];
  const edited: Zotero.Item[] = [];
  let removed = 0;

  // Pass over existing annotations: delete ours that vanished; index the rest.
  for (const a of attachment.getAnnotations()) {
    const s = existingSig(a);
    if (ourSet.has(a.key)) {
      if (s && incoming.has(s)) {
        keptKeys.push(a.key);
        present.add(s);
      } else if (isUserEdited(a)) {
        edited.push(a); // never lose the user's comment/tags — resolved below
      } else {
        try {
          await a.eraseTx();
          removed++;
        } catch {
          keptKeys.push(a.key); // couldn't delete — keep tracking it
        }
      }
    } else if (s) {
      present.add(s); // user's own annotation — never touched, used for dedup
    }
  }

  // A pulled annotation the user commented/tagged vanished from the device.
  // If the device annotation was merely modified (extended, re-drawn), update
  // the Zotero one in place — same key, so links from notes keep working —
  // preserving its comment and tags. If it was deleted on the device, keep it
  // and stop tracking it: it becomes the user's own annotation.
  const consumed = new Set<Pending>();
  for (const p of pendings) {
    if (present.has(p.signature) || suppressed.has(p.signature))
      consumed.add(p);
  }
  let updated = 0;
  for (const a of edited) {
    const p = findReplacement(a, pendings, consumed);
    if (p) {
      const json = { ...p.json, ...mergedEdits(a, p) };
      if (await save(attachment, json, a.key)) {
        consumed.add(p);
        present.add(p.signature);
        keptKeys.push(a.key);
        updated++;
        continue;
      }
    }
    log(`pull: keeping edited annotation ${a.key} (gone from device)`);
    const s = existingSig(a);
    if (s) present.add(s);
  }

  // Add device annotations not already present (and not deleted in Zotero).
  const newKeys: string[] = [];
  for (const p of pendings) {
    if (present.has(p.signature) || suppressed.has(p.signature)) continue;
    const key = await save(attachment, p.json);
    if (key) {
      present.add(p.signature);
      newKeys.push(key);
    }
  }

  return {
    keys: [...keptKeys, ...newKeys],
    added: newKeys.length,
    removed,
    updated,
  };
}
