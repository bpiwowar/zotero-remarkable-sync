// Thin wrapper around rmapi-js, adapting it to the plugin: credential storage
// in prefs, folder resolution by path, and retry handling for the low-level
// put* operations (which throw GenerationError on a stale root generation).

import { register, remarkable, GenerationError } from "rmapi-js";
import type {
  DocumentContent,
  Entry,
  Metadata,
  RemarkableApi,
  SimpleEntry,
} from "rmapi-js";
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
 * Retry a low-level mutation that can fail with GenerationError when the local
 * view of the root generation is stale.
 */
async function withGenerationRetry<T>(
  fn: () => Promise<T>,
  tries = 5,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof GenerationError) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
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
      const created = await withGenerationRetry(() =>
        api.putFolder(name, { parent }),
      );
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
 * known we instead upload a `.content` listing one page uuid per PDF page (the
 * same v1 layout rmapi-js uses, just complete), so annotations can be pushed
 * right away.
 */
export async function uploadPdf(
  api: RemarkableApi,
  visibleName: string,
  bytes: Uint8Array,
  folderId: string,
  opts: { tags?: string[]; pageCount?: number } = {},
): Promise<SimpleEntry> {
  const { tags = [], pageCount } = opts;
  if (!pageCount || pageCount < 1) {
    log(`uploadPdf: page count unknown for "${visibleName}", using putPdf`);
    return withGenerationRetry(() =>
      api.putPdf(visibleName, bytes, { parent: folderId, tags }),
    );
  }
  const id = uuid4();
  const pages = Array.from({ length: pageCount }, () => uuid4());
  return withGenerationRetry(() =>
    putPdfWithPages(api, id, visibleName, bytes, folderId, tags, pages),
  );
}

async function putPdfWithPages(
  api: RemarkableApi,
  id: string,
  visibleName: string,
  bytes: Uint8Array,
  parent: string,
  tags: string[],
  pages: string[],
): Promise<SimpleEntry> {
  const raw = api.raw;
  const now = Date.now();
  const metadata: Metadata = {
    parent,
    pinned: false,
    lastModified: String(now),
    createdTime: String(now),
    type: "DocumentType",
    visibleName,
    lastOpened: "0",
    lastOpenedPage: 0,
  } as Metadata;
  // Mirrors rmapi-js's putPdf defaults, with the real page list.
  const content = {
    coverPageNumber: -1,
    documentMetadata: {},
    extraMetadata: {},
    lineHeight: -1,
    margins: 125,
    orientation: "portrait",
    fileType: "pdf",
    formatVersion: 1,
    tags: tags.map((name) => ({ name, timestamp: now })),
    fontName: "",
    textAlignment: "justify",
    textScale: 1,
    zoomMode: "bestFit",
    originalPageCount: pages.length,
    pageCount: pages.length,
    pageTags: [],
    pages,
    redirectionPageMap: pages.map((_, i) => i),
    sizeInBytes: String(bytes.length),
  } as unknown as DocumentContent;

  const [
    [contentEntry, uploadContent],
    [metadataEntry, uploadMetadata],
    [pagedataEntry, uploadPagedata],
    [fileEntry, uploadFile],
    [rootHash, generation, schema],
  ] = await Promise.all([
    raw.putContent(`${id}.content`, content),
    raw.putMetadata(`${id}.metadata`, metadata),
    raw.putText(`${id}.pagedata`, "\n"),
    raw.putFile(`${id}.pdf`, bytes),
    raw.getRootHash(),
  ]);
  const [[docEntry, uploadDoc], { entries: rootEntries }] = await Promise.all([
    raw.putEntries(
      id,
      [contentEntry, metadataEntry, pagedataEntry, fileEntry],
      schema,
    ),
    raw.getEntries("root.docSchema", rootHash),
  ]);
  rootEntries.push(docEntry);
  const [rootEntry, uploadRoot] = await raw.putEntries(
    "root",
    rootEntries,
    schema,
  );
  await Promise.all([
    uploadContent,
    uploadMetadata,
    uploadPagedata,
    uploadFile,
    uploadDoc,
    uploadRoot,
  ]);
  await raw.putRootHash(rootEntry.hash, generation);
  log(`uploadPdf: "${visibleName}" -> ${id} (${pages.length} page(s))`);
  return { id, hash: docEntry.hash };
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
  hash: string,
): Promise<void> {
  await withGenerationRetry(() => api.move(hash, "trash"));
}

/** Delete a document by its current hash. */
export async function deleteDoc(
  api: RemarkableApi,
  hash: string,
): Promise<void> {
  await withGenerationRetry(() => api.delete(hash));
}
