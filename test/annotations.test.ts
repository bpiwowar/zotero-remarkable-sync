import { assert } from "chai";
import { config } from "../package.json";

// The annotation library (WebAssembly), as loaded by the plugin at startup.
function lib() {
  return (Zotero as any)[config.addonInstance].api.annotations;
}

describe("annotation library", function () {
  it("writes and reads back a page", function () {
    try {
      writeAndRead();
    } catch (e: any) {
      assert.fail(`${e}\n${e?.stack}`);
    }
  });

  function writeAndRead() {
    const a = lib();
    const blank = a.blankStructure(1);
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
    const highlight = {
      text: "naïve ✓",
      colorIndex: 14,
      rects: [{ x: -100, y: 50, w: 200, h: 30 }],
    };
    const { bytes, ids } = a.rebuildPage(
      blank.structure,
      [stroke],
      [highlight],
      new Set(),
      {
        layerId: blank.layerId,
        author: blank.author,
        startCounter: blank.startCounter,
      },
    );
    assert.deepEqual(ids, [
      { part1: 1, part2: 20 },
      { part1: 1, part2: 21 },
    ]);
    const page = a.parseRmPage(bytes);
    assert.equal(page.strokes.length, 1);
    assert.deepEqual(page.strokes[0].points, stroke.points);
    assert.equal(page.highlights[0].text, highlight.text);
    assert.equal(page.highlights[0].colorIndex, 14);
    assert.deepEqual(page.layerId, { part1: 0, part2: 11 });
    // Removing the highlight
    const removed = a.rebuildPage(bytes, [], [], new Set(["1,20"]), {
      layerId: blank.layerId,
      author: blank.author,
      startCounter: 22,
    });
    // A structure passed as meta (its author table is not per-item authors)
    assert.equal(
      a.rebuildPage(blank.structure, [stroke], [], new Set(), blank).ids.length,
      1,
    );
    assert.equal(a.parseRmPage(removed.bytes).highlights.length, 0);
  }

  it("reads PDF page sizes and converts coordinates", function () {
    const a = lib();
    const pdf = new TextEncoder().encode(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
        "3 0 obj\n<< /Type /Page /MediaBox [0 0 612 792] /CropBox [10 20 510 720] >>\nendobj\n" +
        "trailer\n<< /Root 1 0 R >>\n%%EOF\n",
    );
    const sizes = a.readPdfPageSizes(pdf);
    assert.deepEqual(sizes, [{ width: 500, height: 700, x0: 10, y0: 20 }]);
    assert.deepEqual(
      a.rmRectToPdf({ x: 0, y: 0, w: 0, h: 0 }, sizes[0]),
      [260, 720, 260, 720],
    );
    assert.equal(a.inkWidth(16), 1.51);
    assert.isNull(a.detectShape([{ x: 0, y: 0 }]));
  });
});
