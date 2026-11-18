// Recognise the clean shapes the reMarkable produces with its shape tool
// (draw, then hold the pen): an axis-aligned rectangle is stored as a closed
// 5-point polyline, an oval as a closed polyline sampled exactly on an ellipse.
// Hand-drawn (wobbly) strokes are deliberately not matched.

import type { RmPoint, RmRect } from "./rmlines";

export interface RmShape {
  kind: "rectangle" | "ellipse";
  /** bounding box, in reMarkable units */
  bbox: RmRect;
}

/** Tolerance, relative to the shape's smaller side. */
const REL_TOL = 0.02;
/** Smallest side (reMarkable units, ~2.3pt) for a stroke to count as a shape. */
const MIN_SIDE = 7;
/** Minimum sampling of an ellipse (the device uses many more). */
const MIN_ELLIPSE_POINTS = 16;

/**
 * The shape a stroke's points describe, or null for anything else (freehand
 * strokes, lines, rotated rectangles, open paths).
 */
export function detectShape(points: RmPoint[]): RmShape | null {
  if (points.length < 5) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  const w = x1 - x0;
  const h = y1 - y0;
  if (Math.min(w, h) < MIN_SIDE) return null;
  const tol = Math.max(1, Math.min(w, h) * REL_TOL);
  const first = points[0];
  const last = points[points.length - 1];
  if (Math.hypot(first.x - last.x, first.y - last.y) > tol) return null;

  const bbox = { x: x0, y: y0, w, h };
  if (isRectangle(points, x0, y0, x1, y1, tol)) {
    return { kind: "rectangle", bbox };
  }
  if (isEllipse(points, x0, y0, x1, y1, tol)) return { kind: "ellipse", bbox };
  return null;
}

/** Every point on the bounding box's border, and every corner reached. */
function isRectangle(
  points: RmPoint[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  tol: number,
): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) <= tol;
  for (const p of points) {
    const onBorder =
      ((near(p.x, x0) || near(p.x, x1)) &&
        p.y >= y0 - tol &&
        p.y <= y1 + tol) ||
      ((near(p.y, y0) || near(p.y, y1)) && p.x >= x0 - tol && p.x <= x1 + tol);
    if (!onBorder) return false;
  }
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  return corners.every(([cx, cy]) =>
    points.some((p) => near(p.x, cx) && near(p.y, cy)),
  );
}

/**
 * Every point on the ellipse inscribed in the bounding box, and the points go
 * all the way round it (no large angular gap).
 */
function isEllipse(
  points: RmPoint[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  tol: number,
): boolean {
  if (points.length < MIN_ELLIPSE_POINTS) return false;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const a = (x1 - x0) / 2;
  const b = (y1 - y0) / 2;
  const relTol = tol / Math.min(a, b);
  const angles: number[] = [];
  for (const p of points) {
    const u = (p.x - cx) / a;
    const v = (p.y - cy) / b;
    if (Math.abs(Math.hypot(u, v) - 1) > relTol) return false;
    angles.push(Math.atan2(v, u));
  }
  angles.sort((p, q) => p - q);
  let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) {
    gap = Math.max(gap, angles[i] - angles[i - 1]);
  }
  return gap < Math.PI / 4;
}
