// UI surface for the plugin:
//  - a toolbar button + Tools-menu item for "Sync now",
//  - a native item context-menu for Add / Remove from sync,
//  - an item-pane status section with toggle + sync buttons,
//  - the progress-window runner shared by all of them.

import { config } from "../../package.json";
import { getString, getLocaleID } from "../utils/locale";
import { log, errMsg } from "../utils/log";
import { getPref } from "../utils/prefs";
import * as engine from "./sync/engine";
import { pushAnnotations } from "./sync/push";
import * as client from "./remarkable/client";
import * as cleanup from "./sync/cleanup";

// 96px icon (manifest/install). For in-app UI we use a small 32px variant so
// it isn't rendered oversized in the toolbar / item-pane sidenav.
const ICON = `chrome://${config.addonRef}/content/icons/icon-small.png`;
const ID = `${config.addonRef}`;
const SECTION_ID = `${config.addonRef}-status`;

// Stable ids of every element we inject, so registration can be made
// idempotent across hot-reloads (when our module-level state is reset but the
// previously injected DOM nodes survive).
const ELEMENT_IDS = [
  `${ID}-tb-syncnow`,
  `${ID}-style`,
  `${ID}-tools-menu`,
  `${ID}-tools-syncnow`,
  `${ID}-tools-push`,
  `${ID}-tools-forcepull`,
  `${ID}-tools-clearpulled`,
  `${ID}-tools-cleanup`,
  `${ID}-sep`,
  `${ID}-add`,
  `${ID}-remove`,
  `${ID}-ovr-zotero`,
  `${ID}-ovr-remarkable`,
  `${ID}-pane-popup`,
];
// Property key under which we stash the popupshowing listener on the item menu
// element, so a stale one can be removed even after a hot-reload.
const SHOWING_KEY = `${ID}-onShowing`;

/** Remove any UI we (or a previous hot-reloaded instance) injected into a window. */
function clearWindowUI(win: Window): void {
  const doc = win.document;
  // Use querySelectorAll, not getElementById: stacked hot-reloads can leave
  // several elements sharing the same id, and we must remove all of them.
  ELEMENT_IDS.forEach((id) =>
    doc.querySelectorAll(`#${id}`).forEach((el: Element) => el.remove()),
  );
  const itemmenu = doc.getElementById("zotero-itemmenu") as any;
  if (itemmenu?.[SHOWING_KEY]) {
    itemmenu.removeEventListener("popupshowing", itemmenu[SHOWING_KEY]);
    delete itemmenu[SHOWING_KEY];
  }
}

// ---------------------------------------------------------------------------
// Shared runner
// ---------------------------------------------------------------------------

function selectedRegularItems(win: Window): Zotero.Item[] {
  const pane = (win as any).ZoteroPane;
  const items: Zotero.Item[] = pane?.getSelectedItems?.() ?? [];
  return items.filter((it) => it.isRegularItem());
}

/**
 * Push PDFs + annotations, then pull. With `items`, only those papers' PDF
 * attachments are synced; otherwise every tagged item is.
 */
export async function runSyncNow(items?: Zotero.Item[]): Promise<void> {
  if (!client.isConnected()) {
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({ text: getString("status-not-connected"), type: "fail" })
      .show(4000);
    return;
  }

  const pw = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({ text: getString("sync-running"), progress: 0 })
    .show();

  try {
    const report = (text: string, pct: number) =>
      pw.changeLine({ progress: pct, text });
    const atts = items ? engine.pdfAttachmentsOf(items) : undefined;
    const onlyKeys = atts ? new Set(atts.map((a) => a.key)) : undefined;
    const runOnce = async () => {
      const push = await engine.pushAll(report, { attachments: atts });
      const sent = await pushAnnotations(report, { onlyKeys });
      log("runSyncNow: push done, starting pull");
      const pull = await engine.pullAll(report, { onlyKeys });
      return { push, sent, pull };
    };
    let push, sent, pull;
    try {
      ({ push, sent, pull } = await runOnce());
    } catch (e) {
      // A stalled/aborted request usually means a stale session token. Drop the
      // cached session, re-authenticate, and try the whole run once more.
      log("runSyncNow: first attempt failed, refreshing session:", errMsg(e));
      report(getString("sync-running"), 0);
      client.resetApi();
      ({ push, sent, pull } = await runOnce());
    }
    pw.changeLine({
      progress: 100,
      text: getString("sync-complete", {
        args: {
          files: push.pushed,
          sent: sent.pushed,
          added: pull.annotations,
          removed: pull.removed,
          stopped: push.stopped,
        },
      }),
    });
    pw.startCloseTimer(5000);
  } catch (e) {
    log("runSyncNow error:", e);
    pw.changeLine({
      type: "fail",
      progress: 100,
      text: getString("sync-error", { args: { error: errMsg(e) } }),
    });
    pw.startCloseTimer(8000);
  }
}

/** Force a re-pull of annotations (ignores the unchanged-since-last-pull guard). */
export async function runForcePull(): Promise<void> {
  if (!client.isConnected()) {
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({ text: getString("status-not-connected"), type: "fail" })
      .show(4000);
    return;
  }
  const pw = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({ text: getString("sync-running"), progress: 0 })
    .show();
  try {
    const pull = await engine.pullAll(
      (text, pct) => pw.changeLine({ progress: pct, text }),
      { force: true },
    );
    pw.changeLine({
      progress: 100,
      text: getString("pull-done", {
        args: { added: pull.annotations, removed: pull.removed },
      }),
    });
    pw.startCloseTimer(5000);
  } catch (e) {
    log("runForcePull error:", e);
    pw.changeLine({
      type: "fail",
      progress: 100,
      text: getString("sync-error", { args: { error: errMsg(e) } }),
    });
    pw.startCloseTimer(8000);
  }
}

/** Push Zotero-origin annotations to the reMarkable device. */
export async function runPush(): Promise<void> {
  if (notConnected() || blockedBySafeMode()) return;
  const pw = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({ text: getString("sync-running"), progress: 0 })
    .show();
  try {
    const summary = await pushAnnotations((text, pct) =>
      pw.changeLine({ progress: pct, text }),
    );
    pw.changeLine({
      progress: 100,
      text: getString("push-done", {
        args: { pushed: summary.pushed, skipped: summary.skipped },
      }),
    });
    pw.startCloseTimer(6000);
  } catch (e) {
    log("runPush error:", e);
    pw.changeLine({
      type: "fail",
      progress: 100,
      text: getString("sync-error", { args: { error: errMsg(e) } }),
    });
    pw.startCloseTimer(8000);
  }
}

/** Remove all plugin-created annotations and reset pull state (manual reset). */
export async function runClearPulled(): Promise<void> {
  const pw = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({ text: getString("sync-running"), progress: 50 })
    .show();
  try {
    const removed = await engine.clearPulledAnnotations();
    pw.changeLine({
      progress: 100,
      text: getString("clear-done", { args: { count: removed } }),
    });
    pw.startCloseTimer(5000);
  } catch (e) {
    log("runClearPulled error:", e);
    pw.changeLine({
      type: "fail",
      progress: 100,
      text: getString("sync-error", { args: { error: errMsg(e) } }),
    });
    pw.startCloseTimer(8000);
  }
}

function notConnected(): boolean {
  if (client.isConnected()) return false;
  new ztoolkit.ProgressWindow(config.addonName)
    .createLine({ text: getString("status-not-connected"), type: "fail" })
    .show(4000);
  return true;
}

/** Block device-mutating annotation pushes while safe mode is on (with notice). */
function blockedBySafeMode(): boolean {
  if (!engine.isSafeMode()) return false;
  new ztoolkit.ProgressWindow(config.addonName)
    .createLine({ text: getString("safe-mode-blocked"), type: "fail" })
    .show(5000);
  return true;
}

function newProgress() {
  return new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({ text: getString("sync-running"), progress: 0 })
    .show();
}

/** Force-push the selected items' PDFs + annotations to the device (Zotero wins). */
export async function runOverwriteFromZotero(
  items: Zotero.Item[],
): Promise<void> {
  if (notConnected() || blockedBySafeMode()) return;
  const atts = engine.pdfAttachmentsOf(items);
  if (atts.length === 0) {
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({ text: getString("nothing-selected"), type: "fail" })
      .show(3000);
    return;
  }
  const onlyKeys = new Set(atts.map((a) => a.key));
  const pw = newProgress();
  try {
    const report = (text: string, pct: number) =>
      pw.changeLine({ progress: pct, text });
    await engine.pushAll(report, { attachments: atts, force: true });
    const ann = await pushAnnotations(report, { onlyKeys });
    pw.changeLine({
      progress: 100,
      text: getString("overwrite-zotero-done", { args: { sent: ann.pushed } }),
    });
    pw.startCloseTimer(5000);
  } catch (e) {
    log("runOverwriteFromZotero error:", e);
    pw.changeLine({
      type: "fail",
      progress: 100,
      text: getString("sync-error", { args: { error: errMsg(e) } }),
    });
    pw.startCloseTimer(8000);
  }
}

/** Force-pull the selected items' annotations from the device (device wins). */
export async function runOverwriteFromRemarkable(
  items: Zotero.Item[],
): Promise<void> {
  if (notConnected()) return;
  const atts = engine.pdfAttachmentsOf(items);
  if (atts.length === 0) {
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({ text: getString("nothing-selected"), type: "fail" })
      .show(3000);
    return;
  }
  const onlyKeys = new Set(atts.map((a) => a.key));
  const pw = newProgress();
  try {
    const report = (text: string, pct: number) =>
      pw.changeLine({ progress: pct, text });
    await engine.resetPullState([...onlyKeys]);
    const pull = await engine.pullAll(report, { force: true, onlyKeys });
    pw.changeLine({
      progress: 100,
      text: getString("overwrite-remarkable-done", {
        args: { added: pull.annotations, removed: pull.removed },
      }),
    });
    pw.startCloseTimer(5000);
  } catch (e) {
    log("runOverwriteFromRemarkable error:", e);
    pw.changeLine({
      type: "fail",
      progress: 100,
      text: getString("sync-error", { args: { error: errMsg(e) } }),
    });
    pw.startCloseTimer(8000);
  }
}

/**
 * Re-send the selected items' Zotero annotations to the device, rewriting
 * every page that holds one even if nothing changed. The PDF is not
 * re-uploaded, so the tablet's own annotations stay.
 */
export async function runForcePush(items: Zotero.Item[]): Promise<void> {
  if (notConnected() || blockedBySafeMode()) return;
  const atts = engine.pdfAttachmentsOf(items);
  if (atts.length === 0) {
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({ text: getString("nothing-selected"), type: "fail" })
      .show(3000);
    return;
  }
  const pw = newProgress();
  try {
    const summary = await pushAnnotations(
      (text, pct) => pw.changeLine({ progress: pct, text }),
      { onlyKeys: new Set(atts.map((a) => a.key)), force: true },
    );
    pw.changeLine({
      progress: 100,
      text: getString("force-push-done", {
        args: { pushed: summary.pushed, skipped: summary.skipped },
      }),
    });
    pw.startCloseTimer(5000);
  } catch (e) {
    log("runForcePush error:", e);
    pw.changeLine({
      type: "fail",
      progress: 100,
      text: getString("sync-error", { args: { error: errMsg(e) } }),
    });
    pw.startCloseTimer(8000);
  }
}

/**
 * Ask how to remove items from sync: delete their reMarkable copies or keep
 * them, optionally pulling their annotations first. Null when cancelled.
 */
function askUnsync(
  win: Window,
  count: number,
): { deleteRemote: boolean; purge: boolean; pullFirst: boolean } | null {
  const ps = ztoolkit.getGlobal("Services").prompt;
  // Button 1 (Cancel) is what Escape/close returns; the default button follows
  // the deleteOnUnsync pref.
  const flags =
    ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING +
    ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL +
    ps.BUTTON_POS_2 * ps.BUTTON_TITLE_IS_STRING +
    (getPref("deleteOnUnsync")
      ? ps.BUTTON_POS_0_DEFAULT
      : ps.BUTTON_POS_2_DEFAULT);
  const pull = { value: true };
  const button = ps.confirmEx(
    win as any,
    getString("unsync-title"),
    getString("unsync-ask", { args: { count } }),
    flags,
    getString("unsync-btn-delete"),
    "",
    getString("unsync-btn-keep"),
    getString("unsync-pull-first"),
    pull,
  );
  if (button === 1) return null;
  if (button === 2)
    return { deleteRemote: false, purge: false, pullFirst: pull.value };
  // Deleting: trash (recoverable, default) or purge. Escape cancels.
  const how = ps.confirmEx(
    win as any,
    getString("unsync-title"),
    getString("unsync-delete-how", { args: { count } }),
    ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING +
      ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL +
      ps.BUTTON_POS_2 * ps.BUTTON_TITLE_IS_STRING +
      ps.BUTTON_POS_0_DEFAULT,
    getString("unsync-btn-trash"),
    "",
    getString("unsync-btn-purge"),
    null as any,
    {},
  );
  if (how === 1) return null;
  return { deleteRemote: true, purge: how === 2, pullFirst: pull.value };
}

/** "Remove from sync" with confirmation (and optional final pull). */
export async function runRemoveFromSync(
  win: Window,
  items: Zotero.Item[],
): Promise<void> {
  const synced = items.filter((it) => engine.isItemSynced(it));
  if (synced.length === 0) return;
  try {
    if (!client.isConnected()) {
      await engine.removeFromSync(synced, { deleteRemote: false });
      return;
    }
    const choice = askUnsync(win, synced.length);
    if (!choice) return;
    const pw = choice.pullFirst ? newProgress() : null;
    const progress = pw
      ? (text: string, pct: number) => pw.changeLine({ progress: pct, text })
      : undefined;
    try {
      await engine.removeFromSync(synced, { ...choice, progress });
      pw?.changeLine({ progress: 100, text: getString("unsync-done") });
      pw?.startCloseTimer(3000);
    } catch (e) {
      pw?.changeLine({
        type: "fail",
        progress: 100,
        text: getString("sync-error", { args: { error: errMsg(e) } }),
      });
      pw?.startCloseTimer(8000);
      throw e;
    }
  } catch (e) {
    log("removeFromSync error:", e);
  } finally {
    refreshStatusDots();
  }
}

/**
 * Ask, for one untracked device document, what to do with it. Ignore is the
 * default (Enter / Escape / closing the dialog). `stop` is set when the user
 * ticked "ignore all remaining".
 */
function askOrphan(
  win: Window,
  orphan: cleanup.Orphan,
  index: number,
  total: number,
): { decision: cleanup.Decision; stop: boolean } {
  const Services = ztoolkit.getGlobal("Services");
  const ps = Services.prompt;
  const cand = orphan.candidate;
  let text = getString("cleanup-ask-doc", {
    args: {
      name: orphan.entry.visibleName,
      index: index + 1,
      total,
      modified: new Date(
        Number(orphan.entry.lastModified) || orphan.entry.lastModified || 0,
      ).toLocaleString(),
    },
  });
  if (cand) {
    const parent = cand.parentItem;
    text +=
      "\n\n" +
      getString(
        orphan.reason === "record"
          ? "cleanup-ask-match-record"
          : "cleanup-ask-match-title",
        {
          args: {
            title: parent?.getDisplayTitle() ?? cand.getDisplayTitle(),
            library: Zotero.Libraries.getName(cand.libraryID),
            matches: orphan.matches ?? 1,
          },
        },
      );
  } else {
    text += "\n\n" + getString("cleanup-ask-no-match");
  }

  // Button 1 is the default and also what Escape/close returns → Ignore.
  let flags =
    ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING +
    ps.BUTTON_POS_1 * ps.BUTTON_TITLE_IS_STRING +
    ps.BUTTON_POS_1_DEFAULT;
  if (cand) flags += ps.BUTTON_POS_2 * ps.BUTTON_TITLE_IS_STRING;
  const stop = { value: false };
  const button = ps.confirmEx(
    win as any,
    getString("cleanup-title"),
    text,
    flags,
    getString("cleanup-btn-delete"),
    getString("cleanup-btn-ignore"),
    cand ? getString("cleanup-btn-relink") : "",
    getString("cleanup-ignore-rest"),
    stop,
  );
  const decision: cleanup.Decision =
    button === 0 ? "delete" : button === 2 && cand ? "relink" : "ignore";
  return { decision, stop: stop.value };
}

/**
 * Review the reMarkable sync folder for documents not linked to a tagged item.
 * Asks per document (relink / move to trash / ignore), then confirms once more
 * before changing anything.
 */
export async function runCleanup(win: Window): Promise<void> {
  if (notConnected()) return;
  const pw = newProgress();
  pw.changeLine({ text: getString("cleanup-scanning"), progress: 0 });
  try {
    const api = await client.getApi();
    const { orphans, folderFound } = await cleanup.findOrphans(api);
    if (!folderFound || orphans.length === 0) {
      pw.changeLine({
        progress: 100,
        text: getString(folderFound ? "cleanup-none" : "cleanup-no-folder"),
      });
      pw.startCloseTimer(4000);
      return;
    }
    pw.close();

    const decisions: { orphan: cleanup.Orphan; decision: cleanup.Decision }[] =
      [];
    for (let i = 0; i < orphans.length; i++) {
      const { decision, stop } = askOrphan(win, orphans[i], i, orphans.length);
      if (decision !== "ignore")
        decisions.push({ orphan: orphans[i], decision });
      if (stop) break;
    }
    const trash = decisions.filter((d) => d.decision === "delete").length;
    const relink = decisions.length - trash;
    if (decisions.length === 0) return;

    // Final confirmation, defaulting to Cancel.
    const ps = ztoolkit.getGlobal("Services").prompt;
    const ok = ps.confirmEx(
      win as any,
      getString("cleanup-title"),
      getString("cleanup-confirm", { args: { trash, relink } }),
      ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING +
        ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL +
        ps.BUTTON_POS_1_DEFAULT,
      getString("cleanup-btn-apply"),
      "",
      "",
      "",
      { value: false },
    );
    if (ok !== 0) return;

    const pw2 = newProgress();
    const summary = await cleanup.applyDecisions(api, decisions);
    pw2.changeLine({
      type: summary.failed ? "fail" : "success",
      progress: 100,
      text: getString("cleanup-done", {
        args: {
          trashed: summary.trashed,
          relinked: summary.relinked,
          failed: summary.failed,
        },
      }),
    });
    pw2.startCloseTimer(summary.failed ? 8000 : 5000);
    refreshStatusDots();
  } catch (e) {
    log("runCleanup error:", e);
    pw.changeLine({
      type: "fail",
      progress: 100,
      text: getString("sync-error", { args: { error: errMsg(e) } }),
    });
    pw.startCloseTimer(8000);
  }
}

/** Repaint item-tree status dots after a membership change. */
function refreshStatusDots(): void {
  for (const win of Zotero.getMainWindows()) {
    try {
      (win as any)?.ZoteroPane?.itemsView?.tree?.invalidate?.();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Per-window UI (toolbar button, Tools menu, context menu)
// ---------------------------------------------------------------------------

function makeMenuitem(
  doc: Document,
  suffix: string,
  label: string,
  onCommand: () => void,
): Element {
  const item = (doc as any).createXULElement("menuitem") as Element;
  item.id = `${ID}-${suffix}`;
  item.setAttribute("label", label);
  item.addEventListener("command", onCommand);
  return item;
}

function registerToolbarButton(win: Window): void {
  const doc = win.document;
  const toolbar = doc.getElementById("zotero-items-toolbar");
  if (!toolbar) return;

  // Constrain the button icon to 16px so it matches Zotero's own buttons.
  const style = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "style",
  ) as HTMLStyleElement;
  style.id = `${ID}-style`;
  style.textContent = `#${ID}-tb-syncnow .toolbarbutton-icon { width: 16px; height: 16px; }`;
  doc.documentElement?.appendChild(style);

  const btn = (doc as any).createXULElement("toolbarbutton") as Element;
  btn.id = `${ID}-tb-syncnow`;
  btn.setAttribute("class", "zotero-tb-button");
  btn.setAttribute("tooltiptext", getString("menuitem-sync-now"));
  btn.setAttribute("image", ICON);
  btn.addEventListener("command", () => void runSyncNow());
  toolbar.appendChild(btn);
}

function registerToolsMenu(win: Window): void {
  const doc = win.document;
  const toolsPopup = doc.getElementById("menu_ToolsPopup");
  if (!toolsPopup) return;
  // One "reMarkable" submenu instead of many prefixed items.
  const menu = (doc as any).createXULElement("menu") as Element;
  menu.id = `${ID}-tools-menu`;
  menu.setAttribute("label", getString("tools-menu"));
  const popup = (doc as any).createXULElement("menupopup") as Element;
  menu.appendChild(popup);
  const entries: [string, Parameters<typeof getString>[0], () => void][] = [
    ["tools-syncnow", "tools-sync-now", () => void runSyncNow()],
    ["tools-push", "tools-push", () => void runPush()],
    ["tools-forcepull", "tools-force-pull", () => void runForcePull()],
    ["tools-clearpulled", "tools-clear-pulled", () => void runClearPulled()],
    ["tools-cleanup", "tools-cleanup", () => void runCleanup(win)],
  ];
  for (const [suffix, label, run] of entries) {
    popup.appendChild(makeMenuitem(doc, suffix, getString(label), run));
  }
  toolsPopup.appendChild(menu);
}

function registerContextMenu(win: Window): void {
  const doc = win.document;
  const itemmenu = doc.getElementById("zotero-itemmenu");
  if (!itemmenu) return;

  const sep = (doc as any).createXULElement("menuseparator") as Element;
  sep.id = `${ID}-sep`;
  const addItem = makeMenuitem(
    doc,
    "add",
    getString("menuitem-add-to-sync"),
    () => {
      engine
        .addToSync(selectedRegularItems(win))
        .then(() => refreshStatusDots())
        .catch((e) => log("addToSync error:", e));
    },
  );
  const removeItem = makeMenuitem(
    doc,
    "remove",
    getString("menuitem-remove-from-sync"),
    () => {
      void runRemoveFromSync(win, selectedRegularItems(win));
    },
  );
  const ovrZotero = makeMenuitem(
    doc,
    "ovr-zotero",
    getString("menuitem-overwrite-from-zotero"),
    () => void runOverwriteFromZotero(selectedRegularItems(win)),
  );
  const ovrRemarkable = makeMenuitem(
    doc,
    "ovr-remarkable",
    getString("menuitem-overwrite-from-remarkable"),
    () => void runOverwriteFromRemarkable(selectedRegularItems(win)),
  );

  [sep, addItem, removeItem, ovrZotero, ovrRemarkable].forEach((n) =>
    itemmenu.appendChild(n),
  );

  const onShowing = () => {
    const items = selectedRegularItems(win);
    const anyUnsynced = items.some((i) => !engine.isItemSynced(i));
    const anySynced = items.some((i) => engine.isItemSynced(i));
    (addItem as any).hidden = !anyUnsynced;
    (removeItem as any).hidden = !anySynced;
    // Overwrite actions only make sense for already-synced items.
    (ovrZotero as any).hidden = !anySynced;
    (ovrRemarkable as any).hidden = !anySynced;
    (sep as any).hidden = items.length === 0;
  };
  itemmenu.addEventListener("popupshowing", onShowing);
  (itemmenu as any)[SHOWING_KEY] = onShowing;
}

export function registerWindowUI(win: Window): void {
  // Idempotent: drop any leftovers from a previous (hot-reloaded) instance.
  clearWindowUI(win);
  registerToolbarButton(win);
  registerToolsMenu(win);
  registerContextMenu(win);
}

export function unregisterWindowUI(win: Window): void {
  clearWindowUI(win);
}

/** Tear down per-window UI in every open main window. */
export function unregisterAllWindows(): void {
  for (const win of Zotero.getMainWindows()) {
    clearWindowUI(win as unknown as Window);
  }
}

// ---------------------------------------------------------------------------
// Item-pane status section
// ---------------------------------------------------------------------------

export function registerSection(): void {
  // Idempotent: a previous (hot-reloaded) instance may have left it registered.
  unregisterSection();
  Zotero.ItemPaneManager.registerSection({
    paneID: SECTION_ID,
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("item-section-remarkable-head-text"),
      icon: ICON,
    },
    sidenav: {
      l10nID: getLocaleID("item-section-remarkable-sidenav-tooltip"),
      icon: ICON,
    },
    onRender: ({ body, item, doc }) => renderSection(body, item, doc),
  });
}

export function unregisterSection(): void {
  try {
    Zotero.ItemPaneManager.unregisterSection(SECTION_ID);
  } catch {
    // not registered — fine
  }
}

function renderSection(
  body: HTMLDivElement,
  item: Zotero.Item,
  doc: Document,
): void {
  body.replaceChildren();
  if (!item?.isRegularItem()) return;

  // Guide the user to connect first.
  if (!client.isConnected()) {
    const hint = doc.createElement("div");
    hint.style.opacity = "0.8";
    hint.textContent = getString("status-not-connected");
    body.appendChild(hint);
    return;
  }

  const synced = engine.isItemSynced(item);

  const status = doc.createElement("div");
  status.style.marginBottom = "6px";
  status.textContent = synced
    ? getString("status-synced")
    : getString("status-not-synced");
  body.appendChild(status);

  const toggle = doc.createElement("button");
  toggle.textContent = synced
    ? getString("menuitem-remove-from-sync")
    : getString("menuitem-add-to-sync");
  toggle.addEventListener("click", async () => {
    try {
      if (synced) await runRemoveFromSync(doc.defaultView!, [item]);
      else await engine.addToSync([item]);
      renderSection(body, item, doc);
    } catch (e) {
      log("toggle sync error:", e);
    }
  });
  body.appendChild(toggle);

  // Split button: the main part syncs this item, the arrow offers forced
  // one-way runs (handy to try a change on a single paper).
  const group = doc.createElement("span");
  group.style.display = "inline-flex";
  group.style.marginInlineStart = "6px";
  const sync = doc.createElement("button");
  sync.textContent = getString("sync-now");
  sync.disabled = !synced;
  sync.style.borderStartEndRadius = "0";
  sync.style.borderEndEndRadius = "0";
  sync.addEventListener("click", () => void runSyncNow([item]));
  const more = doc.createElement("button");
  more.textContent = "▾";
  more.title = getString("sync-more-tooltip");
  more.disabled = !synced;
  more.style.borderStartStartRadius = "0";
  more.style.borderEndStartRadius = "0";
  more.style.marginInlineStart = "-1px";
  more.addEventListener("click", () => openSyncMenu(doc, more, item));
  group.append(sync, more);
  body.appendChild(group);
}

/** Drop-down of forced sync runs for one item, anchored to `anchor`. */
function openSyncMenu(doc: Document, anchor: Element, item: Zotero.Item): void {
  const popupId = `${ID}-pane-popup`;
  doc.querySelectorAll(`#${popupId}`).forEach((el: Element) => el.remove());
  const popup = (doc as any).createXULElement("menupopup") as any;
  popup.id = popupId;
  const win = doc.defaultView!;
  const entries: [string, () => void][] = [
    [getString("sync-now"), () => void runSyncNow([item])],
    [
      getString("sync-force-pull"),
      () => void runOverwriteFromRemarkable([item]),
    ],
    [getString("sync-force-push"), () => void runForcePush([item])],
  ];
  for (const [label, run] of entries) {
    const mi = (doc as any).createXULElement("menuitem") as Element;
    mi.setAttribute("label", label);
    mi.addEventListener("command", run);
    popup.appendChild(mi);
  }
  popup.addEventListener("popuphidden", (e: Event) => {
    if (e.target === popup) win.setTimeout(() => popup.remove(), 0);
  });
  (doc.getElementById("mainPopupSet") ?? doc.documentElement)!.appendChild(
    popup,
  );
  popup.openPopup(anchor, "after_end");
}
