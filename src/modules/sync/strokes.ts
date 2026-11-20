// Grouping of pen strokes into one Zotero ink annotation: handwriting (a word,
// a short note, a small drawing) is many strokes on the device, but reads as
// one annotation.
//
// A `.rm` page records no time for its strokes, only the order they were
// drawn in. "Close in time" therefore means drawn one after the other (nothing
// else drawn in between, by the same author); "close in space" means within
// `gap` PDF points of a stroke already in the group. Strokes in a group also
// share their pen (tool and thickness setting) and colour, since a Zotero ink
// annotation has one colour and one width.

/** What grouping needs to know about a stroke. */
export interface GroupableStroke {
  /** same pen and colour (tool, thickness, colour) */
  style: string;
  /** author of the stroke's scene item, if known */
  author?: number;
  /** the stroke's path in PDF points (flat [x, y, x, y, ...]) */
  path: number[];
}

type BBox = [number, number, number, number];

function bbox(path: number[]): BBox {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i + 1 < path.length; i += 2) {
    x0 = Math.min(x0, path[i]);
    x1 = Math.max(x1, path[i]);
    y0 = Math.min(y0, path[i + 1]);
    y1 = Math.max(y1, path[i + 1]);
  }
  return [x0, y0, x1, y1];
}

/** Distance between two boxes (0 when they overlap). */
function distance(a: BBox, b: BBox): number {
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
  return Math.hypot(dx, dy);
}

/**
 * Groups consecutive strokes (in drawing order): a stroke joins the current
 * group when it has the same style and author and is within `gap` of one of
 * the group's strokes. `null` entries (strokes that are not pen ink, e.g.
 * highlighter strokes or rectangles) end the current group. Returns the
 * groups as lists of indices into `strokes`, in order.
 */
export function groupStrokes(
  strokes: (GroupableStroke | null)[],
  gap: number,
): number[][] {
  const groups: number[][] = [];
  let current: {
    indices: number[];
    boxes: BBox[];
    first: GroupableStroke;
  } | null = null;
  strokes.forEach((s, i) => {
    if (!s) {
      current = null;
      return;
    }
    const box = bbox(s.path);
    if (
      current &&
      gap > 0 &&
      s.style === current.first.style &&
      s.author === current.first.author &&
      current.boxes.some((b) => distance(b, box) <= gap)
    ) {
      current.indices.push(i);
      current.boxes.push(box);
      return;
    }
    current = { indices: [i], boxes: [box], first: s };
    groups.push(current.indices);
  });
  return groups;
}
