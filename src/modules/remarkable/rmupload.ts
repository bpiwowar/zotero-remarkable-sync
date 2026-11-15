// Write changes back to a reMarkable document via the raw sync API.
//
// reMarkable's store is content-addressed: a document is a list of file
// entries; the whole account is a list of documents; the hash of that list is
// the root hash. To change a page we: upload the new .rm blob (putFile), rebuild
// the document's entry list (putEntries), rebuild the root list (putEntries),
// then commit the new root (putRootHash, guarded by the generation).

import { GenerationError } from "rmapi-js";
import type { RemarkableApi, RawEntry, DocumentContent } from "rmapi-js";
import { log } from "../../utils/log";

/** The document is not (yet) in the root listing — e.g. just uploaded. */
class DocNotInRootError extends Error {
  constructor(docId: string) {
    super(`document ${docId} not found in root`);
    this.name = "DocNotInRootError";
  }
}

function upsert(entries: RawEntry[], entry: RawEntry): void {
  const i = entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) entries[i] = entry;
  else entries.push(entry);
}

async function updateOnce(
  api: RemarkableApi,
  docId: string,
  pageRm: Map<string, Uint8Array>,
  bumpMetadata: boolean,
  editContent?: (content: DocumentContent) => boolean,
): Promise<void> {
  const raw = api.raw;
  const [rootHash, generation, schema] = await raw.getRootHash();
  // Log a recovery snapshot before any write (the raw API can corrupt the root).
  log(`rmupload: pre-write root=${rootHash} generation=${generation}`);

  const root = await raw.getEntries("root.docSchema", rootHash);
  // Snapshot the original document ids so we can refuse to commit a root that
  // would drop any of them (safety against a bug in the entry rebuild).
  const originalIds = new Set(root.entries.map((e) => e.id));
  const docEntry = root.entries.find((e) => e.id === docId);
  if (!docEntry) throw new DocNotInRootError(docId);

  const doc = await raw.getEntries(`${docId}.docSchema`, docEntry.hash);

  // Write each page's .rm blob. Reuse the exact file id when the page already
  // has one; otherwise derive a new id from an existing .rm entry's prefix.
  for (const [pageUuid, bytes] of pageRm) {
    const existing = doc.entries.find((e) => e.id.endsWith(`${pageUuid}.rm`));
    let fileId: string;
    if (existing) {
      fileId = existing.id;
    } else {
      const sample = doc.entries.find((e) => e.id.endsWith(".rm"));
      const slash = sample ? sample.id.lastIndexOf("/") : -1;
      const prefix = slash >= 0 ? sample!.id.slice(0, slash + 1) : `${docId}/`;
      fileId = `${prefix}${pageUuid}.rm`;
      log(`rmupload: creating new page file ${fileId}`);
    }
    const [fileEntry, finish] = await raw.putFile(fileId, bytes);
    await finish;
    upsert(doc.entries, fileEntry);
  }

  // Edit the document's .content (read fresh, so a retry sees the latest).
  if (editContent) {
    const contentEnt = doc.entries.find((e) => e.id.endsWith(".content"));
    if (!contentEnt) throw new Error(`document ${docId} has no .content`);
    const content = (await raw.getContent(
      contentEnt.id,
      contentEnt.hash,
    )) as DocumentContent;
    if (editContent(content)) {
      const [newContent, finish] = await raw.putContent(contentEnt.id, content);
      await finish;
      upsert(doc.entries, newContent);
    } else if (pageRm.size === 0) {
      return; // nothing left to change
    }
  }

  // Touch the document so the device notices the change.
  if (bumpMetadata) {
    const metaEnt = doc.entries.find((e) => e.id.endsWith(".metadata"));
    if (metaEnt) {
      try {
        const meta = await raw.getMetadata(metaEnt.id, metaEnt.hash);
        (meta as any).lastModified = String(Date.now());
        const [newMeta, finish] = await raw.putMetadata(metaEnt.id, meta);
        await finish;
        upsert(doc.entries, newMeta);
      } catch (e) {
        log(`rmupload: metadata bump skipped: ${(e as Error).message ?? e}`);
      }
    }
  }

  const [newDocEntry, finishDoc] = await raw.putEntries(
    docId,
    doc.entries,
    schema,
  );
  await finishDoc;
  upsert(root.entries, newDocEntry);

  // Safety: never commit a root that lost a document.
  const newIds = new Set(root.entries.map((e) => e.id));
  for (const id of originalIds) {
    if (!newIds.has(id)) {
      throw new Error(
        `refusing to commit: document ${id} would be dropped from the root`,
      );
    }
  }

  const [newRootEntry, finishRoot] = await raw.putEntries(
    "root",
    root.entries,
    schema,
  );
  await finishRoot;

  await raw.putRootHash(newRootEntry.hash, generation);
}

/**
 * Replace the given pages' `.rm` blobs in a reMarkable document and commit.
 * `editContent` may modify the document's `.content` in the same commit (return
 * true if it changed anything). Retries on a GenerationError (a concurrent
 * change moved the root).
 */
export async function updateDocumentPages(
  api: RemarkableApi,
  docId: string,
  pageRm: Map<string, Uint8Array>,
  opts: {
    bumpMetadata?: boolean;
    editContent?: (content: DocumentContent) => boolean;
  } = {},
): Promise<void> {
  if (pageRm.size === 0 && !opts.editContent) return;
  const bump = opts.bumpMetadata ?? true;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await updateOnce(api, docId, pageRm, bump, opts.editContent);
      return;
    } catch (e) {
      if (e instanceof GenerationError) {
        log(`rmupload: generation changed, retry ${attempt + 1}`);
        lastErr = e;
        continue;
      }
      if (e instanceof DocNotInRootError) {
        log(`rmupload: ${e.message}, retry ${attempt + 1} after a delay`);
        lastErr = e;
        await Zotero.Promise.delay(2000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
