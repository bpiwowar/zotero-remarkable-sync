// Thin wrapper around rmapi-js, adapting it to the plugin: credential storage
// in prefs and logging. Document operations live in remarkable-annotations.

import { register, remarkable } from "rmapi-js";
import type { Entry, ItemRef, RemarkableApi } from "rmapi-js";
import * as rm from "remarkable-annotations";
import type { UploadPdfOptions } from "remarkable-annotations";
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

export { ensureFolder, putPages } from "remarkable-annotations";

/** Upload a PDF into a folder (see remarkable-annotations' `uploadPdf`). */
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
  await api.move(ref, "trash"); // rmapi-js retries generation conflicts
}

/** Permanently delete a document (not recoverable from the device trash). */
export async function purgeDoc(
  api: RemarkableApi,
  ref: ItemRef,
): Promise<void> {
  await api.purge(ref);
}
