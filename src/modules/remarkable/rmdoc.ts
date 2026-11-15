// Download a reMarkable document's annotation layers: list its files via the
// raw API, read the `.content` to get the ordered page list and the
// redirectionPageMap (reMarkable page -> PDF page), then fetch and parse each
// `{pageUuid}.rm` scene file.

import type { RemarkableApi, DocumentContent } from "rmapi-js";
import { parseRmPage, type RmPage } from "./rmlines";

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

/**
 * Fetch and parse every annotated page of a reMarkable document.
 *
 * @param api authenticated rmapi-js instance
 * @param id document id (uuid)
 * @param hash current document hash (from listItems)
 */
export async function fetchAnnotations(
  api: RemarkableApi,
  id: string,
  hash: string,
): Promise<RmDocAnnotations> {
  const { entries } = await api.raw.getEntries(`${id}.docSchema`, hash);

  const contentEnt = entries.find((e) => e.id.endsWith(".content"));
  let content: DocumentContent | null = null;
  if (contentEnt) {
    try {
      content = (await api.raw.getContent(
        contentEnt.id,
        contentEnt.hash,
      )) as DocumentContent;
    } catch {
      content = null;
    }
  }

  const pageIds = orderedPageIds(content);
  const redirect = content?.redirectionPageMap;

  // Index .rm entries by page uuid for quick lookup.
  const rmByPage = new Map<string, { id: string; hash: string }>();
  for (const e of entries) {
    if (e.id.endsWith(".rm")) {
      const base = e.id.slice(0, -3).split("/").pop()!; // strip dir + ".rm"
      rmByPage.set(base, { id: e.id, hash: e.hash });
    }
  }

  const pages: RmDocPage[] = [];
  for (let i = 0; i < pageIds.length; i++) {
    const ent = rmByPage.get(pageIds[i]);
    if (!ent) continue; // page has no annotation layer
    let parsed: RmPage;
    try {
      const bytes = await api.raw.getHash(ent.id, ent.hash);
      parsed = parseRmPage(bytes);
    } catch {
      continue;
    }
    if (!parsed.strokes.length && !parsed.highlights.length) continue;

    const mapped = redirect?.[i];
    const pdfPageIndex = typeof mapped === "number" && mapped >= 0 ? mapped : i;
    pages.push({ pdfPageIndex, pageUuid: pageIds[i], page: parsed });
  }

  return { pages, pageTags: pageTagsOf(content, pageIds), content };
}

/**
 * Map each PDF page index to its reMarkable page uuid and existing `.rm` entry
 * (if any). Used by the push side to know which page file to modify.
 */
export async function mapPdfPages(
  api: RemarkableApi,
  id: string,
  hash: string,
): Promise<Map<number, PageRef>> {
  const { entries } = await api.raw.getEntries(`${id}.docSchema`, hash);
  const contentEnt = entries.find((e) => e.id.endsWith(".content"));
  let content: DocumentContent | null = null;
  if (contentEnt) {
    try {
      content = (await api.raw.getContent(
        contentEnt.id,
        contentEnt.hash,
      )) as DocumentContent;
    } catch {
      content = null;
    }
  }

  const rmByPage = new Map<string, { id: string; hash: string }>();
  for (const e of entries) {
    if (e.id.endsWith(".rm")) {
      const base = e.id.slice(0, -3).split("/").pop()!;
      rmByPage.set(base, { id: e.id, hash: e.hash });
    }
  }

  const pageIds = orderedPageIds(content);
  const redirect = content?.redirectionPageMap;
  const byPdfIndex = new Map<number, PageRef>();
  for (let i = 0; i < pageIds.length; i++) {
    const mapped = redirect?.[i];
    const pdfPageIndex = typeof mapped === "number" && mapped >= 0 ? mapped : i;
    byPdfIndex.set(pdfPageIndex, {
      pageUuid: pageIds[i],
      rmEntry: rmByPage.get(pageIds[i]),
    });
  }
  return byPdfIndex;
}
