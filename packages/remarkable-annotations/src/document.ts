// Document operations on top of rmapi-js: folder resolution by path, PDF
// uploads with the full page list, and page writes from raw `.rm` bytes.

import type { DocumentContent, ItemRef, RemarkableApi } from "rmapi-js";
import { parseRmScene } from "./rmscene";

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
 * Upload a PDF into a folder, returning the new document's ref.
 *
 * rmapi-js's `putPdf` writes a placeholder `.content` claiming a single page;
 * the device only writes the real page list when the document is first opened.
 * Until then, annotations cannot be mapped to pages. When the page count is
 * known we follow up with the full page list (one page uuid per PDF page) and
 * the page tags, so annotations can be written right away.
 *
 * Page uuids come from `globalThis.crypto.randomUUID`.
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
 * rmapi-js's HashNotFoundError if the document changed since `ref` was read,
 * so pages computed from an older version never overwrite newer ink.
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
