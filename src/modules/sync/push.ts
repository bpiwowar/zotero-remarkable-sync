// Push Zotero annotations to the reMarkable.
//
// For each synced attachment, take the annotations that originated in Zotero
// (not pulled from the device, not already pushed), convert them to reMarkable
// strokes/highlights, and write them onto the relevant page, then commit via the
// raw sync API. A page that already has a `.rm` is appended to (reusing its
// layer); a page with none gets a new `.rm` cloned from another page's structure
// (loadTemplate). If the document has no `.rm` anywhere, those pages are skipped.

import { ensureNetworkGlobals } from "../../utils/globals";
import { log, errMsg } from "../../utils/log";
import type { RemarkableApi } from "rmapi-js";
import * as client from "../remarkable/client";
import {
  mapPdfPages,
  pdfIndexByPageId,
  type PageRef,
} from "../remarkable/rmdoc";
import { parseRmPage } from "../remarkable/rmlines";
import type { RmStroke, RmHighlight, CrdtId } from "../remarkable/rmlines";
import {
  rebuildPage,
  splitStructure,
  blankStructure,
} from "../remarkable/rmwrite";
import { updateDocumentPages } from "../remarkable/rmupload";
import { zoteroToRm } from "../remarkable/colors";
import {
  readPdfPageSizes,
  pageSizeAt,
  zoteroRectToRm,
  zoteroPathToRm,
  pdfWidthToRm,
  type PdfPageSize,
} from "../remarkable/geometry";
import {
  allRecords,
  setRecord,
  type PushedItem,
  type SyncRecord,
} from "./state";
import { existingSig, pushFingerprint } from "./annotations";
import {
  isSafeMode as engineIsSafeMode,
  isInTrash,
  pdfPageCount,
  type ProgressFn,
} from "./engine";

const IO = globalThis as any;
const PUSHABLE = new Set(["highlight", "underline", "ink"]);

export interface PushSummary {
  pushed: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/** Convert one Zotero annotation to reMarkable strokes/highlights. */
function annotationToRm(
  item: Zotero.Item,
  size: PdfPageSize,
): { strokes: RmStroke[]; highlights: RmHighlight[] } {
  const out = { strokes: [] as RmStroke[], highlights: [] as RmHighlight[] };
  const color = item.annotationColor || "#ffd400";
  let pos: { rects?: number[][]; paths?: number[][]; width?: number };
  try {
    pos = JSON.parse(item.annotationPosition);
  } catch {
    return out;
  }
  const type = item.annotationType;
  const index = zoteroToRm(color);
  if (type === "highlight" || type === "underline") {
    const text = item.annotationText || "";
    // Break a multi-line Zotero highlight into one GlyphRange per line so each
    // line renders on the device. Text goes on the first; pull rejoins them.
    // No rgba: the device renders its native palette colour for `index`.
    (pos.rects ?? []).forEach((r, i) => {
      out.highlights.push({
        text: i === 0 ? text : "",
        colorIndex: index,
        rects: [zoteroRectToRm(r as [number, number, number, number], size)],
      });
    });
  } else if (type === "ink") {
    const width = pdfWidthToRm(pos.width ?? 1);
    for (const path of pos.paths ?? []) {
      const points = zoteroPathToRm(path, size);
      if (points.length) {
        out.strokes.push({
          tool: 17, // fineliner
          colorIndex: index,
          thickness: 2,
          pointWidth: width,
          isHighlighter: false,
          points,
        });
      }
    }
  }
  return out;
}

/**
 * Device page tags the user removed in Zotero, by PDF page index: tags in the
 * last-pulled baseline that are no longer on that page's tag note (all of them
 * if the note was deleted).
 */
function removedPageTags(
  att: Zotero.Item,
  rec: SyncRecord,
): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  const baseline = rec.pageTags ?? {};
  if (Object.keys(baseline).length === 0) return out;
  const ours = new Set(rec.annotationKeys ?? []);
  const noteTags = new Map<number, Set<string>>();
  for (const a of att.getAnnotations()) {
    if (a.annotationType !== "note" || !ours.has(a.key)) continue;
    let pi: number;
    try {
      pi = JSON.parse(a.annotationPosition).pageIndex;
    } catch {
      continue;
    }
    const set = noteTags.get(pi) ?? noteTags.set(pi, new Set()).get(pi)!;
    for (const t of a.getTags()) set.add(t.tag);
  }
  for (const [page, names] of Object.entries(baseline)) {
    const pi = Number(page);
    const kept = noteTags.get(pi) ?? new Set<string>();
    const gone = names.filter((n) => !kept.has(n));
    if (gone.length) out.set(pi, new Set(gone));
  }
  return out;
}

/** Remove from the device the page tags the user removed in Zotero. */
async function pushPageTagRemovals(
  api: RemarkableApi,
  att: Zotero.Item,
  attKey: string,
  rec: SyncRecord,
): Promise<number> {
  const removed = removedPageTags(att, rec);
  if (removed.size === 0) return 0;
  let count = 0;
  await updateDocumentPages(api, rec.docId, new Map(), {
    editContent: (content) => {
      const indexOf = pdfIndexByPageId(content);
      const before = content.pageTags ?? [];
      const after = before.filter((t) => {
        const pi = indexOf.get(t.pageId);
        return !(pi !== undefined && removed.get(pi)?.has(t.name?.trim()));
      });
      count = before.length - after.length;
      content.pageTags = after;
      return count > 0;
    },
  });
  // Update the baseline so the removal is not re-applied.
  const pageTags: Record<string, string[]> = {};
  for (const [page, names] of Object.entries(rec.pageTags ?? {})) {
    const gone = removed.get(Number(page));
    const left = gone ? names.filter((n) => !gone.has(n)) : names;
    if (left.length) pageTags[page] = left;
  }
  rec.pageTags = pageTags;
  await setRecord(attKey, rec);
  const desc = [...removed]
    .map(([pi, names]) => `p${pi + 1}: ${[...names].join(", ")}`)
    .join("; ");
  log(`push: "${rec.visibleName}" removed page tag(s) on device (${desc})`);
  return count;
}

interface Template {
  structure: Uint8Array;
  layerId: CrdtId;
  author: number;
  startCounter: number;
}

/** Find any page that has a `.rm` and turn it into a structural template. */
async function loadTemplate(
  api: RemarkableApi,
  pageMap: Map<number, PageRef>,
): Promise<Template | null> {
  for (const ref of pageMap.values()) {
    if (!ref.rmEntry) continue;
    try {
      const bytes = await api.raw.getHash(ref.rmEntry.id, ref.rmEntry.hash);
      const parsed = parseRmPage(bytes);
      if (parsed.layerId) {
        return {
          structure: splitStructure(bytes),
          layerId: parsed.layerId,
          author: parsed.lastItemId?.part1 ?? parsed.maxAuthor,
          startCounter: parsed.maxCounter + 1,
        };
      }
    } catch {
      // try the next page
    }
  }
  return null;
}

/** Push Zotero-origin annotations for every synced attachment. */
export async function pushAnnotations(
  progress?: ProgressFn,
  opts: { onlyKeys?: Set<string> } = {},
): Promise<PushSummary> {
  ensureNetworkGlobals();
  const summary: PushSummary = { pushed: 0, skipped: 0, failed: 0, errors: [] };

  // Safe mode never rewrites `.rm` pages on the device. This is the single guard
  // that guarantees no annotation push can happen while it is on.
  if (engineIsSafeMode()) {
    log("pushAnnotations: skipped (safe mode on)");
    return summary;
  }

  const records = await allRecords();
  const keys = Object.keys(records).filter(
    (k) => !opts.onlyKeys || opts.onlyKeys.has(k),
  );
  if (keys.length === 0) return summary;

  const api = await client.getApi();
  const remote = await api.listItems(true);
  const byId = new Map(remote.map((e) => [e.id, e]));

  let done = 0;
  for (const attKey of keys) {
    const rec = records[attKey];
    const pct = Math.round((done / keys.length) * 100);
    try {
      const libraryID = rec.libraryID ?? Zotero.Libraries.userLibraryID;
      const att = Zotero.Items.getByLibraryAndKey(libraryID, attKey);
      // A document uploaded moments ago may not be in the listing yet: fall back
      // to the hash returned by the upload.
      const listed = byId.get(rec.docId);
      const entry = listed ?? (rec.docHash ? { hash: rec.docHash } : undefined);
      if (!listed && entry) {
        log(`push: "${rec.visibleName}" not listed yet, using upload hash`);
      }
      if (att && isInTrash(att as Zotero.Item)) {
        done++;
        continue;
      }
      if (!att || !entry) {
        log(
          `push: skip "${rec.visibleName}" (${!att ? "no attachment" : "not on cloud"})`,
        );
        done++;
        continue;
      }

      await pushPageTagRemovals(api, att as Zotero.Item, attKey, rec);

      const pulled = new Set(rec.annotationKeys ?? []);
      const tracked = rec.pushedItems ?? [];

      // Zotero-origin annotations we manage (current set).
      const managed = (att as Zotero.Item)
        .getAnnotations()
        .filter((a) => PUSHABLE.has(a.annotationType) && !pulled.has(a.key));
      if (managed.length === 0 && tracked.length === 0) {
        done++;
        continue;
      }

      progress?.(`Pushing annotations: ${rec.visibleName}`, pct);
      const path = await (att as Zotero.Item).getFilePathAsync();
      const pdfBytes: Uint8Array = path
        ? await IO.IOUtils.read(path)
        : new Uint8Array();
      const sizes = readPdfPageSizes(pdfBytes);
      const pageMap = await mapPdfPages(api, rec.docId, entry.hash);
      // A document uploaded with a placeholder page list (rmapi-js putPdf) and
      // not yet opened on the device lists fewer pages than the PDF: page
      // uuids are not final, so writing pages now would target the wrong ones.
      const total = await pdfPageCount(att as Zotero.Item);
      if (total && pageMap.size < total) {
        log(
          `push: "${rec.visibleName}" lists ${pageMap.size}/${total} pages on ` +
            `the device — open it once on the reMarkable, then sync again`,
        );
        summary.skipped += managed.length;
        done++;
        continue;
      }
      const findRef = (pageUuid: string) => {
        for (const [pi, r] of pageMap)
          if (r.pageUuid === pageUuid) return { pdfIdx: pi, ref: r };
        return null;
      };

      // Group current managed annotations by reMarkable page.
      const managedByPage = new Map<string, Zotero.Item[]>();
      for (const a of managed) {
        let pi = 0;
        try {
          pi = JSON.parse(a.annotationPosition).pageIndex ?? 0;
        } catch {
          continue;
        }
        const ref = pageMap.get(pi);
        if (!ref) {
          summary.skipped++;
          continue;
        }
        (
          managedByPage.get(ref.pageUuid) ??
          managedByPage.set(ref.pageUuid, []).get(ref.pageUuid)!
        ).push(a);
      }

      // Group previously-written items by page (ids to remove, keys present).
      const trackedByPage = new Map<
        string,
        { ids: CrdtId[]; keys: Set<string>; revs: Map<string, string> }
      >();
      for (const t of tracked) {
        const e =
          trackedByPage.get(t.page) ??
          trackedByPage
            .set(t.page, { ids: [], keys: new Set(), revs: new Map() })
            .get(t.page)!;
        for (const [p1, p2] of t.ids) e.ids.push({ part1: p1, part2: p2 });
        e.keys.add(t.key);
        if (t.rev) e.revs.set(t.key, t.rev);
      }

      const pageUuids = new Set<string>([
        ...managedByPage.keys(),
        ...trackedByPage.keys(),
      ]);

      let template: Template | null | undefined;
      const pageRm = new Map<string, Uint8Array>();
      const newTracked: PushedItem[] = [];
      const rewritten = new Set<string>();
      let writtenItems = 0;

      for (const pageUuid of pageUuids) {
        const managedItems = managedByPage.get(pageUuid) ?? [];
        const here = trackedByPage.get(pageUuid) ?? {
          ids: [],
          keys: new Set<string>(),
          revs: new Map<string, string>(),
        };
        const managedKeys = new Set(managedItems.map((a) => a.key));
        // Skip pages whose managed set is unchanged — same annotations, none
        // edited since pushed (avoids re-uploads/churn).
        const sameSet =
          managedKeys.size === here.keys.size &&
          managedItems.every((a) => {
            if (!here.keys.has(a.key)) return false;
            const was = here.revs.get(a.key);
            return !was || pushFingerprint(a) === was;
          });
        if (sameSet) continue;

        const found = findRef(pageUuid);
        const size = pageSizeAt(sizes, found ? found.pdfIdx : 0);
        const strokes: RmStroke[] = [];
        const highlights: RmHighlight[] = [];
        const hlOwners: string[] = [];
        const stOwners: string[] = [];
        for (const a of managedItems) {
          const c = annotationToRm(a, size);
          for (const h of c.highlights) {
            highlights.push(h);
            hlOwners.push(a.key);
          }
          for (const s of c.strokes) {
            strokes.push(s);
            stOwners.push(a.key);
          }
        }

        let bytes: Uint8Array;
        let ids: CrdtId[];
        if (found?.ref.rmEntry) {
          const existing = await api.raw.getHash(
            found.ref.rmEntry.id,
            found.ref.rmEntry.hash,
          );
          const parsed = parseRmPage(existing);
          if (!parsed.layerId) continue;
          const removeIds = new Set(
            here.ids.map((id) => `${id.part1},${id.part2}`),
          );
          ({ bytes, ids } = rebuildPage(
            existing,
            strokes,
            highlights,
            removeIds,
            {
              layerId: parsed.layerId,
              lastItemId: parsed.lastItemId,
              author:
                parsed.lastItemId?.part1 ??
                parsed.layerId.part1 ??
                parsed.maxAuthor,
              startCounter: parsed.maxCounter + 1,
            },
          ));
        } else {
          if (managedItems.length === 0) continue; // deletion on a vanished page
          if (template === undefined) {
            template = (await loadTemplate(api, pageMap)) ?? blankStructure();
          }
          if (!template) continue;
          ({ bytes, ids } = rebuildPage(
            template.structure,
            strokes,
            highlights,
            new Set(),
            {
              layerId: template.layerId,
              author: template.author,
              startCounter: template.startCounter,
            },
          ));
        }
        pageRm.set(pageUuid, bytes);
        rewritten.add(pageUuid);

        // Track the new ids per annotation.
        const owners = [...hlOwners, ...stOwners];
        const byKey = new Map<string, [number, number][]>();
        ids.forEach((id, i) => {
          const k = owners[i];
          if (!k) return;
          (byKey.get(k) ?? byKey.set(k, []).get(k)!).push([id.part1, id.part2]);
        });
        const itemByKey = new Map(managedItems.map((a) => [a.key, a]));
        for (const [k, kids] of byKey) {
          const item = itemByKey.get(k);
          newTracked.push({
            key: k,
            page: pageUuid,
            ids: kids,
            sig: (item && existingSig(item)) || undefined,
            rev: item ? pushFingerprint(item) : undefined,
          });
          writtenItems++;
        }
      }

      // Preserve tracking for pages we didn't rewrite.
      for (const t of tracked) if (!rewritten.has(t.page)) newTracked.push(t);

      if (pageRm.size > 0) {
        log(`push: "${rec.visibleName}" -> ${pageRm.size} page(s) rewritten`);
        await updateDocumentPages(api, rec.docId, pageRm);
        await setRecord(attKey, {
          ...rec,
          pushedItems: newTracked,
          pushedKeys: newTracked.map((p) => p.key),
        });
        summary.pushed += writtenItems;
      }
    } catch (e) {
      log(`push: FAILED "${rec.visibleName}": ${errMsg(e)}`);
      summary.failed++;
      summary.errors.push(`${rec.visibleName}: ${errMsg(e)}`);
    }
    done++;
  }
  progress?.("", 100);
  return summary;
}
