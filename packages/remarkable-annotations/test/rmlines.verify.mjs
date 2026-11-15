// Standalone verification for the .rm v6 parser. The parser is pure (no Zotero
// deps), so we bundle it with esbuild and run it in Node against fixtures taken
// from rmscene, asserting the expected strokes/highlights.
//
// Run via `npm run test:annotations` (bundles first). Ground truth was produced with
// rmscene (github.com/ricklupton/rmscene).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { parseRmPage } = await import(join(root, ".scaffold/index.mjs"));

const read = (name) =>
  new Uint8Array(readFileSync(join(root, "test/fixtures/rm", name)));
const approx = (a, b, eps = 1e-3) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// --- highlights (GlyphRange) ---
{
  const p = parseRmPage(read("Wikipedia_highlighted_p1.rm"));
  assert.equal(p.strokes.length, 0);
  assert.equal(p.highlights.length, 4);
  const h = p.highlights[0];
  assert.ok(h.text.startsWith("The reMarkable uses electronic"));
  assert.equal(h.colorIndex, 3);
  assert.equal(h.rects.length, 1);
  approx(h.rects[0].x, -810.1125828475945);
  approx(h.rects[0].y, 663.8742596766097);
  approx(h.rects[0].w, 669.9534087714892);
  approx(h.rects[0].h, 56.30432956921868);
}

// --- pen strokes (SceneLineItem v2) ---
{
  const p = parseRmPage(read("Normal_A_stroke_2_layers.rm"));
  assert.equal(p.highlights.length, 0);
  assert.equal(p.strokes.length, 2);
  for (const s of p.strokes) {
    assert.equal(s.tool, 17);
    assert.equal(s.colorIndex, 0);
    assert.equal(s.points.length, 7);
    assert.equal(s.isHighlighter, false);
  }
  approx(p.strokes[0].points[0].x, -16.3, 0.1);
  approx(p.strokes[0].points[0].y, -30.4, 0.1);
}

// --- freehand highlighter strokes (tool 18, colour index 9) ---
{
  const p = parseRmPage(read("More_color_highlight_shader_v3.15.4.2.rm"));
  assert.equal(p.strokes.length, 23); // mix of highlighter (18) + shader (23)
  assert.equal(p.strokes[0].tool, 18);
  assert.equal(p.strokes[0].colorIndex, 9);
  assert.equal(p.strokes[0].isHighlighter, true);
  assert.ok(p.strokes.every((s) => s.points.length > 0));
}

console.log("✓ rmlines parser matches rmscene ground truth (3 fixtures)");
