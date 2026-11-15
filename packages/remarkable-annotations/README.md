# remarkable-annotations

Read and write the annotations of reMarkable documents (pen strokes and text
highlights on PDF pages), on top of
[rmapi-js](https://github.com/erikbrinkman/rmapi-js). It has no Zotero
dependency. The Zotero plugin in this repository is its only user so far.

The package is private and consumed as TypeScript source through the npm
workspace (see [Publishing](#publishing)).

## Modules

| Module                           | What it does                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [`rmlines.ts`](src/rmlines.ts)   | `parseRmPage`: a `.rm` v6 page as strokes, highlights, and the ids needed to append items.                              |
| [`rmwrite.ts`](src/rmwrite.ts)   | `rebuildPage`: removes items by id and appends new ones. `splitStructure`, `blankStructure`: templates for empty pages. |
| [`rmscene.ts`](src/rmscene.ts)   | rmapi-js's scene parser and serializer, with a patch for codes it rejects.                                              |
| [`rmdoc.ts`](src/rmdoc.ts)       | `fetchAnnotations`, `mapPdfPages`, `pdfIndexByPageId`: a document's pages, mapped to PDF pages.                         |
| [`document.ts`](src/document.ts) | `ensureFolder`, `uploadPdf`, `putPages`: folders by path, uploads with the full page list, page writes in one commit.   |
| [`geometry.ts`](src/geometry.ts) | reMarkable coordinates ↔ PDF points, pen widths, page sizes.                                                            |
| [`pdfpages.ts`](src/pdfpages.ts) | Reads each page's MediaBox/CropBox from a PDF, including compressed object streams.                                     |

Everything is re-exported from [`index.ts`](src/index.ts).

## Example

```ts
import { remarkable } from "rmapi-js";
import {
  fetchAnnotations,
  mapPdfPages,
  parseRmPage,
  rebuildPage,
  putPages,
  readPdfPageSizes,
  pageSizeAt,
  strokeToPath,
} from "remarkable-annotations";

const api = await remarkable(deviceToken);
const doc = (await api.listItems()).find((e) => e.visibleName === "Paper")!;

// Read: strokes in PDF points, per PDF page.
const sizes = readPdfPageSizes(await api.getPdf(doc));
const { pages } = await fetchAnnotations(api, doc.id, doc.hash);
for (const { pdfPageIndex, page } of pages)
  for (const s of page.strokes)
    console.log(
      pdfPageIndex,
      strokeToPath(s.points, pageSizeAt(sizes, pdfPageIndex)),
    );

// Write: append a red fineliner stroke to the first page's existing `.rm`.
const stroke = {
  tool: 17, // fineliner
  colorIndex: 7, // red
  thickness: 2,
  pointWidth: 16,
  isHighlighter: false,
  points: [
    { x: -200, y: 300 },
    { x: 200, y: 300 },
  ],
};
const { pageUuid, rmEntry } = (await mapPdfPages(api, doc.id, doc.hash)).get(
  0,
)!;
const bytes = await api.raw.getHash(rmEntry!);
const p = parseRmPage(bytes);
const { bytes: out } = rebuildPage(bytes, [stroke], [], new Set(), {
  layerId: p.layerId!,
  lastItemId: p.lastItemId,
  author: p.maxAuthor,
  startCounter: p.maxCounter + 1,
});
await putPages(api, doc, new Map([[pageUuid, out]]));
```

## Pages and PDF pages

[`fetchAnnotations`](src/rmdoc.ts) does the following:

- it reads the document's `.content` to get the page order and the
  `redirectionPageMap`, which maps reMarkable pages to PDF pages
  ([`pdfIndexByPageId`](src/rmdoc.ts));
- it parses each page's `.rm` (v6) file, skipping pages without one;
- it groups the page tags (the tablet's tag-a-page feature) by PDF page.

[`mapPdfPages`](src/rmdoc.ts) gives, for each PDF page, the page uuid and its
`.rm` entry, if any, for writing.

## Reading and writing pages

Pages are parsed and serialized by rmapi-js's scene model
([`rmscene.ts`](src/rmscene.ts)), which keeps every block it doesn't change
byte for byte. [`parseRmPage`](src/rmlines.ts) maps its blocks to strokes
(line items) and highlights (glyph ranges). Each comes with its scene item ids,
so a caller can remove it later.

[`rebuildPage`](src/rmwrite.ts) drops the items whose id is in `removeIds`,
keeps every other block as is, then appends the new items (highlights first)
after the layer's last item. It returns the ids it assigned.

A page without a `.rm` file gets one from a template:
[`splitStructure`](src/rmwrite.ts) clones another page's structure without its
items, and [`blankStructure`](src/rmwrite.ts) builds one from scratch.

### Rules the tablet enforces

These were checked on a real tablet:

- **Counters:** new items must use counters above every counter on the page,
  whatever their author (`maxCounter` covers tombstones and groups too). The
  tablet drops the others when it loads the page.
- **Authors:** item ids are `(author, counter)`, and the author is a byte, so a
  page holds at most 255 authors. Authors added to the page's `authorIds` table
  (`meta.register`) survive tablet saves. An erased item leaves a tombstone that
  keeps its author id.
- **Per-item authors:** `meta.authors` sets the author of each added item. The
  plugin uses this to tag each item with the annotation it mirrors (an author
  uuid encoding the Zotero key).

### Unknown colour and pen codes

rmapi-js rejects colour and pen codes outside its lists, and then keeps the
whole item as an opaque block: the tablet's highlights in colours 14 and 15
would be invisible. [`rmscene.ts`](src/rmscene.ts) accepts any code. The colour
fix is in rmapi-js 14.4.1
([#140](https://github.com/erikbrinkman/rmapi-js/pull/140)), the pen fix is
proposed in [#141](https://github.com/erikbrinkman/rmapi-js/pull/141). Once it
is released, the patch can go.

## Uploading with the real page list

[`uploadPdf`](src/document.ts) uploads with rmapi-js's `putPdf`, then replaces
its `.content` page list with one page uuid per PDF page (and the page tags),
when the caller gives the page count.

`putPdf` alone writes a single placeholder page. The tablet replaces it only
when the document is first opened, so annotations can't be written until then.
Without a page count, the placeholder is kept.

## Committing changes

All writes go through rmapi-js's high-level calls, which commit the new root
(written as schema 4: the cloud rejects a newly written schema 3 root) and
retry on a generation conflict. [`putPages`](src/document.ts) hands rebuilt
pages to `putRmPages`, all pages of a document in one commit.

Each write names the document hash the caller read. If the document changed on
the cloud since (new ink from the tablet), rmapi-js refuses the write with
`HashNotFoundError`, so pages computed from an older version never overwrite
newer ink.

## Coordinates

reMarkable renders a PDF at a fixed resolution (`RM_DPI` = 226, calibrated on
an rM2) and stores coordinates in those device pixels, with x measured from
the page centre and y from the top. [`geometry.ts`](src/geometry.ts) converts
them to PDF points (origin bottom-left) with a single scale:

```
pdfX = rmX * 72/RM_DPI + pageWidth/2
pdfY = pageHeight - rmY * 72/RM_DPI
```

The mapping was checked against a real export: highlight rectangles matched the
PDF's vectors within 1 pt. Pen widths use a factor fitted the same way
(`inkWidth`, `pdfWidthToRm`).

[`readPdfPageSizes`](src/geometry.ts) gives each page's visible size. It walks
the PDF's page tree ([`pdfpages.ts`](src/pdfpages.ts)), expanding compressed
object streams and honouring inherited boxes. If that fails, it falls back to a
plain-text scan of `/MediaBox`, then to US Letter.

## Tests

```bash
npm test -w remarkable-annotations      # from the repository root
```

The tests bundle `src/index.ts` with esbuild and check, in Node, against real
pages in [`test/fixtures/rm`](test/fixtures/rm):

- the parser, against the output of [rmscene](https://github.com/ricklupton/rmscene)
  (Python);
- the writer: round trips, appending, cloning, blank pages;
- byte-exact round trips through rmapi-js;
- PDF page sizes.

`npm run typecheck -w remarkable-annotations` type-checks the package on its
own.

## Publishing

Not published yet. rmapi-js doesn't export its scene parser, so
[`rmscene.ts`](src/rmscene.ts) imports it from rmapi-js's `dist` folder, by a
path that assumes npm hoisted rmapi-js to the workspace root. Publishing needs
that exported upstream first.
