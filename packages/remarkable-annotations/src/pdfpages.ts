// Read per-page sizes from a PDF by walking its page tree.
//
// Modern PDFs (PDF 1.5+) usually keep page dictionaries inside compressed
// object streams (/Type /ObjStm), so a plain-text scan for `/MediaBox` finds
// nothing and we would silently fall back to US Letter — misplacing every
// annotation by the size difference. Here we index every object (expanding
// object streams with zlib), then walk Catalog -> Pages -> Kids in order,
// honouring inherited MediaBox/CropBox and indirect references.
//
// Deliberately small: no encryption, no stream predictors (object streams do
// not use them in practice). Returns null when anything is off, so the caller
// can fall back.

import { unzlibSync, inflateSync } from "fflate";

export interface PdfBox {
  /** lower-left corner of the visible box, in PDF user space */
  x0: number;
  y0: number;
  width: number;
  height: number;
}

type Box = [number, number, number, number];

function latin1(bytes: Uint8Array): string {
  let s = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return s;
}

function toBytes(s: string, start: number, end: number): Uint8Array {
  const out = new Uint8Array(end - start);
  for (let i = start; i < end; i++) out[i - start] = s.charCodeAt(i) & 0xff;
  return out;
}

function inflate(data: Uint8Array): Uint8Array | null {
  try {
    return unzlibSync(data);
  } catch {
    try {
      return inflateSync(data);
    } catch {
      return null;
    }
  }
}

const OBJ_RE = /(\d+)\s+(\d+)\s+obj\b/g;

/** Locate the raw stream bytes following a `stream` keyword at `at`. */
function streamBody(
  s: string,
  dict: string,
  at: number,
  objects: Map<number, string>,
): [number, number] | null {
  let start = at + "stream".length;
  if (s[start] === "\r") start++;
  if (s[start] === "\n") start++;
  const lenM = /\/Length\s+(\d+)(?:\s+(\d+)\s+R)?/.exec(dict);
  if (lenM) {
    let len = parseInt(lenM[1], 10);
    if (lenM[2] !== undefined) {
      const ref = objects.get(len);
      len = ref ? parseInt(ref.trim(), 10) : NaN;
    }
    if (Number.isFinite(len) && start + len <= s.length) {
      return [start, start + len];
    }
  }
  const end = s.indexOf("endstream", start);
  if (end < 0) return null;
  let e = end;
  if (s[e - 1] === "\n") e--;
  if (s[e - 1] === "\r") e--;
  return [start, e];
}

/** Index all objects (number -> text), expanding object streams in place. */
function indexObjects(s: string): Map<number, string> {
  const objects = new Map<number, string>();
  const pendingStreams: { dict: string; at: number }[] = [];
  OBJ_RE.lastIndex = 0;
  for (let m = OBJ_RE.exec(s); m; m = OBJ_RE.exec(s)) {
    const num = parseInt(m[1], 10);
    const bodyStart = m.index + m[0].length;
    let endobj = s.indexOf("endobj", bodyStart);
    if (endobj < 0) break;
    const st = s.indexOf("stream", bodyStart);
    let dict = s.slice(bodyStart, endobj);
    if (st >= 0 && st < endobj) {
      dict = s.slice(bodyStart, st);
      const es = s.indexOf("endstream", st);
      if (es >= 0) endobj = Math.max(endobj, s.indexOf("endobj", es));
      if (/\/Type\s*\/ObjStm\b/.test(dict))
        pendingStreams.push({ dict, at: st });
    }
    objects.set(num, dict);
    OBJ_RE.lastIndex = endobj + "endobj".length;
  }
  // Expand object streams after the first pass so indirect /Length resolves.
  // Objects defined directly in the file win over compressed copies.
  for (const { dict, at } of pendingStreams) {
    const body = streamBody(s, dict, at, objects);
    if (!body) continue;
    const raw = toBytes(s, body[0], body[1]);
    const data = /\/FlateDecode\b/.test(dict) ? inflate(raw) : raw;
    if (!data) continue;
    const text = latin1(data);
    const n = parseInt(/\/N\s+(\d+)/.exec(dict)?.[1] ?? "", 10);
    const first = parseInt(/\/First\s+(\d+)/.exec(dict)?.[1] ?? "", 10);
    if (!Number.isFinite(n) || !Number.isFinite(first)) continue;
    const nums = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const objNum = nums[2 * i];
      const off = first + nums[2 * i + 1];
      const next = i + 1 < n ? first + nums[2 * i + 3] : text.length;
      if (!Number.isFinite(objNum) || !Number.isFinite(off)) continue;
      if (!objects.has(objNum)) objects.set(objNum, text.slice(off, next));
    }
  }
  return objects;
}

/** Read a numeric box `[a b c d]` (or a reference to one) for `key`. */
function readBox(
  dict: string,
  key: string,
  objects: Map<number, string>,
): Box | null {
  const m = new RegExp(`/${key}\\s*(\\[[^\\]]*\\]|(\\d+)\\s+\\d+\\s+R)`).exec(
    dict,
  );
  if (!m) return null;
  const arr = m[2] !== undefined ? objects.get(parseInt(m[2], 10)) : m[1];
  const nums = /\[([^\]]*)\]/
    .exec(arr ?? "")?.[1]
    .trim()
    .split(/\s+/)
    .map(Number);
  if (!nums || nums.length !== 4 || nums.some((v) => !Number.isFinite(v))) {
    return null;
  }
  return [
    Math.min(nums[0], nums[2]),
    Math.min(nums[1], nums[3]),
    Math.max(nums[0], nums[2]),
    Math.max(nums[1], nums[3]),
  ];
}

function refsIn(text: string): number[] {
  return [...text.matchAll(/(\d+)\s+\d+\s+R/g)].map((r) => parseInt(r[1], 10));
}

/**
 * Visible box (CropBox ∩ MediaBox) of every page in document order, or null
 * when the page tree cannot be read.
 */
export function readPdfPageBoxes(bytes: Uint8Array): PdfBox[] | null {
  if (!bytes.length) return null;
  const s = latin1(bytes);
  const objects = indexObjects(s);

  // The last /Root wins (incremental updates append a newer trailer).
  const roots = [...s.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)];
  let catalog = roots.length
    ? objects.get(parseInt(roots[roots.length - 1][1], 10))
    : undefined;
  if (!catalog || !/\/Pages\s+\d+/.test(catalog)) {
    catalog = [...objects.values()].find((o) => /\/Type\s*\/Catalog\b/.test(o));
  }
  const pagesRef = catalog && /\/Pages\s+(\d+)\s+\d+\s+R/.exec(catalog);
  if (!pagesRef) return null;

  const out: PdfBox[] = [];
  const seen = new Set<number>();
  const walk = (num: number, media: Box | null, crop: Box | null) => {
    if (seen.has(num)) return;
    seen.add(num);
    const node = objects.get(num);
    if (!node) return;
    media = readBox(node, "MediaBox", objects) ?? media;
    crop = readBox(node, "CropBox", objects) ?? crop;
    const kids = /\/Kids\s*(\[[^\]]*\]|(\d+)\s+\d+\s+R)/.exec(node);
    if (kids && !/\/Type\s*\/Page(?![a-zA-Z])/.test(node)) {
      const list =
        kids[2] !== undefined ? (objects.get(+kids[2]) ?? "") : kids[1];
      for (const k of refsIn(list)) walk(k, media, crop);
      return;
    }
    if (!media) return;
    const b: Box = crop
      ? [
          Math.max(media[0], crop[0]),
          Math.max(media[1], crop[1]),
          Math.min(media[2], crop[2]),
          Math.min(media[3], crop[3]),
        ]
      : media;
    if (b[2] <= b[0] || b[3] <= b[1]) return;
    out.push({ x0: b[0], y0: b[1], width: b[2] - b[0], height: b[3] - b[1] });
  };
  walk(parseInt(pagesRef[1], 10), null, null);
  return out.length ? out : null;
}
