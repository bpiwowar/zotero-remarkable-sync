// remarkable-annotations: read and write the annotations of reMarkable
// documents (pen strokes and text highlights on PDF pages), on top of rmapi-js.
//
// - rmlines / rmwrite: parse `.rm` v6 pages into strokes and highlights, and
//   rebuild pages with new items (fresh CRDT ids, per-item authors).
// - rmdoc: map a document's pages to PDF pages and fetch their annotations.
// - document: folders by path, PDF uploads with the full page list, page writes.
// - geometry / pdfpages: reMarkable coordinates <-> PDF points, page sizes.

export * from "./rmlines";
export * from "./rmwrite";
export * from "./rmdoc";
export * from "./document";
export * from "./geometry";
export * from "./pdfpages";
export * from "./shapes";
export { parseRmScene, serializeRmScene, RmScene } from "./rmscene";
