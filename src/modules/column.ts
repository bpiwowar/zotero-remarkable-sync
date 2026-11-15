// reMarkable status indicator shown *before the item title* (not a separate
// column). A small icon reflecting sync state (status.ts). Implemented by wrapping
// the item tree's `_renderCell` (which builds the primary/title cell for the
// first column). The ItemTree class is a CommonJS module — `Zotero.ItemTree`
// does not exist — so we resolve its prototype from the window's `require` or a
// live instance. Every addition is in try/catch so it can never break the list.

import { stateOf, statusIcon } from "./status";
import { getString } from "../utils/locale";
import { log } from "../utils/log";

/** Resolve the ItemTree prototype from a window (require module or instance). */
function itemTreeProto(win: any): any {
  try {
    const cls = win?.require?.("zotero/itemTree");
    if (cls?.prototype?._renderCell) return cls.prototype;
  } catch {
    /* require may not expose it; fall through */
  }
  const inst = win?.ZoteroPane?.itemsView;
  if (inst?.constructor?.prototype?._renderCell)
    return inst.constructor.prototype;
  return null;
}

function patchProto(proto: any): boolean {
  if (proto.__rmsOrig) return true; // already wrapped
  proto.__rmsOrig = proto._renderCell;
  proto._renderCell = function (this: any, ...args: any[]) {
    const cell = proto.__rmsOrig.apply(this, args);
    try {
      const [index, , , isFirstColumn] = args;
      if (!isFirstColumn || !cell?.ownerDocument) return cell;
      const item = this.getRow?.(index)?.ref as Zotero.Item;
      const st = stateOf(item);
      if (st) {
        const icon = statusIcon(cell.ownerDocument, st);
        icon.style.marginInlineEnd = "4px";
        icon.setAttribute("title", `reMarkable: ${getString(`status-${st}`)}`);
        const text = cell.querySelector?.(".cell-text");
        cell.insertBefore(icon, text ?? cell.firstChild);
      }
    } catch {
      // never break the item tree
    }
    return cell;
  };
  return true;
}

/** Force the item tree to repaint so the dot appears on already-rendered rows. */
function repaint(win: any): void {
  try {
    win?.ZoteroPane?.itemsView?.tree?.invalidate?.();
  } catch {
    /* ignore */
  }
}

/** Repaint every open window's item tree (e.g. after annotations change). */
export function refresh(): void {
  for (const win of Zotero.getMainWindows()) repaint(win);
}

/**
 * Attach the status dot for a window. The ItemTree prototype is shared across
 * windows, so the wrap is global and idempotent; we still need a window to find
 * the class and to repaint. Retries while the items view is still initialising.
 */
export function registerColumn(win?: any): void {
  const target = win ?? Zotero.getMainWindow();
  let tries = 0;
  const attempt = () => {
    try {
      const proto = itemTreeProto(target);
      if (!proto) {
        if (tries++ < 20) {
          (target as any)?.setTimeout?.(attempt, 500);
        } else {
          log("status dot: ItemTree prototype not found (gave up)");
        }
        return;
      }
      const already = !!proto.__rmsOrig;
      patchProto(proto);
      repaint(target);
      if (!already) log("status dot: attached to item tree");
    } catch (e) {
      log("status dot failed:", e);
    }
  };
  attempt();
}

export function unregisterColumn(): void {
  try {
    const proto = itemTreeProto(Zotero.getMainWindow());
    if (proto?.__rmsOrig) {
      proto._renderCell = proto.__rmsOrig;
      delete proto.__rmsOrig;
    }
  } catch {
    /* ignore */
  }
}
