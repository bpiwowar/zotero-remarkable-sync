// Orchestrates the Zotero -> reMarkable push and the add/remove-from-sync
// actions. The pull side (annotations) is added in M2.

import { getPref } from "../../utils/prefs";
import { ensureNetworkGlobals } from "../../utils/globals";
import { log, errMsg } from "../../utils/log";
import * as client from "../remarkable/client";
import { fetchAnnotations } from "../remarkable/rmdoc";
import { readPdfPageSizes, pageSizeAt } from "../remarkable/geometry";
import {
  getRecord,
  getRecordCached,
  setRecord,
  removeRecord,
  allRecords,
  type SyncRecord,
} from "./state";
import { applyAnnotations } from "./annotations";

const IO = globalThis as any;

export interface SyncSummary {
  pushed: number;
  skipped: number;
  stopped: number; // items unsynced because they were deleted on the device
  failed: number;
  errors: string[];
}

/** Report progress to the UI: a status line and a 0-100 percentage. */
export type ProgressFn = (text: string, pct: number) => void;

export function getSyncTag(): string {
  return (getPref("syncTag") || "@remarkable").toString();
}

export function isItemSynced(item: Zotero.Item): boolean {
  return item.hasTag(getSyncTag());
}

/**
 * Number of pages of a PDF attachment, from Zotero's PDF worker (or the
 * full-text index). Returns null when unknown — callers must then not assume a
 * page layout.
 */
export async function pdfPageCount(att: Zotero.Item): Promise<number | null> {
  try {
    const r = await (Zotero as any).PDFWorker.getFullText(att.id, 1);
    if (Number.isInteger(r?.totalPages) && r.totalPages > 0) {
      return r.totalPages;
    }
  } catch (e) {
    log(`pdfPageCount: PDF worker failed: ${errMsg(e)}`);
  }
  try {
    const r = await Zotero.Fulltext.getPages(att.id);
    if (r && r.total > 0) return r.total;
  } catch {
    /* not indexed */
  }
  return null;
}

/**
 * Safe mode (default on): never modify annotations on the device — pull only.
 * PDFs are still uploaded, since storing a document is non-destructive.
 */
export function isSafeMode(): boolean {
  return getPref("safeMode") !== false;
}

/**
 * Stop syncing an attachment: drop its sync record and remove the sync tag from
 * its parent item (so it is excluded from future syncs). Touches only Zotero —
 * never the device. Used when a document was deleted on the reMarkable.
 */
async function stopSync(att: Zotero.Item): Promise<void> {
  await removeRecord(att.key);
  const parent = att.parentItem;
  const tag = getSyncTag();
  if (parent && parent.hasTag(tag)) {
    // Only drop the tag if no *other* PDF of this item is still synced.
    const others = Zotero.Items.get(parent.getAttachments()).filter(
      (a) => a.isPDFAttachment() && a.key !== att.key,
    );
    const anyOther = (
      await Promise.all(others.map((a) => getRecord(a.key)))
    ).some(Boolean);
    if (!anyOther) {
      parent.removeTag(tag);
      await parent.saveTx();
    }
  }
}

/** Find tagged regular items in one library. */
async function findSyncItemsIn(libraryID: number): Promise<Zotero.Item[]> {
  const search = new Zotero.Search();
  // `libraryID` is typed read-only but is assignable on a fresh search.
  (search as any).libraryID = libraryID;
  search.addCondition("tag", "is", getSyncTag());
  const ids = await search.search();
  return Zotero.Items.get(ids).filter((it) => it.isRegularItem());
}

/** Find all regular (top-level) tagged items across every editable library. */
export async function findSyncItems(): Promise<Zotero.Item[]> {
  const libs = Zotero.Libraries.getAll().filter((l) => l.editable);
  const out: Zotero.Item[] = [];
  for (const lib of libs) {
    out.push(...(await findSyncItemsIn(lib.libraryID)));
  }
  return out;
}

/** Collect the PDF attachments of the given regular items. */
export function pdfAttachmentsOf(items: Zotero.Item[]): Zotero.Item[] {
  const out: Zotero.Item[] = [];
  for (const item of items) {
    const attIDs = item.getAttachments();
    for (const att of Zotero.Items.get(attIDs)) {
      if (att.isPDFAttachment()) out.push(att);
    }
  }
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as any).crypto.subtle;
  const digest: ArrayBuffer = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function displayNameFor(att: Zotero.Item): string {
  const parent = att.parentItem;
  const title = parent ? parent.getDisplayTitle() : "";
  return (title || att.attachmentFilename || "Untitled").trim();
}

/**
 * Push every tagged item's PDF attachment to the configured reMarkable folder.
 * Unchanged files (matching the recorded sha-256) are skipped.
 */
export async function pushAll(
  progress?: ProgressFn,
  opts: { attachments?: Zotero.Item[]; force?: boolean } = {},
): Promise<SyncSummary> {
  ensureNetworkGlobals();
  const summary: SyncSummary = {
    pushed: 0,
    skipped: 0,
    stopped: 0,
    failed: 0,
    errors: [],
  };

  log("pushAll: start");
  // When given an explicit attachment list (per-item "Overwrite from Zotero"),
  // push exactly those; otherwise push every tagged item's PDF.
  const attachments =
    opts.attachments ?? pdfAttachmentsOf(await findSyncItems());
  log(`pushAll: ${attachments.length} PDF attachment(s) tagged`);
  if (attachments.length === 0) {
    progress?.("Nothing tagged to sync", 100);
    return summary;
  }

  progress?.("Authenticating with reMarkable…", 0);
  log("pushAll: getApi() …");
  const api = await client.getApi();
  log("pushAll: getApi() ok");

  progress?.("Resolving reMarkable folder…", 0);
  const folder = getPref("folder") || "";
  log(`pushAll: ensureFolder("${folder}") …`);
  const folderId = await client.ensureFolder(api, folder);
  log(`pushAll: folderId="${folderId}"`);

  // The device documents that currently exist — so we can detect docs deleted on
  // the reMarkable and stop syncing them (rather than re-uploading).
  const deviceDocIds = new Set((await api.listItems()).map((e) => e.id));

  let done = 0;
  for (const att of attachments) {
    const name = displayNameFor(att);
    const pct = Math.round((done / attachments.length) * 100);
    progress?.(`Uploading ${name}`, pct);
    try {
      const path = await att.getFilePathAsync();
      if (!path) {
        log(`pushAll: skip "${name}" (no file path)`);
        summary.skipped++;
        done++;
        continue;
      }
      const bytes: Uint8Array = await IO.IOUtils.read(path);
      const fileHash = await sha256Hex(bytes);

      const existing = await getRecord(att.key);
      const missingOnDevice = !!existing && !deviceDocIds.has(existing.docId);
      if (
        !opts.force &&
        existing &&
        existing.fileHash === fileHash &&
        !missingOnDevice
      ) {
        log(`pushAll: skip "${name}" (unchanged)`);
        summary.skipped++;
        done++;
        continue;
      }
      // Deleted on the reMarkable: respect that and stop syncing it in Zotero,
      // rather than re-uploading. An explicit forced push (per-item "Overwrite
      // device from Zotero") still re-uploads a fresh copy.
      if (missingOnDevice && !opts.force) {
        log(`pushAll: "${name}" was deleted on reMarkable — stopping sync`);
        await stopSync(att);
        summary.stopped++;
        done++;
        continue;
      }
      if (missingOnDevice) {
        log(`pushAll: "${name}" missing on device — re-uploading (forced)`);
      }

      log(`pushAll: uploading "${name}" (${bytes.length} bytes) …`);
      const pageCount = await pdfPageCount(att);
      const entry = await client.uploadPdf(api, name, bytes, folderId, {
        pageCount: pageCount ?? undefined,
      });
      // When re-uploading a fresh document, reset annotation tracking so every
      // Zotero annotation gets re-pushed onto the fresh document.
      const record: SyncRecord = {
        docId: entry.id,
        docHash: entry.hash,
        fileHash,
        visibleName: name,
        libraryID: att.libraryID,
        lastPushed: Date.now(),
        lastPulledVersion: missingOnDevice
          ? undefined
          : existing?.lastPulledVersion,
        annotationKeys: missingOnDevice ? [] : existing?.annotationKeys,
        pushedKeys: missingOnDevice ? [] : existing?.pushedKeys,
        pushedItems: missingOnDevice ? [] : existing?.pushedItems,
      };
      await setRecord(att.key, record);
      log(`pushAll: uploaded "${name}" -> ${entry.id}`);
      summary.pushed++;
    } catch (e) {
      log(`pushAll: FAILED "${name}": ${errMsg(e)}`);
      summary.failed++;
      summary.errors.push(`${name}: ${errMsg(e)}`);
    }
    done++;
  }
  log(
    `pushAll: done (pushed=${summary.pushed} skipped=${summary.skipped} failed=${summary.failed})`,
  );
  progress?.("", 100);
  return summary;
}

export interface PullSummary {
  updated: number;
  annotations: number;
  removed: number;
  failed: number;
  errors: string[];
}

/**
 * Pull annotations for every synced attachment whose reMarkable document has
 * changed since the last pull, writing them as native Zotero annotations.
 */
export async function pullAll(
  progress?: ProgressFn,
  opts: { force?: boolean; onlyKeys?: Set<string> } = {},
): Promise<PullSummary> {
  ensureNetworkGlobals();
  const summary: PullSummary = {
    updated: 0,
    annotations: 0,
    removed: 0,
    failed: 0,
    errors: [],
  };

  const records = await allRecords();
  const keys = Object.keys(records).filter(
    (k) => !opts.onlyKeys || opts.onlyKeys.has(k),
  );
  log(`pullAll: start (${keys.length} synced record(s))`);
  if (keys.length === 0) return summary;

  const api = await client.getApi();
  progress?.("Checking reMarkable for annotations…", 0);

  // Snapshot the cloud listing once, then look up each doc by id.
  const remote = await api.listItems(true);
  const byId = new Map(remote.map((e) => [e.id, e]));

  let done = 0;
  for (const attKey of keys) {
    const rec = records[attKey];
    const pct = Math.round((done / keys.length) * 100);
    try {
      const libraryID = rec.libraryID ?? Zotero.Libraries.userLibraryID;
      const att = Zotero.Items.getByLibraryAndKey(libraryID, attKey);
      if (!att) {
        done++;
        continue;
      }

      const entry = byId.get(rec.docId);
      if (!entry) {
        log(`pullAll: "${rec.visibleName}" not found on cloud (${rec.docId})`);
        done++;
        continue;
      }
      if (!opts.force && entry.hash === rec.lastPulledVersion) {
        log(`pullAll: "${rec.visibleName}" unchanged since last pull`);
        done++;
        continue; // unchanged since last pull
      }

      progress?.(`Pulling annotations: ${rec.visibleName}`, pct);
      log(`pullAll: fetching "${rec.visibleName}" (${rec.docId})`);
      const { pages, pageTags } = await fetchAnnotations(
        api,
        rec.docId,
        entry.hash,
      );

      const path = await (att as Zotero.Item).getFilePathAsync();
      const bytes: Uint8Array = path
        ? await IO.IOUtils.read(path)
        : new Uint8Array();
      const sizes = readPdfPageSizes(bytes);

      const result = await applyAnnotations(
        att as Zotero.Item,
        pages,
        sizes,
        rec.annotationKeys ?? [],
        rec.deletedSigs ?? [],
        pageTags,
      );

      const updated: SyncRecord = {
        ...rec,
        lastPulledVersion: entry.hash,
        annotationKeys: result.keys,
        pageTags: Object.fromEntries(
          pageTags.map((t) => [String(t.pdfPageIndex), t.names]),
        ),
      };
      await setRecord(attKey, updated);
      summary.updated++;
      summary.annotations += result.added;
      summary.removed += result.removed;
      log(
        `pullAll: "${rec.visibleName}" -> +${result.added} -${result.removed} ~${result.updated} annotation(s)`,
      );
    } catch (e) {
      log(`pullAll: FAILED "${rec.visibleName}": ${errMsg(e)}`);
      summary.failed++;
      summary.errors.push(`${rec.visibleName}: ${errMsg(e)}`);
    }
    done++;
  }
  progress?.("", 100);
  return summary;
}

/**
 * Erase every annotation this plugin has created (across all synced
 * attachments) and reset the pull state, so the next pull recreates them. Used
 * to clean up after a geometry change or as a manual reset. Only removes our own
 * annotations — never the user's.
 */
export async function clearPulledAnnotations(): Promise<number> {
  let removed = 0;
  const records = await allRecords();
  for (const [attKey, rec] of Object.entries(records)) {
    const libraryID = rec.libraryID ?? Zotero.Libraries.userLibraryID;
    for (const key of rec.annotationKeys ?? []) {
      const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
      if (item) {
        try {
          await (item as Zotero.Item).eraseTx();
          removed++;
        } catch {
          /* already gone */
        }
      }
    }
    await setRecord(attKey, {
      ...rec,
      annotationKeys: [],
      pushedKeys: [],
      pushedItems: [],
      lastPulledVersion: undefined,
    });
  }
  log(`clearPulledAnnotations: removed ${removed}`);
  return removed;
}

/**
 * Clear the pull guard (and deletion suppressions) for the given attachments so
 * a forced pull re-applies every annotation currently on the device. Used by the
 * per-item "Overwrite from reMarkable" action. Does not touch annotations
 * directly — applyAnnotations mirrors the device state on the next pull.
 */
export async function resetPullState(attKeys: string[]): Promise<void> {
  for (const attKey of attKeys) {
    const rec = await getRecord(attKey);
    if (!rec) continue;
    await setRecord(attKey, {
      ...rec,
      lastPulledVersion: undefined,
      deletedSigs: [],
    });
  }
}

/**
 * Remove the reMarkable documents for the given attachment keys and forget them.
 * Used when items are deleted/trashed in Zotero.
 */
export async function unsyncByKeys(attKeys: string[]): Promise<void> {
  const want = new Set(attKeys);
  const records = await allRecords();
  const hits = Object.keys(records).filter((k) => want.has(k));
  if (hits.length === 0) return;

  let api: Awaited<ReturnType<typeof client.getApi>> | null = null;
  if (client.isConnected()) {
    try {
      ensureNetworkGlobals();
      api = await client.getApi();
    } catch {
      api = null;
    }
  }
  for (const attKey of hits) {
    const rec = records[attKey];
    if (api) {
      try {
        const entry = await client.findById(api, rec.docId);
        if (entry) await client.deleteDoc(api, entry.hash);
        log(`unsync: deleted "${rec.visibleName}" from device`);
      } catch (e) {
        log(`unsync: delete failed for "${rec.visibleName}": ${errMsg(e)}`);
      }
    }
    await removeRecord(attKey);
  }
}

/** Tag the given regular items so they are included in sync. */
export async function addToSync(items: Zotero.Item[]): Promise<void> {
  const tag = getSyncTag();
  for (const item of items) {
    if (!item.isRegularItem() || item.hasTag(tag)) continue;
    item.addTag(tag, 0);
    await item.saveTx();
  }
}

/**
 * Remove the sync tag from the given items, optionally pulling their latest
 * annotations from the reMarkable first and/or deleting their documents there.
 * `deleteRemote` defaults to the `deleteOnUnsync` pref. If the final pull fails
 * for a document, it is kept on the device so no tablet annotation is lost.
 */
export async function removeFromSync(
  items: Zotero.Item[],
  opts: {
    deleteRemote?: boolean;
    pullFirst?: boolean;
    progress?: ProgressFn;
  } = {},
): Promise<void> {
  const tag = getSyncTag();
  const deleteRemote = opts.deleteRemote ?? !!getPref("deleteOnUnsync");

  const regular = items.filter((it) => it.isRegularItem());
  const attKeys = new Set(
    pdfAttachmentsOf(regular)
      .filter((att) => getRecordCached(att.key))
      .map((att) => att.key),
  );

  // Last pull, so annotations made on the tablet since the last sync are kept.
  const keepRemote = new Set<string>();
  if (opts.pullFirst && attKeys.size && client.isConnected()) {
    const records = await allRecords();
    try {
      const pull = await pullAll(opts.progress, { onlyKeys: attKeys });
      for (const err of pull.errors) log(`unsync: final pull error: ${err}`);
      if (pull.failed) {
        // Can't tell which one failed from the summary: keep them all remotely.
        for (const k of attKeys) keepRemote.add(k);
      }
    } catch (e) {
      log(`unsync: final pull failed: ${errMsg(e)}`);
      for (const k of attKeys) keepRemote.add(k);
    }
    for (const k of keepRemote) {
      log(
        `unsync: keeping "${records[k]?.visibleName}" on device (pull failed)`,
      );
    }
  }

  let api: Awaited<ReturnType<typeof client.getApi>> | null = null;
  if (deleteRemote && client.isConnected()) {
    ensureNetworkGlobals();
    api = await client.getApi();
  }

  for (const item of regular) {
    if (item.hasTag(tag)) {
      item.removeTag(tag);
      await item.saveTx();
    }
    for (const att of Zotero.Items.get(item.getAttachments())) {
      if (!att.isPDFAttachment()) continue;
      const record = await getRecord(att.key);
      if (record && api && !keepRemote.has(att.key)) {
        try {
          const entry = await client.findById(api, record.docId);
          if (entry) await client.deleteDoc(api, entry.hash);
          log(`unsync: deleted "${record.visibleName}" from device`);
        } catch (e) {
          // Best effort: leave the remote doc if deletion fails.
          log(
            `unsync: delete failed for "${record.visibleName}": ${errMsg(e)}`,
          );
        }
      }
      await removeRecord(att.key);
    }
  }
}
