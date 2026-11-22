import { initLocale } from "./utils/locale";
import {
  registerPrefPane,
  registerPrefsScripts,
} from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { log, errMsg } from "./utils/log";
import * as ui from "./modules/ui";
import * as scheduler from "./modules/scheduler";
import * as engine from "./modules/sync/engine";
import * as column from "./modules/column";
import { preload as preloadState } from "./modules/sync/state";
import { loadAnnotations } from "./modules/remarkable/wasm";

// Build marker — bump when shipping a build you want to confirm is loaded.
const BUILD = "v0.7.0";

let notifierID: string | null = null;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  log(`reMarkable Sync loaded — build ${BUILD}`);
  initLocale();

  // The annotation library (WebAssembly): needed before any sync.
  try {
    await loadAnnotations();
  } catch (e) {
    log(`reMarkable Sync: cannot load the annotation library: ${errMsg(e)}`);
  }

  // Register the Settings pane and the item-pane status section (both global,
  // registered once — not per window).
  await registerPrefPane();
  ui.registerSection();
  await preloadState(); // so the status indicator can read sync state synchronously
  scheduler.start();

  // Watch for items being trashed/deleted so we can remove them from the device.
  notifierID = Zotero.Notifier.registerObserver(
    {
      notify: (event, type, ids, extraData) =>
        addon.hooks.onNotify(event, type, ids as any, extraData),
    },
    ["item"],
    addon.data.config.addonRef,
  );

  // Surface otherwise-silent "Uncaught (in promise)" rejections so we can see
  // their reason (and whether they originate here at all).
  try {
    Zotero.getMainWindow()?.addEventListener("unhandledrejection", (e: any) => {
      try {
        log("unhandledrejection:", errMsg(e?.reason) || String(e?.reason));
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // Register this window's UI: toolbar button, Tools menu, context menu.
  ui.registerWindowUI(win);
  // Attach the status dot to this window's item tree (prototype is shared, so
  // this is idempotent across windows).
  column.registerColumn(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ui.unregisterWindowUI(win);
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  scheduler.stop();
  column.unregisterColumn();
  if (notifierID) {
    Zotero.Notifier.unregisterObserver(notifierID);
    notifierID = null;
  }
  ui.unregisterAllWindows();
  ui.unregisterSection();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * Dispatcher for Notify events. Hooks only dispatch; real work lives in modules.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  if (type !== "item") return;

  // Repaint the status dot when annotations are added/edited/removed so a synced
  // item flips to "changed" without waiting for the next render. On delete/trash
  // the items are already gone, so we can't introspect them — just repaint.
  if (event === "add" || event === "modify") {
    const touchedAnnotation = ids.some((id) => {
      const it = Zotero.Items.get(Number(id));
      return it ? (it as any).isAnnotation?.() : false;
    });
    if (touchedAnnotation) column.refresh();
  } else if (event === "delete" || event === "trash") {
    column.refresh();
  }

  // Only a permanent deletion unsyncs: an item in the trash can be restored,
  // and sync skips it meanwhile.
  if (event !== "delete") return;

  // Collect the keys of affected attachments (records are keyed by attachment).
  const keys = new Set<string>();
  for (const id of ids) {
    const item = Zotero.Items.get(Number(id));
    if (item) {
      keys.add(item.key);
      if (item.isRegularItem()) {
        for (const aid of item.getAttachments(true)) {
          const att = Zotero.Items.get(aid);
          if (att) keys.add(att.key);
        }
      }
    } else if (extraData?.[id]?.key) {
      keys.add(extraData[id].key);
    }
  }
  if (keys.size === 0) return;

  engine.unsyncByKeys([...keys]).catch((e) => log("unsync (notify) error:", e));
}

/**
 * Dispatcher for Preference UI events.
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

function onShortcuts(_type: string) {}

function onDialogEvents(_type: string) {}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
