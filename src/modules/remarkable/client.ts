// The reMarkable cloud for the plugin: credential storage in prefs, and
// logging. The cloud client is remarkable-annotations' (cloud.ts).

import type { Entry, ItemRef } from "rmapi-js";
import { connectCloud, register, type RemarkableApi } from "./cloud";
import * as rm from "./annotations";
import type { UploadPdfOptions } from "./annotations";
import { getPref, setPref, clearPref } from "../../utils/prefs";
import { ensureNetworkGlobals } from "../../utils/globals";
import { log, errMsg } from "../../utils/log";

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
  const token = await register(code.trim(), "browser-chrome");
  setPref("deviceToken", token);
  cachedApi = null;
}

export function disconnect(): void {
  clearPref("deviceToken");
  // Folder ids belong to the account
  for (const k of ["folderPath", "folderId", "folderParent"]) clearPref(k);
  cachedApi = null;
}

/** Get an authenticated API instance, creating one from the stored token. */
export async function getApi(): Promise<RemarkableApi> {
  if (cachedApi) return cachedApi;
  ensureNetworkGlobals();
  const token = getPref("deviceToken");
  if (!token) throw new NotConnectedError();
  cachedApi = await connectCloud(token);
  return cachedApi;
}

/** Drop the cached API/session (e.g. after an auth failure) to force a refresh. */
export function resetApi(): void {
  cachedApi = null;
}

export { putPages } from "./annotations";

/**
 * The id of the sync folder (a "/"-separated path), creating missing folders.
 * Once resolved, its id is kept in the prefs, and later calls only check that
 * it is still there (the root listing and its metadata) instead of reading
 * every item.
 */
export async function ensureFolder(
  api: RemarkableApi,
  path: string,
): Promise<string> {
  const name = path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .at(-1);
  if (!name) return "";
  const id = getPref("folderId");
  if (id && getPref("folderPath") === path) {
    try {
      const ref = (await api.listRefs(true)).find((r) => r.id === id);
      const meta = ref && (await api.getMetadata(ref));
      if (
        meta &&
        meta.type === "CollectionType" &&
        meta.visibleName === name &&
        (meta.parent ?? "") === getPref("folderParent")
      ) {
        return id;
      }
      log(`ensureFolder: "${path}" moved or deleted, looking it up again`);
    } catch (e) {
      log(`ensureFolder: could not check "${path}": ${errMsg(e)}`);
    }
  }
  const found = await rm.ensureFolder(api, path);
  const ref = (await api.listRefs()).find((r) => r.id === found);
  const meta = ref && (await api.getMetadata(ref));
  setPref("folderPath", path);
  setPref("folderId", found);
  setPref("folderParent", meta?.parent ?? "");
  return found;
}

/** Upload a PDF into a folder (see `uploadPdf` in annotations.ts). */
export async function uploadPdf(
  api: RemarkableApi,
  visibleName: string,
  bytes: Uint8Array,
  folderId: string,
  opts: UploadPdfOptions = {},
): Promise<ItemRef> {
  const ref = await rm.uploadPdf(api, visibleName, bytes, folderId, opts);
  log(
    opts.pageCount
      ? `uploadPdf: "${visibleName}" -> ${ref.id} (${opts.pageCount} page(s))`
      : `uploadPdf: page count unknown for "${visibleName}", one-page list`,
  );
  return ref;
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
  await api.move(ref, "trash"); // generation conflicts are retried
}

/** Permanently delete a document (not recoverable from the device trash). */
export async function purgeDoc(
  api: RemarkableApi,
  ref: ItemRef,
): Promise<void> {
  await api.purge(ref);
}
