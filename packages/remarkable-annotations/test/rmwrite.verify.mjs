// Round-trip verification for the .rm v6 writer: encode strokes/highlights with
// rmwrite, parse them back with rmlines, and assert the data survives.
//
// Run via `npm run test:annotations` (bundles first).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { parseRmPage } = await import(join(root, ".scaffold/index.mjs"));
const { rebuildPage, splitStructure, blankStructure } = await import(
  join(root, ".scaffold/index.mjs")
);

// Shorthands over rebuildPage.
const encodePageUpdate = (bytes, strokes, highlights, meta) =>
  rebuildPage(bytes, strokes, highlights, new Set(), meta);
const encodeAppend = (...args) => encodePageUpdate(...args).bytes;
const writeItems = (strokes, highlights) => {
  const blank = blankStructure();
  return encodeAppend(blank.structure, strokes, highlights, blank);
};

const mkStroke = (x) => ({
  tool: 17,
  colorIndex: 0,
  thickness: 2,
  pointWidth: 16,
  isHighlighter: false,
  points: [
    { x, y: x },
    { x: x + 1, y: x + 1 },
  ],
});

const approx = (a, b, eps = 1e-3) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// --- pen stroke round-trip ---
{
  const stroke = {
    tool: 17,
    colorIndex: 0,
    thickness: 2,
    pointWidth: 16,
    isHighlighter: false,
    points: [
      { x: -16.3, y: -30.4 },
      { x: 12.5, y: 8.2 },
      { x: 40, y: 100.25 },
    ],
  };
  const bytes = writeItems([stroke], []);
  const page = parseRmPage(bytes);
  assert.equal(page.strokes.length, 1);
  assert.equal(page.highlights.length, 0);
  const s = page.strokes[0];
  assert.equal(s.tool, 17);
  assert.equal(s.colorIndex, 0);
  assert.equal(s.pointWidth, 16);
  assert.equal(s.points.length, 3);
  approx(s.points[0].x, -16.3, 1e-3);
  approx(s.points[0].y, -30.4, 1e-3);
  approx(s.points[2].x, 40);
  approx(s.points[2].y, 100.25);
}

// --- highlighter stroke with rgba ---
{
  const stroke = {
    tool: 18,
    colorIndex: 9,
    thickness: 1,
    pointWidth: 120,
    isHighlighter: true,
    rgba: [255, 235, 60, 255],
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
  };
  const page = parseRmPage(writeItems([stroke], []));
  assert.equal(page.strokes.length, 1);
  const s = page.strokes[0];
  assert.equal(s.tool, 18);
  assert.equal(s.isHighlighter, true);
  assert.equal(s.pointWidth, 120);
  assert.deepEqual(s.rgba, [255, 235, 60, 255]);
}

// --- text highlight (GlyphRange) round-trip ---
{
  const hl = {
    text: "accuracy is due to late-",
    colorIndex: 3,
    rects: [{ x: -731.32, y: 841.88, w: 622.24, h: 32.18 }],
  };
  const page = parseRmPage(writeItems([], [hl]));
  assert.equal(page.highlights.length, 1);
  const h = page.highlights[0];
  assert.equal(h.text, "accuracy is due to late-");
  assert.equal(h.colorIndex, 3);
  assert.equal(h.rects.length, 1);
  approx(h.rects[0].x, -731.32);
  approx(h.rects[0].w, 622.24);
  approx(h.rects[0].h, 32.18);
}

// --- mixed page ---
{
  const page = parseRmPage(
    writeItems(
      [
        {
          tool: 15,
          colorIndex: 7,
          thickness: 2,
          pointWidth: 18,
          isHighlighter: false,
          points: [
            { x: 1, y: 2 },
            { x: 3, y: 4 },
          ],
        },
      ],
      [{ text: "hi", colorIndex: 3, rects: [{ x: 0, y: 0, w: 10, h: 5 }] }],
    ),
  );
  assert.equal(page.strokes.length, 1);
  assert.equal(page.highlights.length, 1);
  assert.equal(page.highlights[0].text, "hi");
}

// --- real fixtures: parse -> re-encode -> re-parse, data preserved ---
for (const name of [
  "Wikipedia_highlighted_p1.rm",
  "Normal_A_stroke_2_layers.rm",
  "More_color_highlight_shader_v3.15.4.2.rm",
]) {
  const orig = parseRmPage(
    new Uint8Array(readFileSync(join(root, "test/fixtures/rm", name))),
  );
  const round = parseRmPage(writeItems(orig.strokes, orig.highlights));
  assert.equal(round.strokes.length, orig.strokes.length, `${name} strokes`);
  assert.equal(
    round.highlights.length,
    orig.highlights.length,
    `${name} highlights`,
  );
  if (orig.highlights.length) {
    assert.equal(round.highlights[0].text, orig.highlights[0].text);
    approx(round.highlights[0].rects[0].x, orig.highlights[0].rects[0].x);
  }
  if (orig.strokes.length) {
    assert.equal(round.strokes[0].points.length, orig.strokes[0].points.length);
    approx(round.strokes[0].points[0].x, orig.strokes[0].points[0].x);
    assert.equal(round.strokes[0].tool, orig.strokes[0].tool);
  }
}

// --- append to a real page: original items preserved + new one added ---
{
  const bytes = new Uint8Array(
    readFileSync(join(root, "test/fixtures/rm", "Normal_A_stroke_2_layers.rm")),
  );
  const orig = parseRmPage(bytes);
  assert.ok(orig.layerId, "fixture should expose a layerId");
  const newStroke = {
    tool: 17,
    colorIndex: 0,
    thickness: 2,
    pointWidth: 16,
    isHighlighter: false,
    points: [
      { x: 5, y: 5 },
      { x: 6, y: 6 },
    ],
  };
  const appended = encodeAppend(bytes, [newStroke], [], {
    layerId: orig.layerId,
    lastItemId: orig.lastItemId,
    author: orig.lastItemId?.part1 ?? orig.maxAuthor,
    startCounter: orig.maxCounter + 1,
  });
  const re = parseRmPage(appended);
  assert.equal(re.strokes.length, orig.strokes.length + 1, "appended stroke");
  approx(re.strokes[0].points[0].x, orig.strokes[0].points[0].x);
}

// --- splitStructure: strip items, keep structure, re-append cleanly ---
{
  const bytes = new Uint8Array(
    readFileSync(
      join(
        root,
        "test/fixtures/rm",
        "More_color_highlight_shader_v3.15.4.2.rm",
      ),
    ),
  );
  const orig = parseRmPage(bytes);
  assert.ok(orig.strokes.length > 0);
  const structure = splitStructure(bytes);
  // Structure alone should parse with no items.
  const blank = parseRmPage(structure);
  assert.equal(blank.strokes.length, 0, "structure has no strokes");
  assert.equal(blank.highlights.length, 0, "structure has no highlights");
  // Appending one item onto the cloned structure yields exactly that item.
  const cloned = parseRmPage(
    encodeAppend(
      structure,
      [
        {
          tool: 17,
          colorIndex: 0,
          thickness: 2,
          pointWidth: 16,
          isHighlighter: false,
          points: [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
          ],
        },
      ],
      [],
      {
        layerId: orig.layerId,
        author: orig.lastItemId?.part1 ?? orig.maxAuthor,
        startCounter: orig.maxCounter + 1,
      },
    ),
  );
  assert.equal(cloned.strokes.length, 1, "cloned page has the new stroke");
}

// --- blankStructure: from-scratch page parses, and items append cleanly ---
{
  const blank = blankStructure();
  const empty = parseRmPage(blank.structure);
  assert.equal(empty.strokes.length, 0);
  assert.equal(empty.highlights.length, 0);
  const page = parseRmPage(
    encodeAppend(
      blank.structure,
      [
        {
          tool: 17,
          colorIndex: 0,
          thickness: 2,
          pointWidth: 16,
          isHighlighter: false,
          points: [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
          ],
        },
      ],
      [{ text: "hi", colorIndex: 3, rects: [{ x: 0, y: 0, w: 5, h: 5 }] }],
      {
        layerId: blank.layerId,
        author: blank.author,
        startCounter: blank.startCounter,
      },
    ),
  );
  assert.equal(page.strokes.length, 1, "blank page accepts a stroke");
  assert.equal(page.highlights.length, 1, "blank page accepts a highlight");
  // Items parent to the generated layer node (0, 11).
  assert.equal(page.layerId.part1, 0);
  assert.equal(page.layerId.part2, 11);
}

// --- rebuildPage: remove an item by id ---
{
  const blank = blankStructure();
  const meta = {
    layerId: blank.layerId,
    author: blank.author,
    startCounter: blank.startCounter,
  };
  const { bytes: withTwo, ids } = encodePageUpdate(
    blank.structure,
    [mkStroke(1), mkStroke(5)],
    [],
    meta,
  );
  assert.equal(parseRmPage(withTwo).strokes.length, 2);
  // Remove the first stroke by id; add nothing.
  const removeIds = new Set([`${ids[0].part1},${ids[0].part2}`]);
  const { bytes: withOne } = rebuildPage(withTwo, [], [], removeIds, {
    ...meta,
    startCounter: blank.startCounter + 10,
  });
  assert.equal(parseRmPage(withOne).strokes.length, 1, "one stroke removed");
  // Remove both.
  const removeBoth = new Set(ids.map((i) => `${i.part1},${i.part2}`));
  const { bytes: none } = rebuildPage(withTwo, [], [], removeBoth, {
    ...meta,
    startCounter: blank.startCounter + 10,
  });
  assert.equal(parseRmPage(none).strokes.length, 0, "both strokes removed");
}

console.log(
  "✓ rmwrite round-trips (synthetic + fixtures + append + clone + blank + rebuild)",
);
