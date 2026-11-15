// Pages we write go to the cloud through rmapi-js (putRmPages), which takes a
// parsed scene and serializes it again. Check that this round trip is
// byte-exact for the fixtures and for pages produced by our writer.
//
// Run via `npm run test:scene` (bundles first).

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { parseRmScene, serializeRmScene } = await import(
  join(root, "node_modules/rmapi-js/dist/rm6.js")
);
const { parseRmPage } = await import(join(root, ".scaffold/rmlines.mjs"));
const { rebuildPage, blankStructure } = await import(
  join(root, ".scaffold/rmwrite.mjs")
);

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const roundTrips = (bytes) =>
  same(serializeRmScene(parseRmScene(bytes)), bytes);

const stroke = {
  tool: 17,
  colorIndex: 6,
  thickness: 2,
  pointWidth: 16,
  isHighlighter: false,
  points: [
    { x: 1, y: 2 },
    { x: 30, y: 40 },
  ],
};
// Colour 14 is outside rmapi-js's palette: must still survive the round trip.
const highlights = [3, 14].map((colorIndex) => ({
  text: "some text",
  colorIndex,
  rects: [{ x: -100, y: 50, w: 200, h: 30 }],
}));

let n = 0;
const dir = join(here, "fixtures/rm");
for (const f of readdirSync(dir).filter((x) => x.endsWith(".rm"))) {
  const bytes = new Uint8Array(readFileSync(join(dir, f)));
  let parsed;
  try {
    parsed = parseRmPage(bytes);
  } catch {
    continue; // not v6
  }
  assert.ok(roundTrips(bytes), `${f}: fixture round-trips`);
  if (!parsed.layerId) continue;
  const meta = {
    layerId: parsed.layerId,
    lastItemId: parsed.lastItemId,
    author:
      parsed.lastItemId?.part1 ?? parsed.layerId.part1 ?? parsed.maxAuthor,
    startCounter: parsed.maxCounter + 1,
  };
  const added = rebuildPage(bytes, [stroke], highlights, new Set(), meta);
  assert.ok(roundTrips(added.bytes), `${f}: appended page round-trips`);
  const ids = new Set(added.ids.map((i) => `${i.part1},${i.part2}`));
  const p2 = parseRmPage(added.bytes);
  const removed = rebuildPage(added.bytes, [], [], ids, {
    layerId: p2.layerId,
    lastItemId: p2.lastItemId,
    author: p2.lastItemId?.part1 ?? p2.maxAuthor,
    startCounter: p2.maxCounter + 1,
  });
  assert.ok(roundTrips(removed.bytes), `${f}: page with removals round-trips`);
  n++;
}

const blank = blankStructure();
const fresh = rebuildPage(blank.structure, [stroke], highlights, new Set(), {
  layerId: blank.layerId,
  author: blank.author,
  startCounter: blank.startCounter,
});
assert.ok(
  roundTrips(fresh.bytes),
  "page built from the blank structure round-trips",
);

console.log(
  `rmscene: ${n} fixture page(s) + blank page round-trip through rmapi-js`,
);
