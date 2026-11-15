// Thin wrapper around rmapi-js, adapting it to the plugin: credential storage
// in prefs, folder resolution by path, and retry handling for the low-level
// put* operations (which throw GenerationError on a stale root generation).

import { register, remarkable, GenerationError } from "rmapi-js";
import type { Entry, RemarkableApi, SimpleEntry } from "rmapi-js";
import { getPref, setPref, clearPref } from "../../utils/prefs";
import { ensureNetworkGlobals } from "../../utils/globals";

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

/** Upload a PDF into a folder, returning the new document's id and hash. */
export async function uploadPdf(
  api: RemarkableApi,
  visibleName: string,
  bytes: Uint8Array,
  folderId: string,
  tags: string[] = [],
): Promise<SimpleEntry> {
  return withGenerationRetry(() =>
    api.putPdf(visibleName, bytes, { parent: folderId, tags }),
  );
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
