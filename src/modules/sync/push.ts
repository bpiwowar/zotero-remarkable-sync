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
import { HashNotFoundError } from "rmapi-js";
import type { DocumentContent, ItemRef, RemarkableApi } from "rmapi-js";
import * as client from "../remarkable/client";
import {
  mapPdfPages,
  pdfIndexByPageId,
  type PageRef,
} from "remarkable-annotations";
import { parseRmPage } from "remarkable-annotations";
import type { RmStroke, RmHighlight, CrdtId } from "remarkable-annotations";
import {
  rebuildPage,
  splitStructure,
  blankStructure,
} from "remarkable-annotations";
import { zoteroToRm } from "../remarkable/colors";
import {
  readPdfPageSizes,
  pageSizeAt,
  pdfRectToRm,
  pdfPathToRm,
  pdfWidthToRm,
  type PdfPageSize,
} from "remarkable-annotations";
import {
  allRecords,
  setRecord,
  type PushedItem,
  type SyncRecord,
} from "./state";
import { existingSig, pushFingerprint } from "./annotations";
import { keyToUuid, keyedAuthors, MAX_AUTHOR } from "../remarkable/zkey";
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
        rects: [pdfRectToRm(r as [number, number, number, number], size)],
      });
    });
  } else if (type === "ink") {
    const width = pdfWidthToRm(pos.width ?? 1);
    for (const path of pos.paths ?? []) {
      const points = pdfPathToRm(path, size);
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

/**
 * Remove from the device the page tags the user removed in Zotero. Returns the
 * document's new ref (unchanged if nothing was removed).
 */
async function pushPageTagRemovals(
  api: RemarkableApi,
  ref: ItemRef,
  att: Zotero.Item,
  attKey: string,
  rec: SyncRecord,
): Promise<ItemRef> {
  const removed = removedPageTags(att, rec);
  if (removed.size === 0) return ref;
  const content = (await api.getContent(ref)) as DocumentContent;
  const indexOf = pdfIndexByPageId(content);
  const before = content.pageTags ?? [];
  const after = before.filter((t) => {
    const pi = indexOf.get(t.pageId);
    return !(pi !== undefined && removed.get(pi)?.has(t.name?.trim()));
  });
  if (after.length < before.length) {
    ref = await api.updateDocument(ref, { pageTags: after });
  }
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
  return ref;
}

/**
 * Pulled annotations the user deleted in Zotero, with the device item ids to
 * remove ("part1,part2") grouped by reMarkable page uuid.
 */
function deletedPulled(
  rec: SyncRecord,
  libraryID: number,
): { keys: string[]; byPage: Map<string, string[]> } {
  const keys: string[] = [];
  const byPage = new Map<string, string[]>();
  for (const key of rec.annotationKeys ?? []) {
    const src = rec.annotationSources?.[key];
    if (!src) continue;
    const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
    if (item && !(item as Zotero.Item).deleted) continue;
    keys.push(key);
    const ids = byPage.get(src.page) ?? byPage.set(src.page, []).get(src.page)!;
    for (const [p1, p2] of src.ids) ids.push(`${p1},${p2}`);
  }
  return { keys, byPage };
}

interface Template {
  structure: Uint8Array;
  layerId: CrdtId;
  author: number;
  startCounter: number;
  authors: Map<number, string>;
}

/**
 * The author of each item written for `owners` (Zotero annotation keys): the
 * page author whose uuid encodes the key, registered if new. Falls back to
 * `fallback` when the key can't be encoded or the page has no free author id.
 */
function authorsFor(
  owners: string[],
  table: Map<number, string>,
  maxAuthor: number,
  fallback: number,
): { authors: number[]; register: Map<number, string>; keyed: Set<string> } {
  const byUuid = new Map([...table].map(([a, u]) => [u, a]));
  const register = new Map<number, string>();
  const keyed = new Set<string>();
  let next = Math.max(maxAuthor, fallback, ...table.keys()) + 1;
  const authors = owners.map((key) => {
    const uuid = keyToUuid(key);
    if (!uuid) return fallback;
    let a = byUuid.get(uuid);
    if (a === undefined) {
      if (next > MAX_AUTHOR) return fallback;
      a = next++;
      byUuid.set(uuid, a);
      register.set(a, uuid);
    }
    keyed.add(key);
    return a;
  });
  return { authors, register, keyed };
}

/** Shape of a stroke or highlight, to spot exact copies on a page. */
function itemShape(it: RmStroke | RmHighlight): string {
  const r = (v: number) => Math.round(v * 100);
  if ("rects" in it) {
    const rects = it.rects.map((q) => [q.x, q.y, q.w, q.h].map(r).join(","));
    return `h|${it.colorIndex}|${it.text}|${rects.join(";")}`;
  }
  const pts = it.points.map((q) => `${r(q.x)},${r(q.y)}`).join(";");
  return `s|${it.tool}|${it.colorIndex}|${pts}`;
}

/** Find any page that has a `.rm` and turn it into a structural template. */
async function loadTemplate(
  api: RemarkableApi,
  pageMap: Map<number, PageRef>,
): Promise<Template | null> {
  for (const ref of pageMap.values()) {
    if (!ref.rmEntry) continue;
    try {
      const bytes = await api.raw.getHash(ref.rmEntry);
      const parsed = parseRmPage(bytes);
      if (parsed.layerId) {
        return {
          structure: splitStructure(bytes),
          layerId: parsed.layerId,
          author: parsed.lastItemId?.part1 ?? parsed.maxAuthor,
          startCounter: parsed.maxCounter + 1,
          authors: parsed.authors,
        };
      }
    } catch {
      // try the next page
    }
  }
  return null;
}

/**
 * Push Zotero-origin annotations for every synced attachment. With `force`,
 * pages are rewritten even when nothing changed since the last push, so every
 * pushed annotation is regenerated (e.g. after a geometry fix).
 */
export async function pushAnnotations(
  progress?: ProgressFn,
  opts: { onlyKeys?: Set<string>; force?: boolean } = {},
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

      // A document found on the device by its PDF hash, with no shared record,
      // is pulled first: until then, annotations another computer pulled from
      // it can't be told from the user's own.
      if (rec.adopted) {
        log(`push: skip "${rec.visibleName}" (adopted, not pulled yet)`);
        done++;
        continue;
      }

      let ref: ItemRef = { id: rec.docId, hash: entry.hash };
      ref = await pushPageTagRemovals(
        api,
        ref,
        att as Zotero.Item,
        attKey,
        rec,
      );

      const pulled = new Set(rec.annotationKeys ?? []);
      const tracked = rec.pushedItems ?? [];
      const unpulled = deletedPulled(rec, libraryID);

      // Zotero-origin annotations we manage (current set).
      const managed = (att as Zotero.Item)
        .getAnnotations()
        .filter((a) => PUSHABLE.has(a.annotationType) && !pulled.has(a.key));
      if (
        managed.length === 0 &&
        tracked.length === 0 &&
        unpulled.byPage.size === 0
      ) {
        done++;
        continue;
      }

      progress?.(`Pushing annotations: ${rec.visibleName}`, pct);
      const path = await (att as Zotero.Item).getFilePathAsync();
      const pdfBytes: Uint8Array = path
        ? await IO.IOUtils.read(path)
        : new Uint8Array();
      const sizes = readPdfPageSizes(pdfBytes);
      const pageMap = await mapPdfPages(api, ref.id, ref.hash);
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
        {
          ids: CrdtId[];
          keys: Set<string>;
          revs: Map<string, string>;
          legacy: boolean;
        }
      >();
      for (const t of tracked) {
        const e =
          trackedByPage.get(t.page) ??
          trackedByPage
            .set(t.page, {
              ids: [],
              keys: new Set(),
              revs: new Map(),
              legacy: false,
            })
            .get(t.page)!;
        for (const [p1, p2] of t.ids) e.ids.push({ part1: p1, part2: p2 });
        e.keys.add(t.key);
        if (t.rev) e.revs.set(t.key, t.rev);
        // Written before items had their own author: rewrite it once.
        if (t.keyed === undefined) e.legacy = true;
      }

      const pageUuids = new Set<string>([
        ...managedByPage.keys(),
        ...trackedByPage.keys(),
        ...unpulled.byPage.keys(),
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
          legacy: false,
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
        const deletedHere = unpulled.byPage.get(pageUuid) ?? [];
        if (!opts.force && sameSet && !here.legacy && deletedHere.length === 0)
          continue;

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

        const owners = [...hlOwners, ...stOwners];
        let bytes: Uint8Array;
        let ids: CrdtId[];
        let keyed: Set<string>;
        if (found?.ref.rmEntry) {
          const existing = await api.raw.getHash(found.ref.rmEntry);
          const parsed = parseRmPage(existing);
          if (!parsed.layerId) continue;
          // Besides what this computer wrote, drop the items any computer wrote
          // for these annotations (under their own author).
          const rewrite = new Set([...managedKeys, ...here.keys]);
          const byAuthor = keyedAuthors(parsed.authors);
          const written: string[] = [];
          for (const it of [...parsed.strokes, ...parsed.highlights])
            for (const i of it.ids ?? [])
              if (rewrite.has(byAuthor.get(i.part1) ?? ""))
                written.push(`${i.part1},${i.part2}`);
          // Exact copies of what we write, under another author: leftovers of
          // a push whose tracking was lost (a reset, or a note version lost
          // in a Zotero conflict). Same shape, colour and text to 1/100 unit:
          // a hand-drawn item never matches that closely.
          const ours = new Set([
            ...highlights.map(itemShape),
            ...strokes.map(itemShape),
          ]);
          for (const it of [...parsed.strokes, ...parsed.highlights]) {
            const id = it.ids?.[0];
            if (id && !byAuthor.has(id.part1) && ours.has(itemShape(it)))
              written.push(`${id.part1},${id.part2}`);
          }
          const removeIds = new Set([
            ...here.ids.map((id) => `${id.part1},${id.part2}`),
            ...deletedHere,
            ...written,
          ]);
          const fallback =
            parsed.lastItemId?.part1 ??
            parsed.layerId.part1 ??
            parsed.maxAuthor;
          const who = authorsFor(
            owners,
            parsed.authors,
            parsed.maxAuthor,
            fallback,
          );
          keyed = who.keyed;
          ({ bytes, ids } = rebuildPage(
            existing,
            strokes,
            highlights,
            removeIds,
            {
              layerId: parsed.layerId,
              lastItemId: parsed.lastItemId,
              author: fallback,
              startCounter: parsed.maxCounter + 1,
              authors: who.authors,
              register: who.register,
            },
          ));
        } else {
          if (managedItems.length === 0) continue; // deletion on a vanished page
          if (template === undefined) {
            template = (await loadTemplate(api, pageMap)) ?? blankStructure();
          }
          if (!template) continue;
          const who = authorsFor(
            owners,
            template.authors,
            template.author,
            template.author,
          );
          keyed = who.keyed;
          ({ bytes, ids } = rebuildPage(
            template.structure,
            strokes,
            highlights,
            new Set(),
            {
              layerId: template.layerId,
              author: template.author,
              startCounter: template.startCounter,
              authors: who.authors,
              register: who.register,
            },
          ));
        }
        pageRm.set(pageUuid, bytes);
        rewritten.add(pageUuid);

        // Track the new ids per annotation.
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
            keyed: keyed.has(k),
          });
          writtenItems++;
        }
      }

      // Preserve tracking for pages we didn't rewrite.
      for (const t of tracked) if (!rewritten.has(t.page)) newTracked.push(t);

      if (pageRm.size > 0) {
        log(`push: "${rec.visibleName}" -> ${pageRm.size} page(s) rewritten`);
        ref = await client.putPages(api, ref, pageRm);
        // Pulled annotations deleted on rewritten pages are gone from the
        // device too: stop tracking them.
        const gone = new Set(
          unpulled.keys.filter((k) =>
            rewritten.has(rec.annotationSources![k].page),
          ),
        );
        if (gone.size) {
          log(
            `push: "${rec.visibleName}" removed ${gone.size} annotation(s) ` +
              `deleted in Zotero from the device`,
          );
        }
        const drop = <T>(m: Record<string, T> | undefined) =>
          m &&
          Object.fromEntries(Object.entries(m).filter(([k]) => !gone.has(k)));
        await setRecord(attKey, {
          ...rec,
          annotationKeys: rec.annotationKeys?.filter((k) => !gone.has(k)),
          annotationSigs: drop(rec.annotationSigs),
          annotationSources: drop(rec.annotationSources),
          pushedItems: newTracked,
          pushedKeys: newTracked.map((p) => p.key),
        });
        summary.pushed += writtenItems;
      }
    } catch (e) {
      if (e instanceof HashNotFoundError) {
        // The document changed on the cloud since we read it (e.g. new ink on
        // the tablet, or not listed yet after an upload): nothing was written.
        // The next sync pulls first, then pushes again.
        log(`push: "${rec.visibleName}" changed meanwhile, retry next sync`);
        summary.skipped++;
        done++;
        continue;
      }
      log(`push: FAILED "${rec.visibleName}": ${errMsg(e)}`);
      summary.failed++;
      summary.errors.push(`${rec.visibleName}: ${errMsg(e)}`);
    }
    done++;
  }
  progress?.("", 100);
  return summary;
}
