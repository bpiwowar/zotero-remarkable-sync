// reMarkable annotations, from the remarkable-annotations library (Rust,
// compiled to WebAssembly; libs/remarkable-annotations). This module keeps
// the API the sync code was written against (ids as {part1, part2}, author
// tables as Maps) and converts at the boundary.
//
// The WebAssembly module must be loaded first (initAnnotations, called at
// startup by loadAnnotations in wasm.ts).
//
// The cloud helpers at the end (fetchAnnotations, mapPdfPages, ensureFolder,
// uploadPdf, putPages) still go through rmapi-js, until the library's cloud
// client replaces it.

import type { DocumentContent, ItemRef, RemarkableApi } from "rmapi-js";
import * as wasm from "remarkable-annotations";
// rmapi-js's putRmPages takes its own scene objects; its scene module is not
// exported, so it is imported from its dist folder (until the library's
// cloud client replaces rmapi-js).
import { parseRmScene } from "../../../node_modules/rmapi-js/dist/rm6.js";

// --- Types -------------------------------------------------------------

export interface RmPoint {
  x: number;
  y: number;
}

export interface CrdtId {
  part1: number;
  part2: number;
}

export interface RmStroke {
  /** reMarkable pen code */
  tool: number;
  /** reMarkable colour code */
  colorIndex: number;
  /** explicit colour when present (highlighters), [r,g,b,a] 0-255 */
  rgba?: [number, number, number, number];
  /** thickness scale from the stroke (a pen-setting multiplier) */
  thickness: number;
  /** representative per-point pen width (reMarkable units; see inkWidth) */
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

export interface RmPage {
  strokes: RmStroke[];
  highlights: RmHighlight[];
  /** the layer node items are parented to (for appending new items) */
  layerId?: CrdtId;
  /** the last item id within that layer (chain new items after this) */
  lastItemId?: CrdtId;
  /** highest author id seen (registered author to reuse for new items) */
  maxAuthor: number;
  /** highest counter seen (mint new counters above this) */
  maxCounter: number;
  /** the page's author table (author id -> uuid) */
  authors: Map<number, string>;
}

export interface RmStructure {
  /** header + structural blocks (no scene items) */
  structure: Uint8Array;
  layerId: CrdtId;
  author: number;
  startCounter: number;
  authors: Map<number, string>;
}

export interface PageUpdateMeta {
  layerId: CrdtId;
  lastItemId?: CrdtId;
  /** an author id already registered in the page (reuse, don't invent) */
  author: number;
  /** first counter to use: above every existing counter */
  startCounter: number;
  /** author of each added item (highlights, then strokes); `author` if unset */
  authors?: number[];
  /** authors to add to the page's author table (id -> uuid) */
  register?: Map<number, string>;
}

export interface PdfPageSize {
  /** page width in PDF points */
  width: number;
  /** page height in PDF points */
  height: number;
  /** lower-left corner of the visible (crop) box; 0 when omitted */
  x0?: number;
  y0?: number;
}

export interface RmShape {
  kind: "rectangle" | "ellipse";
  /** bounding box, in reMarkable units */
  bbox: RmRect;
}

// --- Loading -------------------------------------------------------------

let loaded = false;

/** Load the WebAssembly module from its bytes (once). */
export function initAnnotations(bytes: Uint8Array): void {
  if (loaded) return;
  wasm.initSync({ module: bytes });
  loaded = true;
}

function ready(): void {
  if (!loaded) throw new Error("remarkable-annotations is not loaded yet");
}

// --- Conversions -----------------------------------------------------------

interface WasmId {
  author: number;
  counter: number;
}

const toPart = (id: WasmId): CrdtId => ({
  part1: id.author,
  part2: id.counter,
});
const fromPart = (id: CrdtId): WasmId => ({
  author: id.part1,
  counter: id.part2,
});
const partOrUndefined = (id?: WasmId) => (id ? toPart(id) : undefined);

/** Strokes and highlights for the library: without ids (it does not read them). */
const strip = <T extends { ids?: CrdtId[] }>(items: T[]) =>
  items.map(({ ids: _ids, ...rest }) => rest);

// --- Pages ---------------------------------------------------------------

/** Parse a single `.rm` v6 page into its strokes and highlights. */
export function parseRmPage(bytes: Uint8Array): RmPage {
  ready();
  type FromWasm<T> = Omit<T, "ids"> & { ids?: WasmId[] };
  const p = wasm.parsePage(bytes) as {
    strokes: FromWasm<RmStroke>[];
    highlights: FromWasm<RmHighlight>[];
    layerId?: WasmId;
    lastItemId?: WasmId;
    maxAuthor: number;
    maxCounter: number;
    authors: [number, string][];
  };
  const withIds = <T>(items: FromWasm<T>[]) =>
    items.map((it) => ({ ...it, ids: (it.ids ?? []).map(toPart) }) as T);
  return {
    strokes: withIds<RmStroke>(p.strokes),
    highlights: withIds<RmHighlight>(p.highlights),
    layerId: partOrUndefined(p.layerId),
    lastItemId: partOrUndefined(p.lastItemId),
    maxAuthor: p.maxAuthor,
    maxCounter: p.maxCounter,
    authors: new Map(p.authors),
  };
}

/**
 * Rewrite a page: drop the scene items whose id is in `removeIds`
 * ("part1,part2"), keep every other block as is, then append the given items,
 * highlights first. Returns the new bytes and the ids given to the added items
 * (highlights, then strokes).
 */
export function rebuildPage(
  existing: Uint8Array,
  strokes: RmStroke[],
  highlights: RmHighlight[],
  removeIds: Set<string>,
  meta: PageUpdateMeta,
): { bytes: Uint8Array; ids: CrdtId[] } {
  ready();
  const remove = [...removeIds].map((key) => {
    const [author, counter] = key.split(",").map(Number);
    return { author, counter };
  });
  const r = wasm.rebuildPage(
    existing,
    strip(strokes),
    strip(highlights),
    remove,
    {
      layerId: fromPart(meta.layerId),
      lastItemId: meta.lastItemId ? fromPart(meta.lastItemId) : undefined,
      author: meta.author,
      startCounter: meta.startCounter,
      // An array; anything else (an author table Map, from a structure
      // passed as meta) means none, as in the TypeScript implementation.
      authors: Array.isArray(meta.authors) ? meta.authors : [],
      register: [...(meta.register ?? new Map())],
    },
  );
  return { bytes: r.bytes, ids: r.ids.map(toPart) };
}

/** A copy of a page without its scene items (a template for a new page). */
export function splitStructure(bytes: Uint8Array): Uint8Array {
  ready();
  return wasm.splitStructure(bytes);
}

/** A blank page the tablet accepts, with one layer. */
export function blankStructure(author = 1): RmStructure {
  ready();
  const b = wasm.blankStructure(author);
  return {
    structure: b.bytes,
    layerId: toPart(b.update.layerId),
    author: b.update.author,
    startCounter: b.update.startCounter,
    authors: new Map(b.authors),
  };
}

/** The shape (rectangle, ellipse) a stroke's points describe, or null. */
export function detectShape(points: RmPoint[]): RmShape | null {
  ready();
  return wasm.detectShape(points) ?? null;
}

// --- Geometry --------------------------------------------------------------

const LETTER: PdfPageSize = { width: 612, height: 792 };

/** Visible size of every page of a PDF, in document order. */
export function readPdfPageSizes(bytes: Uint8Array): PdfPageSize[] {
  ready();
  return wasm.readPdfPageSizes(bytes);
}

/** Page size for a given page index, reusing the last known size if needed. */
export function pageSizeAt(sizes: PdfPageSize[], index: number): PdfPageSize {
  if (!sizes.length) return LETTER;
  return sizes[Math.min(index, sizes.length - 1)];
}

/** Convert a reMarkable pen width to an ink width in PDF points. */
export function inkWidth(rmPointWidth: number): number {
  ready();
  return wasm.inkWidth(rmPointWidth);
}

/** Inverse of inkWidth: PDF width -> reMarkable per-point width. */
export function pdfWidthToRm(pdfWidth: number): number {
  ready();
  return wasm.pdfWidthToRm(pdfWidth);
}

/** Convert a reMarkable highlight rectangle to a PDF rect [x1,y1,x2,y2]. */
export function rmRectToPdf(
  r: RmRect,
  page: PdfPageSize,
): [number, number, number, number] {
  ready();
  return Array.from(wasm.rmRectToPdf(r, page)) as [
    number,
    number,
    number,
    number,
  ];
}

/** Inverse of rmRectToPdf. */
export function pdfRectToRm(
  rect: [number, number, number, number],
  page: PdfPageSize,
): RmRect {
  ready();
  return wasm.pdfRectToRm(Float64Array.from(rect), page);
}

/** A stroke's points as a flat PDF ink path [x1,y1,x2,y2,...]. */
export function strokeToPath(points: RmPoint[], page: PdfPageSize): number[] {
  ready();
  return Array.from(wasm.strokeToPath(points, page));
}

/** Inverse of strokeToPath. */
export function pdfPathToRm(path: number[], page: PdfPageSize): RmPoint[] {
  ready();
  return wasm.pdfPathToRm(Float64Array.from(path), page);
}

// --- Documents (rmapi-js, for now) ---------------------------------------

export interface PageRef {
  pageUuid: string;
  /** the page's existing .rm file entry, if it has one */
  rmEntry?: { id: string; hash: string };
}

export interface RmDocPage {
  /** 0-based PDF page index this annotation layer belongs to */
  pdfPageIndex: number;
  /** reMarkable page uuid */
  pageUuid: string;
  /** parsed strokes + highlights */
  page: RmPage;
}

/** Tags set on one page on the device (the page-tag feature). */
export interface RmPageTags {
  /** 0-based PDF page index */
  pdfPageIndex: number;
  /** tag names, sorted and de-duplicated */
  names: string[];
}

export interface RmDocAnnotations {
  pages: RmDocPage[];
  pageTags: RmPageTags[];
  content: DocumentContent | null;
}

/** Group the document's page tags by PDF page index. */
function pageTagsOf(
  content: DocumentContent | null,
  pageIds: string[],
): RmPageTags[] {
  const tags = content?.pageTags;
  if (!tags?.length) return [];
  const indexOf = pdfIndexByPageId(content, pageIds);
  const byPage = new Map<number, Set<string>>();
  for (const t of tags) {
    const idx = indexOf.get(t.pageId);
    const name = t.name?.trim();
    if (idx === undefined || !name) continue; // page gone, or blank tag
    (byPage.get(idx) ?? byPage.set(idx, new Set()).get(idx)!).add(name);
  }
  return [...byPage]
    .sort(([a], [b]) => a - b)
    .map(([pdfPageIndex, names]) => ({
      pdfPageIndex,
      names: [...names].sort(),
    }));
}

/** Map each reMarkable page uuid to its 0-based PDF page index. */
export function pdfIndexByPageId(
  content: DocumentContent | null,
  pageIds: string[] = orderedPageIds(content),
): Map<string, number> {
  const redirect = content?.redirectionPageMap;
  const indexOf = new Map<string, number>();
  pageIds.forEach((id, i) => {
    const mapped = redirect?.[i];
    indexOf.set(id, typeof mapped === "number" && mapped >= 0 ? mapped : i);
  });
  return indexOf;
}

/** Ordered list of page UUIDs for a document. */
function orderedPageIds(content: DocumentContent | null): string[] {
  if (!content) return [];
  if (Array.isArray(content.pages) && content.pages.length) {
    return content.pages;
  }
  const cpages = content.cPages?.pages;
  if (cpages?.length) {
    return cpages
      .filter((p) => !p.deleted || p.deleted.value === 0)
      .map((p) => p.id);
  }
  return [];
}

/** A document's content and its page uuids, mapped to PDF pages and `.rm` files. */
async function readDoc(api: RemarkableApi, id: string, hash: string) {
  const ref = { id, hash };
  const [{ entries }, content] = await Promise.all([
    api.raw.getEntries(ref),
    api.getContent(ref).then(
      (c) => c as DocumentContent,
      () => null,
    ),
  ]);
  const rmByPage = new Map<string, { id: string; hash: string }>();
  for (const e of entries) {
    if (e.id.endsWith(".rm")) {
      const base = e.id.slice(0, -3).split("/").pop()!; // strip dir + ".rm"
      rmByPage.set(base, { id: e.id, hash: e.hash });
    }
  }
  const pageIds = orderedPageIds(content);
  const pdfIndex = pdfIndexByPageId(content, pageIds);
  return { content, pageIds, pdfIndex, rmByPage };
}

/** Fetch and parse every annotated page of a reMarkable document. */
export async function fetchAnnotations(
  api: RemarkableApi,
  id: string,
  hash: string,
): Promise<RmDocAnnotations> {
  const { content, pageIds, pdfIndex, rmByPage } = await readDoc(api, id, hash);
  const pages: RmDocPage[] = [];
  for (const pageUuid of pageIds) {
    const ent = rmByPage.get(pageUuid);
    if (!ent) continue; // page has no annotation layer
    let parsed: RmPage;
    try {
      parsed = parseRmPage(await api.raw.getHash(ent));
    } catch {
      continue;
    }
    if (!parsed.strokes.length && !parsed.highlights.length) continue;
    pages.push({
      pdfPageIndex: pdfIndex.get(pageUuid)!,
      pageUuid,
      page: parsed,
    });
  }
  return { pages, pageTags: pageTagsOf(content, pageIds), content };
}

/**
 * Map each PDF page index to its reMarkable page uuid and existing `.rm` entry
 * (if any): which page file to modify when pushing.
 */
export async function mapPdfPages(
  api: RemarkableApi,
  id: string,
  hash: string,
): Promise<Map<number, PageRef>> {
  const { pageIds, pdfIndex, rmByPage } = await readDoc(api, id, hash);
  const byPdfIndex = new Map<number, PageRef>();
  for (const pageUuid of pageIds) {
    byPdfIndex.set(pdfIndex.get(pageUuid)!, {
      pageUuid,
      rmEntry: rmByPage.get(pageUuid),
    });
  }
  return byPdfIndex;
}

/**
 * Resolve a "/"-separated folder path to a collection id, creating any missing
 * folders along the way. Returns "" for the root.
 */
export async function ensureFolder(
  api: RemarkableApi,
  path: string,
): Promise<string> {
  const parts = path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return "";

  const items = await api.listItems(true);
  let parent = "";
  for (const name of parts) {
    const found = items.find(
      (e) =>
        e.type === "CollectionType" &&
        e.visibleName === name &&
        (e.parent ?? "") === parent,
    );
    if (found) {
      parent = found.id;
    } else {
      const created = await api.putFolder(name, { parent });
      parent = created.id;
    }
  }
  return parent;
}

export interface UploadPdfOptions {
  /** document tags */
  tags?: string[];
  /** number of PDF pages; without it the page list is left to the device */
  pageCount?: number;
  /** page tags to set, by 0-based PDF page index (needs pageCount) */
  pageTags?: Record<string, string[]>;
}

/**
 * Upload a PDF into a folder, returning the new document's ref. With the page
 * count, the placeholder one-page list rmapi-js writes is replaced by the full
 * page list (and page tags), so annotations can be written right away.
 */
export async function uploadPdf(
  api: RemarkableApi,
  visibleName: string,
  bytes: Uint8Array,
  folderId: string,
  opts: UploadPdfOptions = {},
): Promise<ItemRef> {
  const { tags = [], pageCount, pageTags = {} } = opts;
  const ref = await api.putPdf(visibleName, bytes, { parent: folderId, tags });
  if (!pageCount || pageCount < 1) return ref;
  const pages = Array.from({ length: pageCount }, () =>
    globalThis.crypto.randomUUID(),
  );
  const now = Date.now();
  return api.updateDocument(ref, {
    originalPageCount: pages.length,
    pageCount: pages.length,
    pages,
    redirectionPageMap: pages.map((_, i) => i),
    pageTags: Object.entries(pageTags).flatMap(([idx, names]) => {
      const pageId = pages[Number(idx)];
      return pageId
        ? names.map((name) => ({ name, pageId, timestamp: now }))
        : [];
    }),
  } as Partial<DocumentContent>);
}

/**
 * Replace the `.rm` files of some pages of a document in one commit. Fails with
 * rmapi-js's HashNotFoundError if the document changed since `ref` was read.
 */
export async function putPages(
  api: RemarkableApi,
  ref: ItemRef,
  pages: Map<string, Uint8Array>,
): Promise<ItemRef> {
  if (pages.size === 0) return ref;
  const scenes = new Map(
    [...pages].map(([pageId, bytes]) => [pageId, parseRmScene(bytes)]),
  );
  return api.putRmPages(ref, scenes);
}
