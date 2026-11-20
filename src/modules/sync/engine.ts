// Orchestrates the Zotero -> reMarkable push and the add/remove-from-sync
// actions. The pull side (annotations) is added in M2.

import { getPref } from "../../utils/prefs";
import { ensureNetworkGlobals } from "../../utils/globals";
import { log, errMsg } from "../../utils/log";
import * as client from "../remarkable/client";
import { fetchAnnotations, pdfIndexByPageId } from "../remarkable/annotations";
import { readPdfPageSizes, pageSizeAt } from "../remarkable/annotations";
import {
  getRecord,
  getRecordCached,
  setRecord,
  removeRecord,
  allRecords,
  refreshShared,
  markSynced,
  type PushedItem,
  type SyncRecord,
} from "./state";
import type { RemarkableApi } from "../remarkable/cloud";
import type { ItemRef } from "rmapi-js";
import type { RmDocPage } from "../remarkable/annotations";
import { keyedAuthors } from "../remarkable/zkey";
import { applyAnnotations, existingSig } from "./annotations";

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

/**
 * A PDF attachment is synced when it carries the sync tag; a regular item,
 * when one of its PDFs does.
 */
export function isItemSynced(item: Zotero.Item): boolean {
  if (item.isRegularItem()) return syncedPdfsOf([item]).length > 0;
  return item.isPDFAttachment() && item.hasTag(getSyncTag());
}

/** The PDF attachments of the given items (a PDF counts as its own). */
function pdfsOf(items: Zotero.Item[]): Zotero.Item[] {
  const out = new Map<number, Zotero.Item>();
  for (const item of items) {
    if (item.isPDFAttachment()) out.set(item.id, item);
    else if (item.isRegularItem())
      for (const att of Zotero.Items.get(item.getAttachments()))
        if (att.isPDFAttachment()) out.set(att.id, att);
  }
  return [...out.values()];
}

/** The synced (tagged) PDFs among the given items and their attachments. */
export function syncedPdfsOf(items: Zotero.Item[]): Zotero.Item[] {
  const tag = getSyncTag();
  return pdfsOf(items).filter((att) => att.hasTag(tag));
}

/** The PDF to sync for a regular item: Zotero's best attachment if a PDF. */
async function bestPdfOf(item: Zotero.Item): Promise<Zotero.Item | null> {
  try {
    const best = await item.getBestAttachments();
    const pdf = best.find((a) => a.isPDFAttachment());
    if (pdf) return pdf;
  } catch {
    /* fall back below */
  }
  return pdfsOf([item])[0] ?? null;
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
 * Run a Zotero sync (when the user has one set up), so the shared sync notes
 * are up to date before a reMarkable sync, and its changes reach the other
 * computers right after. Queues behind a Zotero sync already running.
 */
export async function syncZotero(): Promise<void> {
  const runner = (Zotero as any).Sync?.Runner;
  if (!runner?.enabled) return;
  try {
    await runner.sync({ background: true });
  } catch (e) {
    log(`Zotero sync failed: ${errMsg(e)}`);
  }
}

/** Start a reMarkable sync run: sync Zotero, then reload the shared state. */
export async function beginRun(progress?: ProgressFn): Promise<void> {
  progress?.("Syncing Zotero…", 0);
  await syncZotero();
  await refreshShared();
}

/** End a reMarkable sync run: send the state changes through Zotero sync. */
export async function endRun(): Promise<void> {
  await syncZotero();
}

/**
 * Safe mode (default on): never modify annotations on the device — pull only.
 * PDFs are still uploaded, since storing a document is non-destructive.
 */
export function isSafeMode(): boolean {
  return getPref("safeMode") !== false;
}

/** The distance (PDF points) for grouping pen strokes, 0 when not grouping. */
function strokeGroupGap(): number {
  if (getPref("groupStrokes") === false) return 0;
  const gap = Number(getPref("groupStrokesGap"));
  return Number.isFinite(gap) && gap >= 0 ? gap : 12;
}

/** Remove the sync tag from an item, if it has it. */
async function untag(item: Zotero.Item): Promise<void> {
  const tag = getSyncTag();
  if (item.hasTag(tag)) {
    item.removeTag(tag);
    await item.saveTx();
  }
}

/**
 * Stop syncing an attachment: drop its sync record and its sync tag (so it is
 * excluded from future syncs). Touches only Zotero — never the device. Used
 * when a document was deleted on the reMarkable.
 */
async function stopSync(att: Zotero.Item): Promise<void> {
  await removeRecord(att.key);
  await untag(att);
}

/** Items carrying the sync tag in every editable library. */
async function taggedItems(): Promise<Zotero.Item[]> {
  const out: Zotero.Item[] = [];
  for (const lib of Zotero.Libraries.getAll().filter((l) => l.editable)) {
    const search = new Zotero.Search();
    // `libraryID` is typed read-only but is assignable on a fresh search.
    (search as any).libraryID = lib.libraryID;
    search.addCondition("tag", "is", getSyncTag());
    out.push(...Zotero.Items.get(await search.search()));
  }
  return out;
}

/**
 * Move the sync tag from regular items (versions up to 0.3 tagged the item,
 * syncing all its PDFs) to their PDFs: those already synced, or else the best
 * one. Tags merge in Zotero sync, so two computers doing this at once agree.
 */
async function migrateItemTags(items: Zotero.Item[]): Promise<void> {
  const tag = getSyncTag();
  for (const item of items.filter((it) => it.isRegularItem())) {
    const pdfs = pdfsOf([item]).filter((att) => getRecordCached(att.key));
    if (!pdfs.length) {
      const best = await bestPdfOf(item);
      if (best) pdfs.push(best);
    }
    for (const att of pdfs) {
      if (!att.hasTag(tag)) {
        att.addTag(tag, 0);
        await att.saveTx();
      }
    }
    await untag(item);
    log(`sync tag moved from item ${item.key} to ${pdfs.length} PDF(s)`);
  }
}

/** Every synced PDF attachment, across the editable libraries. */
export async function findSyncedPdfs(): Promise<Zotero.Item[]> {
  const tagged = await taggedItems();
  await migrateItemTags(tagged);
  return syncedPdfsOf(await taggedItems());
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
 * Record for a freshly uploaded document. The new document starts with no
 * annotations: annotations pulled from the previous copy become the user's own
 * (so the annotation push writes them to the new copy) — except page-tag notes
 * when their tags were carried over by the upload (`tagsCarried`): those stay
 * tracked.
 */
function freshRecord(
  att: Zotero.Item,
  entry: { id: string; hash: string },
  fileHash: string,
  name: string,
  prev: SyncRecord | undefined,
  tagsCarried: boolean,
): SyncRecord {
  const notes = !tagsCarried
    ? []
    : (prev?.annotationKeys ?? []).filter((k) =>
        prev?.annotationSigs?.[k]?.startsWith("note|"),
      );
  return {
    docId: entry.id,
    docHash: entry.hash,
    fileHash,
    visibleName: name,
    libraryID: att.libraryID,
    lastPushed: Date.now(),
    annotationKeys: notes,
    annotationSigs: Object.fromEntries(
      notes.map((k) => [k, prev!.annotationSigs![k]]),
    ),
    pageTags: tagsCarried ? prev?.pageTags : undefined,
    pushedKeys: [],
    pushedItems: [],
    deletedSigs: [],
  };
}

/**
 * Documents directly in the sync folder that no record links to, by the
 * sha-256 of their PDF. The cloud names each file by the sha-256 of its bytes,
 * so this reads the document listings without downloading any PDF.
 */
async function unlinkedByPdfHash(
  api: RemarkableApi,
  folderId: string,
): Promise<Map<string, ItemRef[]>> {
  const linked = new Set(Object.values(await allRecords()).map((r) => r.docId));
  const out = new Map<string, ItemRef[]>();
  for (const e of await api.listItems()) {
    if (e.type !== "DocumentType" || (e.parent ?? "") !== folderId) continue;
    if (linked.has(e.id)) continue;
    try {
      const { entries } = await api.raw.getEntries({ id: e.id, hash: e.hash });
      const pdf = entries.find((x) => x.id.endsWith(".pdf"));
      if (pdf) {
        (out.get(pdf.hash) ?? out.set(pdf.hash, []).get(pdf.hash)!).push(e);
      }
    } catch (err) {
      log(`relink: could not list "${e.visibleName}": ${errMsg(err)}`);
    }
  }
  return out;
}

/**
 * Push every synced (tagged) PDF attachment to the configured reMarkable folder.
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
  // push exactly those; otherwise push every synced PDF.
  const attachments = (opts.attachments ?? (await findSyncedPdfs())).filter(
    (att) => !isInTrash(att),
  );
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
  const deviceDocIds = new Set((await api.listRefs()).map((e) => e.id));
  // Built on first need: unlinked folder documents, by PDF hash.
  let byPdfHash: Map<string, ItemRef[]> | undefined;

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

      // No record (e.g. a computer that never synced this item, and no shared
      // note): link to the document another computer uploaded for the same
      // PDF instead of uploading a duplicate.
      if (!existing && !opts.force) {
        byPdfHash ??= await unlinkedByPdfHash(api, folderId);
        const doc = byPdfHash.get(fileHash)?.shift();
        if (doc) {
          await setRecord(att.key, {
            docId: doc.id,
            docHash: doc.hash,
            fileHash,
            visibleName: name,
            libraryID: att.libraryID,
            lastPushed: Date.now(),
            annotationKeys: [],
            pushedKeys: [],
            pushedItems: [],
            deletedSigs: [],
            adopted: true,
          });
          log(`pushAll: linked "${name}" to existing document ${doc.id}`);
          summary.skipped++;
          done++;
          continue;
        }
      }
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

      // Replacing a document still on the device (PDF changed in Zotero, or a
      // forced overwrite): first pull its tablet annotations, unless Zotero
      // wins, so none is lost when the old copy goes to the device trash.
      const replacing = !!existing && !missingOnDevice;
      if (replacing && !opts.force) {
        log(`pushAll: "${name}" changed in Zotero — pulling before replacing`);
        const pull = await pullAll(progress, { onlyKeys: new Set([att.key]) });
        if (pull.failed) {
          throw new Error(
            `pull before replacing failed, kept the old copy: ${pull.errors.join("; ")}`,
          );
        }
      }
      const prev = replacing ? await getRecord(att.key) : existing;

      log(`pushAll: uploading "${name}" (${bytes.length} bytes) …`);
      const pageCount = await pdfPageCount(att);
      const entry = await client.uploadPdf(api, name, bytes, folderId, {
        pageCount: pageCount ?? undefined,
        pageTags: prev?.pageTags,
      });
      await setRecord(
        att.key,
        freshRecord(att, entry, fileHash, name, prev, !!pageCount),
      );
      log(`pushAll: uploaded "${name}" -> ${entry.id}`);

      if (replacing && prev) {
        try {
          const old = await client.findById(api, prev.docId);
          if (old) await client.trashDoc(api, old);
          log(`pushAll: moved the old copy of "${name}" to reMarkable trash`);
        } catch (e) {
          log(`pushAll: could not trash old copy of "${name}": ${errMsg(e)}`);
        }
      }
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
 * `rec.deletedSigs` plus the signatures of pulled annotations the user has
 * deleted in Zotero since the last pull, so the pull does not re-create them.
 * Page-tag notes are excluded: deleting one removes the tags on the device.
 */
function withZoteroDeletions(rec: SyncRecord, libraryID: number): string[] {
  const out = new Set(rec.deletedSigs ?? []);
  for (const key of rec.annotationKeys ?? []) {
    const sig = rec.annotationSigs?.[key];
    if (!sig || sig.startsWith("note|")) continue;
    const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
    if (!item || (item as Zotero.Item).deleted) {
      log(`pullAll: annotation ${key} deleted in Zotero, won't re-pull it`);
      out.add(sig);
    }
  }
  return [...out];
}

/**
 * Drop the device items written for Zotero annotations under their own author
 * (zkey.ts): they mirror Zotero annotations, so the pull must not import them,
 * whichever computer pushed them.
 */
function withoutZoteroItems(pages: RmDocPage[]): RmDocPage[] {
  return pages.map((p) => {
    const keyed = keyedAuthors(p.page.authors);
    if (keyed.size === 0) return p;
    const fromDevice = (it: { ids?: { part1: number }[] }) =>
      !it.ids?.length || it.ids.some((i) => !keyed.has(i.part1));
    return {
      ...p,
      page: {
        ...p.page,
        strokes: p.page.strokes.filter(fromDevice),
        highlights: p.page.highlights.filter(fromDevice),
      },
    };
  });
}

/**
 * Zotero annotations pushed to the device whose items were all erased there:
 * their page is still in the document, but none of their item ids is. `pages`
 * are the device pages as fetched (Zotero items included).
 */
function erasedOnDevice(
  rec: SyncRecord,
  pages: RmDocPage[],
  pageIds: Set<string>,
): PushedItem[] {
  const present = new Set<string>();
  for (const { pageUuid, page } of pages) {
    for (const it of [...page.strokes, ...page.highlights]) {
      for (const id of it.ids ?? []) {
        present.add(`${pageUuid}:${id.part1},${id.part2}`);
      }
    }
  }
  return (rec.pushedItems ?? []).filter(
    (t) =>
      pageIds.has(t.page) &&
      t.ids.length > 0 &&
      t.ids.every(([a, c]) => !present.has(`${t.page}:${a},${c}`)),
  );
}

/**
 * Move a Zotero annotation whose items were erased on the device to the Zotero
 * trash. Returns false if it is already gone or could not be trashed.
 */
export async function trashErasedAnnotation(
  libraryID: number,
  key: string,
): Promise<boolean> {
  const item = Zotero.Items.getByLibraryAndKey(libraryID, key) as
    | Zotero.Item
    | false;
  if (!item || item.deleted) return false;
  try {
    item.deleted = true;
    await item.saveTx({ skipSelect: true });
    log(`sync: annotation ${key} erased on the device, moved to trash`);
    return true;
  } catch (e) {
    log(`sync: could not trash annotation ${key}: ${errMsg(e)}`);
    return false;
  }
}

/**
 * Move to the Zotero trash the annotations whose pushed items were erased on
 * the device (not in safe mode, and only when the device changed the document
 * since our last write). Returns the record without them, and how many were
 * trashed. A trashed annotation restored by the user is pushed again.
 */
async function trashErased(
  rec: SyncRecord,
  hash: string,
  pages: RmDocPage[],
  pageIds: Set<string>,
  libraryID: number,
): Promise<{ rec: SyncRecord; trashed: number }> {
  if (isSafeMode() || hash === rec.pushedVersion) return { rec, trashed: 0 };
  const erased = erasedOnDevice(rec, pages, pageIds);
  if (!erased.length) return { rec, trashed: 0 };
  let trashed = 0;
  for (const t of erased) {
    if (await trashErasedAnnotation(libraryID, t.key)) trashed++;
  }
  const gone = new Set(erased.map((t) => t.key));
  const pushedItems = (rec.pushedItems ?? []).filter((t) => !gone.has(t.key));
  return {
    rec: {
      ...rec,
      pushedItems,
      pushedKeys: pushedItems.map((t) => t.key),
    },
    trashed,
  };
}

/** Content signatures of the given annotations, by key. */
function sigsOf(keys: string[], libraryID: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
    const sig = item && existingSig(item as Zotero.Item);
    if (sig) out[key] = sig;
  }
  return out;
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

  // Snapshot the cloud listing once (ids and hashes), then look up each doc.
  const remote = await api.listRefs(true);
  const byId = new Map(remote.map((e) => [e.id, e]));

  const ok: string[] = []; // checked without error
  let done = 0;
  for (const attKey of keys) {
    const rec = records[attKey];
    const pct = Math.round((done / keys.length) * 100);
    try {
      const libraryID = rec.libraryID ?? Zotero.Libraries.userLibraryID;
      const att = Zotero.Items.getByLibraryAndKey(libraryID, attKey);
      if (!att || isInTrash(att as Zotero.Item)) {
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
        ok.push(attKey);
        done++;
        continue; // unchanged since last pull
      }

      progress?.(`Pulling annotations: ${rec.visibleName}`, pct);
      log(`pullAll: fetching "${rec.visibleName}" (${rec.docId})`);
      const { pages, pageTags, content } = await fetchAnnotations(
        api,
        rec.docId,
        entry.hash,
      );
      // Zotero annotations erased on the device go to the Zotero trash.
      const erased = await trashErased(
        rec,
        entry.hash,
        pages,
        new Set(pdfIndexByPageId(content).keys()),
        libraryID,
      );

      const path = await (att as Zotero.Item).getFilePathAsync();
      const bytes: Uint8Array = path
        ? await IO.IOUtils.read(path)
        : new Uint8Array();
      const sizes = readPdfPageSizes(bytes);

      const deletedSigs = withZoteroDeletions(rec, libraryID);
      const result = await applyAnnotations(
        att as Zotero.Item,
        withoutZoteroItems(pages),
        sizes,
        rec.annotationKeys ?? [],
        deletedSigs,
        pageTags,
        { groupGap: strokeGroupGap() },
      );

      const updated: SyncRecord = {
        ...erased.rec,
        lastPulledVersion: entry.hash,
        adopted: undefined,
        annotationKeys: result.keys,
        annotationSigs: sigsOf(result.keys, libraryID),
        annotationSources: result.sources,
        deletedSigs,
        pageTags: Object.fromEntries(
          pageTags.map((t) => [String(t.pdfPageIndex), t.names]),
        ),
      };
      await setRecord(attKey, updated);
      summary.updated++;
      ok.push(attKey);
      summary.annotations += result.added;
      summary.removed += result.removed + erased.trashed;
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
  await markSynced(ok);
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
 * Forget the given attachments after they were permanently deleted in Zotero
 * (emptied from the trash). If `deleteOnUnsync` is on, their reMarkable
 * documents go to the device trash (recoverable there); otherwise they are
 * left on the device. Items merely moved to the Zotero trash are not handled
 * here: sync skips them until they are restored ({@link isInTrash}).
 */
export async function unsyncByKeys(attKeys: string[]): Promise<void> {
  const want = new Set(attKeys);
  const records = await allRecords();
  const hits = Object.keys(records).filter((k) => want.has(k));
  if (hits.length === 0) return;

  let api: Awaited<ReturnType<typeof client.getApi>> | null = null;
  if (getPref("deleteOnUnsync") && client.isConnected()) {
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
        if (entry) await client.trashDoc(api, entry);
        log(`unsync: moved "${rec.visibleName}" to reMarkable trash`);
      } catch (e) {
        log(`unsync: trash failed for "${rec.visibleName}": ${errMsg(e)}`);
      }
    } else {
      log(`unsync: forgot "${rec.visibleName}" (kept on the device)`);
    }
    await removeRecord(attKey);
  }
}

/** True if the attachment or its parent item is in the Zotero trash. */
export function isInTrash(att: Zotero.Item): boolean {
  return !!att.deleted || !!att.parentItem?.deleted;
}

/**
 * Tag PDFs so they are included in sync: a selected PDF itself, or for a
 * regular item with no synced PDF, its best PDF (one document per paper).
 */
export async function addToSync(items: Zotero.Item[]): Promise<void> {
  const tag = getSyncTag();
  const targets: Zotero.Item[] = [];
  for (const item of items) {
    if (item.isPDFAttachment()) targets.push(item);
    else if (item.isRegularItem() && !isItemSynced(item)) {
      const best = await bestPdfOf(item);
      if (best) targets.push(best);
    }
  }
  for (const att of targets) {
    if (att.hasTag(tag)) continue;
    att.addTag(tag, 0);
    await att.saveTx();
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
    /** delete permanently instead of moving to the reMarkable trash */
    purge?: boolean;
    pullFirst?: boolean;
    progress?: ProgressFn;
  } = {},
): Promise<void> {
  const deleteRemote = opts.deleteRemote ?? !!getPref("deleteOnUnsync");

  // A selected PDF, or a regular item's synced PDFs (all its PDFs with a
  // record, for one tagged by an older version).
  const pdfs = pdfsOf(items).filter(
    (att) => att.hasTag(getSyncTag()) || !!getRecordCached(att.key),
  );
  const attKeys = new Set(
    pdfs.filter((att) => getRecordCached(att.key)).map((att) => att.key),
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

  for (const item of items) await untag(item); // tagged by an older version
  for (const att of pdfs) {
    await untag(att);
    const record = await getRecord(att.key);
    if (record && api && !keepRemote.has(att.key)) {
      try {
        const entry = await client.findById(api, record.docId);
        if (entry && opts.purge) {
          await client.purgeDoc(api, entry);
          log(`unsync: permanently deleted "${record.visibleName}"`);
        } else if (entry) {
          await client.trashDoc(api, entry);
          log(`unsync: moved "${record.visibleName}" to reMarkable trash`);
        }
      } catch (e) {
        // Best effort: leave the remote doc if deletion fails.
        log(`unsync: delete failed for "${record.visibleName}": ${errMsg(e)}`);
      }
    }
    await removeRecord(att.key);
  }
}
