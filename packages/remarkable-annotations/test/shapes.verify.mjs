// Shape recognition (detectShape) on synthetic strokes shaped like the
// reMarkable shape tool's output, and on real freehand strokes from fixtures.
//
// Run via `npm run test:annotations` (bundles first).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { detectShape, parseRmPage } = await import(
  join(root, ".scaffold/index.mjs")
);

const pts = (...xy) => {
  const out = [];
  for (let i = 0; i < xy.length; i += 2) out.push({ x: xy[i], y: xy[i + 1] });
  return out;
};

// Rectangle as the device stores it: closed 5-point polyline.
{
  const s = detectShape(
    pts(500, 900, -100, 900, -100, 780, 500, 780, 500, 900),
  );
  assert.equal(s?.kind, "rectangle");
  assert.deepEqual(s.bbox, { x: -100, y: 780, w: 600, h: 120 });
}

// Rectangle with intermediate points along its edges.
assert.equal(
  detectShape(pts(0, 0, 50, 0, 100, 0, 100, 40, 100, 80, 0, 80, 0, 0))?.kind,
  "rectangle",
);

// Ellipse sampled on its outline, starting anywhere.
const ellipse = (n, jitter = 0) => {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = Math.PI + (2 * Math.PI * i) / n;
    const j = i % 2 ? jitter : -jitter;
    out.push({ x: 370 + (270 + j) * Math.cos(t), y: 420 + 78 * Math.sin(t) });
  }
  return out;
};
{
  const s = detectShape(ellipse(83));
  assert.equal(s?.kind, "ellipse");
  assert.ok(Math.abs(s.bbox.w - 540) < 1 && Math.abs(s.bbox.h - 156) < 1);
}

// Not shapes: wobbly ellipse, open path, line, triangle, rotated square,
// too few ellipse points, tiny box.
assert.equal(detectShape(ellipse(83, 25)), null);
assert.equal(detectShape(ellipse(83).slice(0, 60)), null);
assert.equal(
  detectShape(pts(0, 0, 50, 50, 100, 100, 150, 150, 200, 200)),
  null,
);
assert.equal(detectShape(pts(0, 0, 100, 0, 50, 80, 0, 0, 0, 0)), null);
assert.equal(detectShape(pts(50, 0, 100, 50, 50, 100, 0, 50, 50, 0)), null);
assert.equal(detectShape(ellipse(8)), null);
assert.equal(detectShape(pts(0, 0, 3, 0, 3, 3, 0, 3, 0, 0)), null);

// Real freehand strokes are never recognised.
for (const f of [
  "Normal_A_stroke_2_layers.rm",
  "More_color_highlight_shader_v3.15.4.2.rm",
]) {
  const page = parseRmPage(
    new Uint8Array(readFileSync(join(root, "test/fixtures/rm", f))),
  );
  for (const s of page.strokes) assert.equal(detectShape(s.points), null);
}

console.log("✓ shape recognition (rectangles, ellipses, freehand rejected)");
