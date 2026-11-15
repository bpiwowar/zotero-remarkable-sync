// Verifies PDF page-size extraction (geometry.readPdfPageSizes) on synthetic
// PDFs: page dictionaries hidden in a compressed object stream, inherited and
// indirect MediaBox, CropBox with a non-zero origin. Run via
// `npm run test:annotations` (bundles first).

import assert from "node:assert/strict";
import { zlibSync } from "fflate";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { readPdfPageSizes, rmToPdf, pdfToRm } = await import(
  join(here, "..", ".scaffold/index.mjs")
);

const enc = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

// 1. Pages tree inside a FlateDecode object stream (PDF 1.5 style).
{
  const objs = [
    [
      2,
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 594 756] >>",
    ],
    [3, "<< /Type /Page /Parent 2 0 R >>"],
    [4, "<< /Type /Page /Parent 2 0 R /MediaBox 5 0 R >>"],
    [5, "[0 0 400 300]"],
  ];
  let header = "";
  let body = "";
  for (const [n, t] of objs) {
    header += `${n} ${body.length} `;
    body += t + "\n";
  }
  const first = header.length;
  const data = zlibSync(enc(header + body));
  const pdf = cat(
    enc("%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    enc(
      `6 0 obj\n<< /Type /ObjStm /N ${objs.length} /First ${first} ` +
        `/Filter /FlateDecode /Length ${data.length} >>\nstream\n`,
    ),
    data,
    enc("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"),
  );
  const sizes = readPdfPageSizes(pdf);
  assert.equal(sizes.length, 2);
  assert.deepEqual(sizes[0], { x0: 0, y0: 0, width: 594, height: 756 });
  assert.deepEqual(sizes[1], { x0: 0, y0: 0, width: 400, height: 300 });
}

// 2. Plain objects, CropBox with an offset origin, kids out of file order.
{
  const pdf = enc(
    "%PDF-1.4\n" +
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n" +
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n" +
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/CropBox [10 20 510 720] >>\nendobj\n" +
      "trailer\n<< /Root 1 0 R >>\n%%EOF\n",
  );
  const sizes = readPdfPageSizes(pdf);
  assert.deepEqual(sizes[0], { x0: 10, y0: 20, width: 500, height: 700 });
  assert.deepEqual(sizes[1], { x0: 0, y0: 0, width: 100, height: 100 });
  // rM origin = top centre of the visible box.
  assert.deepEqual(rmToPdf(0, 0, sizes[0]), [260, 720]);
  const [x, y] = pdfToRm(123, 456, sizes[0]);
  const [bx, by] = rmToPdf(x, y, sizes[0]);
  assert.ok(Math.abs(bx - 123) < 1e-9 && Math.abs(by - 456) < 1e-9);
}

// 3. Unreadable input falls back to US Letter.
assert.deepEqual(readPdfPageSizes(enc("not a pdf")), [
  { width: 612, height: 792 },
]);

console.log("pdfpages: all checks passed");
