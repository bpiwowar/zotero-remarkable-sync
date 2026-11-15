// Clean up the reMarkable sync folder: find documents there that are not linked
// to a tagged Zotero item, and let the user relink, trash or ignore each one.
//
// Caution first: only *direct* documents of the configured folder are
// considered (sub-folders are left alone), the folder is never created, and
// "delete" moves the document to the reMarkable trash (recoverable on the
// device) rather than erasing it.

import type { Entry, RemarkableApi } from "rmapi-js";
import { getPref } from "../../utils/prefs";
import { ensureNetworkGlobals } from "../../utils/globals";
import { log, errMsg } from "../../utils/log";
import * as client from "../remarkable/client";
import { allRecords, getRecord, setRecord, type SyncRecord } from "./state";
import { getSyncTag, displayNameFor, sha256Hex } from "./engine";

const IO = globalThis as any;

export interface Orphan {
  entry: Entry;
  /** Zotero PDF attachment the document could be relinked to, if any. */
  candidate?: Zotero.Item;
  /** Why the candidate was chosen (shown to the user). */
  reason?: "record" | "title";
  /** Number of matching attachments (when matched by title). */
  matches?: number;
}

export type Decision = "ignore" | "relink" | "delete";

/** Resolve the configured folder path without creating anything. */
function findFolderId(entries: Entry[], path: string): string | null {
  const parts = path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  let parent = "";
  for (const name of parts) {
    const found = entries.find(
      (e) =>
        e.type === "CollectionType" &&
        e.visibleName === name &&
        (e.parent ?? "") === parent,
    );
    if (!found) return null;
    parent = found.id;
  }
  return parent;
}

function isLive(item: Zotero.Item | false | undefined): item is Zotero.Item {
  return !!item && !item.deleted && !(item.parentItem?.deleted ?? false);
}

/** PDF attachments whose parent's title equals `name`, in editable libraries. */
async function attachmentsByTitle(name: string): Promise<Zotero.Item[]> {
  const out: Zotero.Item[] = [];
  for (const lib of Zotero.Libraries.getAll().filter((l) => l.editable)) {
    const search = new Zotero.Search();
    (search as any).libraryID = lib.libraryID;
    search.addCondition("title", "is", name);
    const items = Zotero.Items.get(await search.search());
    for (const item of items) {
      if (!item.isRegularItem() || item.deleted) continue;
      for (const att of Zotero.Items.get(item.getAttachments())) {
        if (
          att.isPDFAttachment() &&
          !att.deleted &&
          displayNameFor(att) === name
        )
          out.push(att);
      }
    }
  }
  return out;
}

/**
 * List the documents of the sync folder that are not linked (via a sync record)
 * to a tagged Zotero item, each with a relink candidate when one is found.
 */
export async function findOrphans(
  api: RemarkableApi,
): Promise<{ orphans: Orphan[]; folderFound: boolean }> {
  const tag = getSyncTag();
  const entries = await api.listItems(true);
  const folderId = findFolderId(entries, getPref("folder") || "");
  if (folderId === null) return { orphans: [], folderFound: false };

  const live = new Set(entries.map((e) => e.id));
  const records = await allRecords();
  const byDoc = new Map<string, [string, SyncRecord]>();
  for (const [key, rec] of Object.entries(records))
    byDoc.set(rec.docId, [key, rec]);

  const orphans: Orphan[] = [];
  for (const entry of entries) {
    if (entry.type !== "DocumentType" || (entry.parent ?? "") !== folderId)
      continue;

    const linked = byDoc.get(entry.id);
    if (linked) {
      const [attKey, rec] = linked;
      const att = Zotero.Items.getByLibraryAndKey(
        rec.libraryID ?? Zotero.Libraries.userLibraryID,
        attKey,
      ) as Zotero.Item | false;
      if (isLive(att)) {
        if (att.parentItem?.hasTag(tag)) continue; // properly synced
        orphans.push({ entry, candidate: att, reason: "record" });
        continue;
      }
    }

    // No usable record: look for a Zotero PDF with the same title that is not
    // already linked to another document still on the device.
    const matches: Zotero.Item[] = [];
    for (const att of await attachmentsByTitle(entry.visibleName)) {
      const rec = records[att.key];
      if (rec && rec.docId !== entry.id && live.has(rec.docId)) continue;
      matches.push(att);
    }
    orphans.push({
      entry,
      candidate: matches[0],
      reason: matches.length ? "title" : undefined,
      matches: matches.length,
    });
  }
  log(`cleanup: ${orphans.length} untracked document(s) in sync folder`);
  return { orphans, folderFound: true };
}

/**
 * Link a device document to a Zotero PDF: tag its parent item and record the
 * mapping so the next sync pulls its annotations instead of re-uploading.
 */
async function relink(entry: Entry, att: Zotero.Item): Promise<void> {
  const parent = att.parentItem;
  const tag = getSyncTag();
  if (parent && !parent.hasTag(tag)) {
    parent.addTag(tag, 0);
    await parent.saveTx();
  }

  const existing = await getRecord(att.key);
  if (existing?.docId === entry.id) {
    await setRecord(att.key, { ...existing, docHash: entry.hash });
    return;
  }
  // Treat the device copy as current for the local file, so no re-upload.
  const path = await att.getFilePathAsync();
  const fileHash = path ? await sha256Hex(await IO.IOUtils.read(path)) : "";
  await setRecord(att.key, {
    docId: entry.id,
    docHash: entry.hash,
    fileHash,
    visibleName: entry.visibleName,
    libraryID: att.libraryID,
    lastPushed: Date.now(),
    annotationKeys: [],
    pushedKeys: [],
    pushedItems: [],
  });
}

export interface CleanupSummary {
  relinked: number;
  trashed: number;
  failed: number;
  errors: string[];
}

/** Apply the user's decisions. "delete" moves the document to the device trash. */
export async function applyDecisions(
  api: RemarkableApi,
  decisions: { orphan: Orphan; decision: Decision }[],
): Promise<CleanupSummary> {
  ensureNetworkGlobals();
  const summary: CleanupSummary = {
    relinked: 0,
    trashed: 0,
    failed: 0,
    errors: [],
  };
  for (const { orphan, decision } of decisions) {
    const name = orphan.entry.visibleName;
    try {
      if (decision === "relink" && orphan.candidate) {
        await relink(orphan.entry, orphan.candidate);
        log(`cleanup: relinked "${name}" -> ${orphan.candidate.key}`);
        summary.relinked++;
      } else if (decision === "delete") {
        // Re-read the entry so we move the current hash, not a stale one.
        const current = await client.findById(api, orphan.entry.id);
        if (current) await client.trashDoc(api, current);
        log(`cleanup: moved "${name}" to reMarkable trash`);
        summary.trashed++;
      }
    } catch (e) {
      log(`cleanup: FAILED "${name}": ${errMsg(e)}`);
      summary.failed++;
      summary.errors.push(`${name}: ${errMsg(e)}`);
    }
  }
  return summary;
}
