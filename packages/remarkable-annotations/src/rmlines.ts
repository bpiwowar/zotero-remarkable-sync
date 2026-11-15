// Read reMarkable v6 (`.rm`) pages: the pen/highlighter strokes (scene line
// items) and text highlights (glyph ranges) we sync with Zotero, plus the ids
// needed to append items to the page. Parsing is rmapi-js's (rmscene.ts); this
// module maps its blocks onto the plugin's types.
//
// Coordinates are in the reMarkable page coordinate system (x centred on the
// page, y from the top); mapping them onto PDF points happens in geometry.ts.

import type { CrdtId as SceneId } from "rmapi-js";
import { parseRmScene } from "./rmscene";

export interface RmPoint {
  x: number;
  y: number;
}

export interface RmStroke {
  /** reMarkable Pen tool id */
  tool: number;
  /** reMarkable PenColor index */
  colorIndex: number;
  /** explicit colour when present (highlighters), [r,g,b,a] 0-255 */
  rgba?: [number, number, number, number];
  /** thickness scale from the stroke (a pen-setting multiplier) */
  thickness: number;
  /** representative per-point pen width (reMarkable units; see geometry.inkWidth) */
  pointWidth: number;
  isHighlighter: boolean;
  points: RmPoint[];
  /** scene item id(s) on the page (set by parseRmPage) */
  ids?: CrdtId[];
}

export interface RmRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RmHighlight {
  text: string;
  colorIndex: number;
  rgba?: [number, number, number, number];
  rects: RmRect[];
  /** scene item id(s) on the page (set by parseRmPage; several once merged) */
  ids?: CrdtId[];
}

export interface CrdtId {
  part1: number;
  part2: number;
}

export interface RmPage {
  strokes: RmStroke[];
  highlights: RmHighlight[];
  /** the layer node items are parented to (for appending new items) */
  layerId?: CrdtId;
  /** the last item id within that layer (chain new items after this) */
  lastItemId?: CrdtId;
  /** highest author part1 seen (registered author to reuse for new items) */
  maxAuthor: number;
  /** highest part2 counter seen (mint new counters above this) */
  maxCounter: number;
  /** the page's author table (author id -> uuid) */
  authors: Map<number, string>;
}

const HIGHLIGHTER_TOOLS = new Set([5, 18]); // HIGHLIGHTER_1, HIGHLIGHTER_2

export const fromSceneId = (id: SceneId): CrdtId => ({
  part1: id.authorId,
  part2: id.counter,
});
export const toSceneId = (id: CrdtId): SceneId => ({
  authorId: id.part1,
  counter: id.part2,
});

/** [r,g,b,a] from a packed little-endian uint32 (BGRA bytes). */
export function unpackRgba(
  p: number | undefined,
): [number, number, number, number] | undefined {
  if (p === undefined) return undefined;
  return [(p >> 16) & 0xff, (p >> 8) & 0xff, p & 0xff, (p >>> 24) & 0xff];
}

export function packRgba(
  rgba: [number, number, number, number] | undefined,
): number | undefined {
  if (!rgba) return undefined;
  const [r, g, b, a] = rgba;
  return (b | (g << 8) | (r << 16) | (a << 24)) >>> 0;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Parse a single `.rm` v6 page into its strokes and highlights. */
export function parseRmPage(bytes: Uint8Array): RmPage {
  const strokes: RmStroke[] = [];
  const highlights: RmHighlight[] = [];
  let layerId: CrdtId | undefined;
  let lastItemId: CrdtId | undefined;
  let maxAuthor = 0;
  let maxCounter = 0;
  const authors = new Map<number, string>();

  for (const block of parseRmScene(bytes).blocks) {
    if (block.type === "authorIds") {
      for (const [id, uuid] of block.authors) authors.set(id, uuid);
      continue;
    }
    if ("item" in block && block.item?.itemId) {
      // Every scene item (tombstones and groups included) uses up a counter.
      maxCounter = Math.max(maxCounter, block.item.itemId.counter);
    }
    if (block.type !== "sceneLineItem" && block.type !== "sceneGlyphItem") {
      continue;
    }
    const parent = fromSceneId(block.parentId);
    const item = fromSceneId(block.item.itemId);
    layerId ??= parent;
    // Track the last item of the chosen layer (in file order), so new items
    // chain after a neighbour in the same CRDT sequence.
    if (parent.part1 === layerId.part1 && parent.part2 === layerId.part2) {
      lastItemId = item;
    }
    maxAuthor = Math.max(maxAuthor, item.part1, parent.part1);
    maxCounter = Math.max(maxCounter, item.part2, parent.part2);
    if (block.item.deletedLength !== 0) continue;

    if (block.type === "sceneLineItem") {
      const line = block.item.value;
      if (!line?.points.length) continue;
      strokes.push({
        tool: line.tool,
        colorIndex: line.color,
        rgba: unpackRgba(line.colorRgba),
        thickness: line.thicknessScale,
        pointWidth: median(line.points.map((p) => Math.round(p.width))),
        isHighlighter: HIGHLIGHTER_TOOLS.has(line.tool),
        points: line.points.map(({ x, y }) => ({ x, y })),
        ids: [item],
      });
    } else {
      const glyph = block.item.value;
      if (!glyph?.rectangles.length) continue;
      highlights.push({
        text: glyph.text,
        colorIndex: glyph.color,
        rgba: unpackRgba(glyph.colorRgba),
        rects: glyph.rectangles.map(({ x, y, w, h }) => ({ x, y, w, h })),
        ids: [item],
      });
    }
  }

  for (const id of authors.keys()) maxAuthor = Math.max(maxAuthor, id);
  return {
    strokes,
    highlights,
    layerId,
    lastItemId,
    maxAuthor,
    maxCounter,
    authors,
  };
}
