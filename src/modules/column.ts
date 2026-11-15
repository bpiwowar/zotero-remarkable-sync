// reMarkable status indicator shown *before the item title* (not a separate
// column). A small coloured dot reflecting sync state. Implemented by wrapping
// the item tree's `_renderCell` (which builds the primary/title cell for the
// first column). The ItemTree class is a CommonJS module — `Zotero.ItemTree`
// does not exist — so we resolve its prototype from the window's `require` or a
// live instance. Every addition is in try/catch so it can never break the list.

import { getRecordCached } from "./sync/state";
import { getSyncTag } from "./sync/engine";
import { pushFingerprint } from "./sync/annotations";
import { log } from "../utils/log";

const FRESH_MS = 24 * 60 * 60 * 1000; // "synced recently" window
const PUSHABLE = new Set(["highlight", "underline", "ink"]);

type SyncState = "fresh" | "stale" | "changed" | "never" | "";

const DOT: Record<Exclude<SyncState, "">, [string, string, string]> = {
  fresh: ["●", "#3fae4a", "reMarkable: synced recently"],
  stale: ["●", "#9b9b9b", "reMarkable: synced a while ago"],
  changed: ["◆", "#e67e22", "reMarkable: changed, not yet synced"],
  never: ["○", "#c0c0c0", "reMarkable: tagged, not synced yet"],
};

function stateOf(item: Zotero.Item): SyncState {
  if (!item?.isRegularItem?.()) return "";
  let lastPushed = 0;
  let hasRecord = false;
  let dirty = false;
  for (const att of Zotero.Items.get(item.getAttachments())) {
    if (!att.isPDFAttachment()) continue;
    const rec = getRecordCached(att.key);
    if (!rec) continue;
    hasRecord = true;
    lastPushed = Math.max(lastPushed, rec.lastPushed || 0);
    // Map of already-pushed annotation key -> its fingerprint when pushed, so we
    // can tell a brand-new annotation from an edited one (same key).
    const pushedSig = new Map<string, string | undefined>();
    for (const p of rec.pushedItems ?? []) pushedSig.set(p.key, p.rev);
    const pulled = new Set(rec.annotationKeys ?? []);
    const present = new Set<string>();
    for (const a of att.getAnnotations()) {
      if (!PUSHABLE.has(a.annotationType) || pulled.has(a.key)) continue;
      present.add(a.key);
      if (!pushedSig.has(a.key)) {
        dirty = true; // never pushed
        break;
      }
      const was = pushedSig.get(a.key);
      if (was && pushFingerprint(a) !== was) {
        dirty = true; // pushed before, but edited since
        break;
      }
    }
    // A pulled annotation deleted in Zotero is still on the device until the
    // next push.
    if (!dirty) {
      for (const key of Object.keys(rec.annotationSources ?? {})) {
        const it = Zotero.Items.getByLibraryAndKey(att.libraryID, key);
        if (!it || (it as Zotero.Item).deleted) {
          dirty = true;
          break;
        }
      }
    }
    // A previously-pushed annotation that no longer exists was deleted in Zotero
    // but still lives on the device until the next push.
    if (!dirty) {
      for (const key of pushedSig.keys()) {
        if (!present.has(key)) {
          dirty = true;
          break;
        }
      }
    }
  }
  if (!hasRecord) return item.hasTag(getSyncTag()) ? "never" : "";
  if (dirty) return "changed";
  return Date.now() - lastPushed < FRESH_MS ? "fresh" : "stale";
}

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
        const [glyph, color, title] = DOT[st];
        const dot = cell.ownerDocument.createElement("span");
        dot.textContent = `${glyph} `;
        dot.style.color = color;
        dot.style.flex = "none";
        dot.style.fontSize = "0.9em";
        dot.setAttribute("title", title);
        const text = cell.querySelector?.(".cell-text");
        cell.insertBefore(dot, text ?? cell.firstChild);
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
