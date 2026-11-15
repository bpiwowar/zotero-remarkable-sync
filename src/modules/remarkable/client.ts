// Thin wrapper around rmapi-js, adapting it to the plugin: credential storage
// in prefs, folder resolution by path, uploads with the full page list, and
// page writes from raw `.rm` bytes. rmapi-js retries generation conflicts.

import { register, remarkable } from "rmapi-js";
import type { DocumentContent, Entry, ItemRef, RemarkableApi } from "rmapi-js";
import { parseRmScene } from "./rmscene";
import { getPref, setPref, clearPref } from "../../utils/prefs";
import { ensureNetworkGlobals } from "../../utils/globals";
import { log } from "../../utils/log";

export class NotConnectedError extends Error {
  constructor() {
    super("Not connected to the reMarkable cloud");
    this.name = "NotConnectedError";
  }
}

let cachedApi: RemarkableApi | null = null;

export function isConnected(): boolean {
  return !!getPref("deviceToken");
}

/**
 * Exchange a one-time code (from my.remarkable.com/device/browser/connect) for a
 * long-lived device token and persist it.
 */
export async function connect(code: string): Promise<void> {
  ensureNetworkGlobals();
  const token = await register(code.trim(), { deviceDesc: "browser-chrome" });
  setPref("deviceToken", token);
  cachedApi = null;
}

export function disconnect(): void {
  clearPref("deviceToken");
  cachedApi = null;
}

/** Get an authenticated API instance, creating one from the stored token. */
export async function getApi(): Promise<RemarkableApi> {
  if (cachedApi) return cachedApi;
  ensureNetworkGlobals();
  const token = getPref("deviceToken");
  if (!token) throw new NotConnectedError();
  cachedApi = await remarkable(token);
  return cachedApi;
}

/** Drop the cached API/session (e.g. after an auth failure) to force a refresh. */
export function resetApi(): void {
  cachedApi = null;
}

/**
 * Resolve a "/"-separated folder path to a collection id on the reMarkable,
 * creating any missing folders along the way. Returns "" for the root.
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

function uuid4(): string {
  const c = (globalThis as any).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return (Services as any).uuid.generateUUID().toString().slice(1, -1);
}

/**
 * Upload a PDF into a folder, returning the new document's id and hash.
 *
 * rmapi-js's `putPdf` writes a placeholder `.content` claiming a single page;
 * the device only writes the real page list when the document is first opened.
 * Until then, annotations cannot be mapped to pages. When the page count is
 * known we follow up with the full page list (one page uuid per PDF page) and
 * the page tags, so annotations can be pushed right away.
 */
export async function uploadPdf(
  api: RemarkableApi,
  visibleName: string,
  bytes: Uint8Array,
  folderId: string,
  opts: {
    tags?: string[];
    pageCount?: number;
    /** page tags to set, by 0-based PDF page index (needs pageCount) */
    pageTags?: Record<string, string[]>;
  } = {},
): Promise<ItemRef> {
  const { tags = [], pageCount, pageTags = {} } = opts;
  const ref = await api.putPdf(visibleName, bytes, { parent: folderId, tags });
  if (!pageCount || pageCount < 1) {
    log(`uploadPdf: page count unknown for "${visibleName}", one-page list`);
    return ref;
  }
  const pages = Array.from({ length: pageCount }, () => uuid4());
  const now = Date.now();
  const updated = await api.updateDocument(ref, {
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
  log(`uploadPdf: "${visibleName}" -> ${ref.id} (${pages.length} page(s))`);
  return updated;
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

/** Look up an entry by its document id (uuid). */
export async function findById(
  api: RemarkableApi,
  id: string,
): Promise<Entry | undefined> {
  const items = await api.listItems();
  return items.find((e) => e.id === id);
}

/** Move a document to the reMarkable trash (recoverable on the device). */
export async function trashDoc(
  api: RemarkableApi,
  ref: ItemRef,
): Promise<void> {
  await api.move(ref, "trash"); // rmapi-js retries generation conflicts
}

/** Permanently delete a document (not recoverable from the device trash). */
export async function purgeDoc(
  api: RemarkableApi,
  ref: ItemRef,
): Promise<void> {
  await api.purge(ref);
}
