// Parser for reMarkable v6 (`.rm`) scene files — extracts the two things we
// need to round-trip annotations into Zotero: pen/highlighter strokes
// (SceneLineItem, block type 0x05) and text highlights (GlyphRange, block type
// 0x03). Every top-level block is length-prefixed, so we parse only those two
// block types and skip everything else.
//
// Ported from rmscene (github.com/ricklupton/rmscene). Coordinates are in the
// reMarkable page coordinate system (x centred on the page, y from the top);
// mapping them onto PDF points happens in geometry.ts.

const HEADER_V6 = "reMarkable .lines file, version=6          "; // 43 bytes

// Tag types (low nibble of a tag varuint).
const TAG_ID = 0xf;
const TAG_LEN4 = 0xc;
const TAG_B8 = 0x8;
const TAG_B4 = 0x4;
const TAG_B1 = 0x1;

// Block types we care about.
const BLOCK_LINE = 0x05;
const BLOCK_GLYPH = 0x03;

export interface RmPoint {
  x: number;
  y: number;
}

export interface RmStroke {
  /** reMarkable Pen tool id */
  tool: number;
  /** reMarkable PenColor index */
  colorIndex: number;
  /** explicit colour when present (highlighters), [r,g,b,a] 0-255 */
  rgba?: [number, number, number, number];
  /** thickness scale from the stroke (a pen-setting multiplier) */
  thickness: number;
  /** representative per-point pen width (reMarkable units; see geometry.inkWidth) */
  pointWidth: number;
  isHighlighter: boolean;
  points: RmPoint[];
  /** scene item id(s) on the page (set by parseRmPage) */
  ids?: CrdtId[];
}

export interface RmRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RmHighlight {
  text: string;
  colorIndex: number;
  rgba?: [number, number, number, number];
  rects: RmRect[];
  /** scene item id(s) on the page (set by parseRmPage; several once merged) */
  ids?: CrdtId[];
}

export interface CrdtId {
  part1: number;
  part2: number;
}

export interface RmPage {
  strokes: RmStroke[];
  highlights: RmHighlight[];
  /** the layer node items are parented to (for appending new items) */
  layerId?: CrdtId;
  /** the last item id within that layer (chain new items after this) */
  lastItemId?: CrdtId;
  /** highest author part1 seen (registered author to reuse for new items) */
  maxAuthor: number;
  /** highest part2 counter seen (mint new counters above this) */
  maxCounter: number;
}

const HIGHLIGHTER_TOOLS = new Set([5, 18]); // HIGHLIGHTER_1, HIGHLIGHTER_2

class UnexpectedTag extends Error {}

/** Minimal little-endian reader over the v6 tagged-block format. */
class Reader {
  private pos = 0;
  private view: DataView;
  constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get position() {
    return this.pos;
  }
  set position(p: number) {
    this.pos = p;
  }
  get length() {
    return this.bytes.length;
  }
  remaining() {
    return this.bytes.length - this.pos;
  }

  u8() {
    return this.view.getUint8(this.pos++);
  }
  u16() {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32() {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64() {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  bytes_(n: number): Uint8Array {
    const b = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  varuint(): number {
    let shift = 0;
    let result = 0;
    for (;;) {
      const i = this.u8();
      result |= (i & 0x7f) << shift;
      shift += 7;
      if (!(i & 0x80)) break;
    }
    return result >>> 0;
  }

  /** Decode the tag varuint at the current position without advancing. */
  private peekTag(): { index: number; type: number; size: number } | null {
    let shift = 0;
    let value = 0;
    let p = this.pos;
    for (;;) {
      if (p >= this.bytes.length) return null;
      const i = this.bytes[p++];
      value |= (i & 0x7f) << shift;
      shift += 7;
      if (!(i & 0x80)) break;
    }
    return { index: value >> 4, type: value & 0xf, size: p - this.pos };
  }

  checkTag(index: number, type: number): boolean {
    const t = this.peekTag();
    return !!t && t.index === index && t.type === type;
  }

  private expectTag(index: number, type: number): void {
    const t = this.peekTag();
    if (!t || t.index !== index || t.type !== type) {
      throw new UnexpectedTag(
        `expected tag index ${index} type 0x${type.toString(16)} at ${this.pos}`,
      );
    }
    this.pos += t.size;
  }

  readId(index: number): CrdtId {
    this.expectTag(index, TAG_ID);
    const part1 = this.u8();
    const part2 = this.varuint();
    return { part1, part2 };
  }
  readInt(index: number): number {
    this.expectTag(index, TAG_B4);
    return this.u32();
  }
  readFloat(index: number): number {
    this.expectTag(index, TAG_B4);
    return this.f32();
  }
  readDouble(index: number): number {
    this.expectTag(index, TAG_B8);
    return this.f64();
  }
  readIntOptional(index: number): number | null {
    return this.checkTag(index, TAG_B4) ? this.readInt(index) : null;
  }
  /** RGBA from a uint32 packed BGRA, or null if the tag isn't present. */
  readColorOptional(index: number): [number, number, number, number] | null {
    if (!this.checkTag(index, TAG_B4)) return null;
    const p = this.readInt(index);
    return [(p >> 16) & 0xff, (p >> 8) & 0xff, p & 0xff, (p >>> 24) & 0xff];
  }

  /** Open a length-prefixed subblock; returns its end offset. */
  subblock(index: number): number {
    this.expectTag(index, TAG_LEN4);
    const size = this.u32();
    return this.pos + size;
  }

  readString(index: number): string {
    const end = this.subblock(index);
    const len = this.varuint();
    this.u8(); // is_ascii flag
    const s = utf8Decode(this.bytes_(len));
    this.pos = end;
    return s;
  }
}

function utf8Decode(bytes: Uint8Array): string {
  // TextDecoder may be absent in the plugin sandbox; decode manually.
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (b < 0xf0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f),
      );
    } else {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i++] & 0x3f) << 12) |
        ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f);
      const c = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    }
  }
  return out;
}

interface ItemHeader {
  parent: CrdtId;
  item: CrdtId;
  deleted: number;
}

/** Read the common SceneItem header. */
function readItemHeader(r: Reader): ItemHeader {
  const parent = r.readId(1);
  const item = r.readId(2);
  r.readId(3); // left_id
  r.readId(4); // right_id
  const deleted = r.readInt(5);
  return { parent, item, deleted };
}

function parseLine(r: Reader, version: number): RmStroke {
  const tool = r.readInt(1);
  const colorIndex = r.readInt(2);
  const thickness = r.readDouble(3);
  r.readFloat(4); // starting_length

  const pointsEnd = r.subblock(5);
  const pointSize = version === 1 ? 0x18 : 0x0e;
  const points: RmPoint[] = [];
  const widths: number[] = [];
  while (r.position + pointSize <= pointsEnd) {
    const x = r.f32();
    const y = r.f32();
    let w: number;
    if (version === 1) {
      r.f32(); // speed
      r.f32(); // direction
      w = Math.round(r.f32() * 4); // width (v1 stores width/4 as float)
      r.f32(); // pressure
    } else {
      r.u16(); // speed
      w = r.u16(); // width
      r.u8(); // direction
      r.u8(); // pressure
    }
    points.push({ x, y });
    widths.push(w);
  }
  r.position = pointsEnd;
  const pointWidth = median(widths);

  // Optional trailing fields. color_rgba (index 8) is what we want.
  let rgba: [number, number, number, number] | undefined;
  try {
    if (r.checkTag(6, TAG_ID)) r.readId(6); // timestamp
    if (r.checkTag(7, TAG_ID)) r.readId(7); // move_id
    rgba = r.readColorOptional(8) ?? undefined;
  } catch {
    // trailing optionals vary by version — ignore
  }

  return {
    tool,
    colorIndex,
    rgba,
    thickness,
    pointWidth,
    isHighlighter: HIGHLIGHTER_TOOLS.has(tool),
    points,
  };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function parseGlyph(r: Reader): RmHighlight {
  r.readIntOptional(2); // start (pre-3.6 only)
  r.readIntOptional(3); // length
  const colorIndex = r.readInt(4);
  const text = r.readString(5);

  const rectsEnd = r.subblock(6);
  const num = r.varuint();
  const rects: RmRect[] = [];
  for (let i = 0; i < num; i++) {
    rects.push({ x: r.f64(), y: r.f64(), w: r.f64(), h: r.f64() });
  }
  r.position = rectsEnd;

  const rgba = r.readColorOptional(10) ?? undefined;
  return { text, colorIndex, rgba, rects };
}

/** Parse a single `.rm` v6 page into its strokes and highlights. */
export function parseRmPage(bytes: Uint8Array): RmPage {
  const strokes: RmStroke[] = [];
  const highlights: RmHighlight[] = [];
  let layerId: CrdtId | undefined;
  let lastItemId: CrdtId | undefined;
  let maxAuthor = 0;
  let maxCounter = 0;

  const r = new Reader(bytes);
  const header = utf8Decode(bytes.subarray(0, HEADER_V6.length));
  if (header !== HEADER_V6) {
    throw new Error(
      `not a reMarkable v6 file (header: ${JSON.stringify(header)})`,
    );
  }
  r.position = HEADER_V6.length;

  while (r.remaining() >= 8) {
    const blockLen = r.u32();
    r.u8(); // unknown (0)
    r.u8(); // min_version
    const currentVersion = r.u8();
    const blockType = r.u8();
    const blockEnd = r.position + blockLen;
    if (blockEnd > r.length) break; // truncated

    try {
      if (blockType === BLOCK_LINE || blockType === BLOCK_GLYPH) {
        const hdr = readItemHeader(r);
        if (!layerId) layerId = hdr.parent;
        // Track the last item that belongs to the chosen layer, so new items
        // chain after a neighbour in the same CRDT sequence.
        if (
          layerId &&
          hdr.parent.part1 === layerId.part1 &&
          hdr.parent.part2 === layerId.part2
        ) {
          lastItemId = hdr.item;
        }
        maxAuthor = Math.max(maxAuthor, hdr.item.part1, hdr.parent.part1);
        maxCounter = Math.max(maxCounter, hdr.item.part2, hdr.parent.part2);
        if (hdr.deleted === 0 && r.checkTag(6, TAG_LEN4)) {
          const end = r.subblock(6);
          r.u8(); // item_type
          if (blockType === BLOCK_LINE) {
            const stroke = parseLine(r, currentVersion);
            stroke.ids = [hdr.item];
            if (stroke.points.length) strokes.push(stroke);
          } else {
            const hl = parseGlyph(r);
            hl.ids = [hdr.item];
            if (hl.rects.length) highlights.push(hl);
          }
          r.position = end;
        }
      }
    } catch {
      // Malformed/unsupported block — skip it.
    }

    r.position = blockEnd; // always realign to the next block
  }

  return { strokes, highlights, layerId, lastItemId, maxAuthor, maxCounter };
}
