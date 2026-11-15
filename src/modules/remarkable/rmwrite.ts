// Write reMarkable v6 (`.rm`) pages: rebuild a page with our strokes and
// highlights, as rmapi-js scene blocks (rmscene.ts) serialized back to bytes.
//
// CrdtIds: every scene item needs a unique id and a left/right neighbour to take
// its place in the layer's CRDT sequence. We mint fresh ids under an author
// already registered in the page, and chain new items after `lastItemId`.

import type { RmBlock } from "rmapi-js";
import {
  packRgba,
  toSceneId,
  type CrdtId,
  type RmHighlight,
  type RmStroke,
} from "./rmlines";
import { parseRmScene, serializeRmScene, RmScene } from "./rmscene";

const END = { authorId: 0, counter: 0 };
const id = (authorId: number, counter: number) => ({ authorId, counter });
const common = (minVersion: number, currentVersion: number) => ({
  reserved: 0,
  minVersion,
  currentVersion,
  extraData: new Uint8Array(),
});

/** Scene item blocks: what we add and remove; everything else is structure. */
const isItem = (b: RmBlock) =>
  b.type === "sceneLineItem" ||
  b.type === "sceneGlyphItem" ||
  b.type === "sceneTombstone" ||
  (b.type === "unknown" && [0x03, 0x05, 0x08].includes(b.blockType));

export interface RmStructure {
  /** header + structural blocks (no scene items) */
  structure: Uint8Array;
  /** the layer node to parent new items to */
  layerId: CrdtId;
  /** a registered author id to mint new item ids under */
  author: number;
  /** first counter to use for new item ids */
  startCounter: number;
}

export interface PageUpdateMeta {
  layerId: CrdtId;
  lastItemId?: CrdtId;
  /** an author id already registered in the page (reuse, don't invent) */
  author: number;
  /** first counter to use — must be above every existing part2 */
  startCounter: number;
}

/**
 * Return a copy of a real `.rm` page with all scene items removed: its
 * structural blocks (author ids, page info, scene tree, layers). Used as a
 * device-valid template for a page that has no `.rm` yet.
 */
export function splitStructure(bytes: Uint8Array): Uint8Array {
  const { blocks } = parseRmScene(bytes);
  return serializeRmScene(new RmScene(blocks.filter((b) => !isItem(b))));
}

// Fixed author uuid for plugin-created pages (the author map is local to a file).
const AUTHOR_UUID = "79736d72-636e-1000-8000-000000000001";

/**
 * Generate a blank, device-valid page from scratch: author ids, migration info,
 * page info, scene tree, a root group and one layer group. Used when a page has
 * no `.rm` and the document has no other page to clone. Ported from rmscene's
 * `simple_text_document` (minus the text).
 */
export function blankStructure(author = 1): RmStructure {
  const blocks: RmBlock[] = [
    {
      type: "authorIds",
      authors: new Map([[author, AUTHOR_UUID]]),
      ...common(1, 1),
    },
    {
      type: "migrationInfo",
      migrationId: id(1, 1),
      isDevice: true,
      ...common(1, 1),
      extraData: Uint8Array.of(0x31, 0), // field 3: false
    },
    {
      type: "pageInfo",
      loadsCount: 1,
      mergesCount: 0,
      textCharsCount: 0,
      textLinesCount: 0,
      typeFolioUseCount: 0,
      ...common(0, 1),
    },
    // Register the layer subtree under the root group.
    {
      type: "sceneTree",
      treeId: id(0, 11),
      nodeId: id(0, 0),
      isUpdate: true,
      parentId: id(0, 1),
      ...common(1, 1),
    },
    {
      type: "treeNode",
      nodeId: id(0, 1),
      label: { timestamp: id(0, 0), value: "" },
      visible: { timestamp: id(0, 0), value: true },
      ...common(1, 2),
    },
    {
      type: "treeNode",
      nodeId: id(0, 11),
      label: { timestamp: id(0, 12), value: "Layer 1" },
      visible: { timestamp: id(0, 0), value: true },
      ...common(1, 2),
    },
    // Make the layer a child of the root.
    {
      type: "sceneGroupItem",
      parentId: id(0, 1),
      item: {
        itemId: id(0, 13),
        leftId: END,
        rightId: END,
        deletedLength: 0,
        value: id(0, 11),
      },
      ...common(1, 1),
    },
  ];
  return {
    structure: serializeRmScene(new RmScene(blocks)),
    layerId: { part1: 0, part2: 11 },
    author,
    startCounter: 20,
  };
}

/**
 * Rewrite a page: drop the scene items whose item id is in `removeIds`
 * ("part1,part2"), keep every other block as is (structure and device items),
 * then append the given items, highlights first. Returns the new bytes and the
 * ids assigned to the added items (highlights, then strokes), so the caller can
 * remove them later.
 */
export function rebuildPage(
  existing: Uint8Array,
  strokes: RmStroke[],
  highlights: RmHighlight[],
  removeIds: Set<string>,
  meta: PageUpdateMeta,
): { bytes: Uint8Array; ids: CrdtId[] } {
  const blocks = parseRmScene(existing).blocks.filter(
    (b) =>
      !(
        "item" in b &&
        isItem(b) &&
        removeIds.has(`${b.item.itemId.authorId},${b.item.itemId.counter}`)
      ),
  );

  const parentId = toSceneId(meta.layerId);
  let left = meta.lastItemId ? toSceneId(meta.lastItemId) : END;
  let counter = meta.startCounter;
  const ids: CrdtId[] = [];
  const nextItem = () => {
    const itemId = id(meta.author, counter++);
    const item = { itemId, leftId: left, rightId: END, deletedLength: 0 };
    ids.push({ part1: itemId.authorId, part2: itemId.counter });
    left = itemId;
    return item;
  };

  for (const hl of highlights) {
    blocks.push({
      type: "sceneGlyphItem",
      parentId,
      item: {
        ...nextItem(),
        value: {
          start: 0,
          length: hl.text.length,
          color: hl.colorIndex as any,
          text: hl.text,
          rectangles: hl.rects.map(({ x, y, w, h }) => ({ x, y, w, h })),
          colorRgba: packRgba(hl.rgba),
        },
      },
      ...common(0, 1),
    });
  }
  for (const stroke of strokes) {
    const width = Math.max(1, Math.round(stroke.pointWidth || 16));
    blocks.push({
      type: "sceneLineItem",
      parentId,
      item: {
        ...nextItem(),
        value: {
          tool: stroke.tool as any,
          color: stroke.colorIndex as any,
          thicknessScale: stroke.thickness || 2,
          startingLength: 0,
          points: stroke.points.map(({ x, y }) => ({
            x,
            y,
            speed: 0,
            width,
            direction: 0,
            pressure: 0,
          })),
          timestampId: id(0, 1),
          colorRgba: packRgba(stroke.rgba),
        },
      },
      ...common(2, 2),
    });
  }
  return { bytes: serializeRmScene(new RmScene(blocks)), ids };
}
