// Live round-trip test of the plugin's reMarkable layer against the cloud,
// using rmapi-js v14. Reads one real document (read-only), and does every write
// on documents it creates in the "zotrem-dev" folder.
//
// Usage: RM_DEVICE_TOKEN=... RM_SOURCE="<title prefix>" npm run devtest
// The source should have ink on page 1. Nothing outside "zotrem-dev" is
// modified; the copy made there is left for checking on the tablet.

import "../src/utils/polyfills";

// Minimal stand-ins for the Zotero globals the modules touch.
(globalThis as any).Zotero = {
  debug: (line: string) => {
    if (process.env.RM_DEBUG) console.error(line);
  },
  Promise: { delay: (ms: number) => new Promise((r) => setTimeout(r, ms)) },
};
import { remarkable, HashNotFoundError } from "rmapi-js";
import {
  parseRmScene,
  serializeRmScene,
} from "../src/modules/remarkable/rmscene";
import type { RemarkableApi, ItemRef } from "rmapi-js";
import * as client from "../src/modules/remarkable/client";
import { fetchAnnotations, mapPdfPages } from "../src/modules/remarkable/rmdoc";
import { parseRmPage } from "../src/modules/remarkable/rmlines";
import { rebuildPage } from "../src/modules/remarkable/rmwrite";

const DEV = "zotrem-dev";
let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures++;
}

async function docRef(api: RemarkableApi, id: string): Promise<ItemRef> {
  const e = (await api.listItems(true)).find((x) => x.id === id);
  if (!e) throw new Error(`document ${id} not listed`);
  return e;
}

async function main() {
  const token = process.env.RM_DEVICE_TOKEN;
  const source = process.env.RM_SOURCE;
  if (!token || !source) throw new Error("set RM_DEVICE_TOKEN and RM_SOURCE");
  const api = await remarkable(token);

  // --- 1. Read the real document (read-only) ---------------------------------
  const items = await api.listItems(true);
  const want = source.toLowerCase();
  const docs = items.filter((e) => e.type === "DocumentType");
  const src = docs.find((e) => e.visibleName.toLowerCase().includes(want));
  if (!src) {
    const words = want.split(/\s+/).filter((w) => w.length > 4);
    const near = docs
      .filter((e) => words.some((w) => e.visibleName.toLowerCase().includes(w)))
      .map((e) => `  - ${e.visibleName}`);
    throw new Error(
      `no document matching "${source}"; close:\n${near.join("\n")}`,
    );
  }
  console.log(`source: "${src.visibleName}"`);

  const ann = await fetchAnnotations(api, src.id, src.hash);
  const strokes = ann.pages.reduce((n, p) => n + p.page.strokes.length, 0);
  const hls = ann.pages.reduce((n, p) => n + p.page.highlights.length, 0);
  console.log(
    `  ${ann.pages.length} annotated page(s), ${strokes} stroke(s), ` +
      `${hls} highlight(s), ${ann.pageTags.length} tagged page(s)`,
  );
  check(ann.pages.length > 0, "source has annotated pages");
  check(
    ann.pages.every((p) => p.page.strokes.concat().every((s) => s.ids?.length)),
    "every stroke carries its item id",
  );

  // Every page parses fully (no item left as an opaque block, e.g. for an
  // unknown colour code) and re-serializes byte for byte.
  const { entries } = await api.raw.getEntries({ id: src.id, hash: src.hash });
  let pagesRead = 0;
  let opaque = 0;
  let roundTrips = 0;
  for (const e of entries.filter((x) => x.id.endsWith(".rm"))) {
    const bytes = await api.raw.getHash(e);
    let scene;
    try {
      scene = parseRmScene(bytes);
    } catch {
      continue; // not v6
    }
    pagesRead++;
    opaque += scene.blocks.filter(
      (b) => b.type === "unknown" && [0x03, 0x05].includes(b.blockType),
    ).length;
    const again = serializeRmScene(scene);
    if (again.length === bytes.length && again.every((b, i) => b === bytes[i]))
      roundTrips++;
  }
  check(
    opaque === 0,
    `every item parsed on ${pagesRead} page(s) (${opaque} opaque)`,
  );
  check(
    roundTrips === pagesRead,
    `round-trips ${roundTrips}/${pagesRead} page(s) byte for byte`,
  );

  // --- 2. Copy it into the dev folder ------------------------------------------
  const folderId = await client.ensureFolder(api, DEV);
  const archive = await api.getDocumentArchive(src);
  const copy = await api.putDocumentArchive(archive, {
    parent: folderId,
    visibleName: `devtest copy ${new Date().toISOString().slice(0, 16)}`,
    refresh: true,
  });
  console.log(`copy: ${copy.id}`);
  let ref = await docRef(api, copy.id);
  const before = await fetchAnnotations(api, ref.id, ref.hash);
  const count = (a: typeof before) => ({
    s: a.pages.reduce((n, p) => n + p.page.strokes.length, 0),
    h: a.pages.reduce((n, p) => n + p.page.highlights.length, 0),
  });
  const c0 = count(before);
  check(
    c0.s === strokes && c0.h === hls,
    `copy has the same annotations (${c0.s}/${c0.h})`,
  );

  // --- 3. Append a stroke + highlight to page 1, then remove them ---------------
  const pageMap = await mapPdfPages(api, ref.id, ref.hash);
  const p0 = pageMap.get(0)!;
  const existing = p0.rmEntry ? await api.raw.getHash(p0.rmEntry) : null;
  if (!existing)
    throw new Error(
      "page 1 of the copy has no .rm; pick a document with ink on page 1",
    );
  const parsed = parseRmPage(existing);
  const meta = {
    layerId: parsed.layerId!,
    lastItemId: parsed.lastItemId,
    author:
      parsed.lastItemId?.part1 ?? parsed.layerId!.part1 ?? parsed.maxAuthor,
    startCounter: parsed.maxCounter + 1,
  };
  const stroke = {
    tool: 17,
    colorIndex: 6,
    thickness: 2,
    pointWidth: 16,
    isHighlighter: false,
    points: Array.from({ length: 30 }, (_, i) => ({
      x: -300 + i * 20,
      y: 200 + (i % 2) * 15,
    })),
  };
  const highlight = {
    text: "devtest highlight",
    colorIndex: 3,
    rects: [{ x: -300, y: 260, w: 600, h: 40 }],
  };
  const added = rebuildPage(existing, [stroke], [highlight], new Set(), meta);
  const stale = ref;
  ref = await client.putPages(api, ref, new Map([[p0.pageUuid, added.bytes]]));
  const c1 = count(await fetchAnnotations(api, ref.id, ref.hash));
  check(
    c1.s === c0.s + 1 && c1.h === c0.h + 1,
    `append: +1 stroke +1 highlight (${c1.s}/${c1.h})`,
  );
  check(
    parseRmScene(added.bytes).strokes().length === parsed.strokes.length + 1,
    "rmapi-js parses our written page",
  );

  const ids = new Set(added.ids.map((i) => `${i.part1},${i.part2}`));
  const pm2 = await mapPdfPages(api, ref.id, ref.hash);
  const cur = await api.raw.getHash(pm2.get(0)!.rmEntry!);
  const p2 = parseRmPage(cur);
  const removed = rebuildPage(cur, [], [], ids, {
    layerId: p2.layerId!,
    lastItemId: p2.lastItemId,
    author: p2.lastItemId?.part1 ?? p2.maxAuthor,
    startCounter: p2.maxCounter + 1,
  });
  ref = await client.putPages(
    api,
    ref,
    new Map([[p0.pageUuid, removed.bytes]]),
  );
  const c2 = count(await fetchAnnotations(api, ref.id, ref.hash));
  check(
    c2.s === c0.s && c2.h === c0.h,
    `remove by id: back to ${c2.s}/${c2.h}`,
  );

  // Leave one visible stroke for a check on the tablet.
  const pm3 = await mapPdfPages(api, ref.id, ref.hash);
  const cur3 = await api.raw.getHash(pm3.get(0)!.rmEntry!);
  const p3 = parseRmPage(cur3);
  const left = rebuildPage(cur3, [stroke], [], new Set(), {
    layerId: p3.layerId!,
    lastItemId: p3.lastItemId,
    author: p3.lastItemId?.part1 ?? p3.maxAuthor,
    startCounter: p3.maxCounter + 1,
  });
  ref = await client.putPages(api, ref, new Map([[p0.pageUuid, left.bytes]]));

  // A write based on an outdated read must be refused, not clobber newer ink.
  let refused = false;
  try {
    await client.putPages(api, stale, new Map([[p0.pageUuid, added.bytes]]));
  } catch (e) {
    refused = e instanceof HashNotFoundError;
  }
  check(refused, "a write from a stale read is refused");

  // --- 4. Page tags via .content edit -----------------------------------------
  const pageId = p0.pageUuid;
  const tags0 = ((await api.getContent(ref)) as any).pageTags ?? [];
  ref = await api.updateDocument(ref, {
    pageTags: [
      ...tags0,
      { name: "devtest-a", pageId, timestamp: Date.now() },
      { name: "devtest-b", pageId, timestamp: Date.now() },
    ],
  });
  let t = (await fetchAnnotations(api, ref.id, ref.hash)).pageTags.find(
    (x) => x.pdfPageIndex === 0,
  );
  check(
    !!t && t.names.includes("devtest-a") && t.names.includes("devtest-b"),
    "page tags added",
  );
  const tags1 = ((await api.getContent(ref)) as any).pageTags ?? [];
  ref = await api.updateDocument(ref, {
    pageTags: tags1.filter((x: any) => x.name !== "devtest-a"),
  });
  t = (await fetchAnnotations(api, ref.id, ref.hash)).pageTags.find(
    (x) => x.pdfPageIndex === 0,
  );
  check(
    !!t && !t.names.includes("devtest-a") && t.names.includes("devtest-b"),
    "page tag removed, other kept",
  );

  // --- 5. Fresh upload with page list + page tags, then trash and purge ---------
  const pdf = await api.getPdf(src);
  const pages = (await api.getContent(src)) as any;
  const pageCount = (pages.cPages?.pages?.length ??
    pages.pages?.length) as number;
  const up = await client.uploadPdf(api, "devtest upload", pdf, folderId, {
    pageCount,
    pageTags: { "1": ["devtest-up"] },
  });
  check(
    up.hash === (await docRef(api, up.id)).hash,
    "upload returns the current hash",
  );
  const upRef = up;
  const upMap = await mapPdfPages(api, upRef.id, upRef.hash);
  check(upMap.size === pageCount, `upload lists all ${pageCount} pages`);
  const upTags = (await fetchAnnotations(api, upRef.id, upRef.hash)).pageTags;
  check(
    upTags.some((x) => x.pdfPageIndex === 1 && x.names.includes("devtest-up")),
    "upload carries page tags",
  );
  await client.trashDoc(api, upRef);
  const trashed = (await api.listItems(true)).find((x) => x.id === up.id);
  check(trashed?.parent === "trash", "trashDoc moves to the trash");
  await client.purgeDoc(api, trashed!);
  check(
    !(await api.listItems(true)).some((x) => x.id === up.id),
    "purgeDoc removes it",
  );

  console.log(
    `\nLeft in "${DEV}": "${((await docRef(api, copy.id)) as any).visibleName}" ` +
      `(page 1: one extra red zigzag stroke, page tag "devtest-b").`,
  );
  console.log(
    failures ? `\n${failures} check(s) FAILED` : "\nall checks passed",
  );
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("ERROR:", e?.stack ?? e);
  process.exit(2);
});
