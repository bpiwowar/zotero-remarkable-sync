import { assert } from "chai";
import { config } from "../package.json";

// Zotero 11 has several main windows, and several library tabs (each with its
// own items toolbar) per window. Our per-window UI must reach all of them.

const TB = `.${config.addonRef}-tb-syncnow`;
const TOOLBARS = ":is(#zotero-items-toolbar, .zotero-items-toolbar)";

async function waitFor(cond: () => boolean, timeout = 10000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("timed out");
    await Zotero.Promise.delay(100);
  }
}

function toolbarsWithoutButton(win: any): number {
  return [...win.document.querySelectorAll(TOOLBARS)].filter(
    (tb: Element) => !tb.querySelector(TB),
  ).length;
}

/**
 * Open a window's Tools menu (as far as Zotero's popupshowing handlers go) and
 * return our "reMarkable" submenu once its Fluent label has resolved.
 */
async function toolsSubmenu(
  win: any,
  check: (menu: any) => Promise<void> = async () => {},
): Promise<void> {
  const popup = win.document.getElementById("menu_ToolsPopup");
  popup.dispatchEvent(new win.Event("popupshowing"));
  let menu: any;
  await waitFor(() => {
    menu = [...popup.querySelectorAll(":scope > menu")].find(
      (m: any) => m.getAttribute("label") === "reMarkable",
    );
    return !!menu;
  });
  try {
    await check(menu);
  } finally {
    popup.dispatchEvent(new win.Event("popuphidden"));
  }
}

const multiTab = () =>
  typeof (Zotero.getMainWindow() as any).Zotero_Tabs?.addLibraryTab ===
  "function";

describe("windows and library tabs", function () {
  this.timeout(30000);

  it("adds the reMarkable submenu to Tools", async function () {
    const win = Zotero.getMainWindow() as any;
    let labels: string[] = [];
    await toolsSubmenu(win, async (menu) => {
      // MenuManager fills a submenu when it opens (while Tools is open).
      const popup = menu.querySelector(":scope > menupopup");
      popup.dispatchEvent(new win.Event("popupshowing"));
      const items = () =>
        [...popup.querySelectorAll("menuitem")].map((m: any) =>
          m.getAttribute("label"),
        );
      await waitFor(() => items().filter(Boolean).length === 5);
      labels = items();
      popup.dispatchEvent(new win.Event("popuphidden"));
    });
    assert.include(labels, "Sync now");
  });

  it("adds the toolbar button to the main window", function () {
    const win = Zotero.getMainWindow() as any;
    assert.isAbove(win.document.querySelectorAll(TB).length, 0);
    assert.equal(toolbarsWithoutButton(win), 0);
  });

  it("adds the toolbar button to a new library tab (Zotero 11)", async function () {
    if (!multiTab()) this.skip();
    const win = Zotero.getMainWindow() as any;
    const before = win.document.querySelectorAll(TOOLBARS).length;
    const id = win.Zotero_Tabs.addLibraryTab({ select: true });
    try {
      await waitFor(
        () => win.document.querySelectorAll(TOOLBARS).length > before,
      );
      await waitFor(() => toolbarsWithoutButton(win) === 0);
      assert.equal(win.document.querySelectorAll(TB).length, before + 1);
    } finally {
      win.Zotero_Tabs.close(id);
    }
  });

  it("sets up a second main window and survives it closing (Zotero 11)", async function () {
    if (!multiTab()) this.skip();
    const first = Zotero.getMainWindow() as any;
    const count = Zotero.getMainWindows().length;
    (Zotero as any).openMainWindow();
    await waitFor(() => Zotero.getMainWindows().length > count);
    const second = Zotero.getMainWindows().find((w) => w !== first) as any;
    await waitFor(() => second.document.querySelectorAll(TB).length > 0);
    await toolsSubmenu(second);
    second.close();
    await waitFor(() => Zotero.getMainWindows().length === count);
    // Closing one window must leave the others' UI in place.
    await toolsSubmenu(first);
    assert.equal(toolbarsWithoutButton(first), 0);
  });

  it("adds the Tools submenu to a window without a library tab (Zotero 11)", async function () {
    if (!multiTab()) this.skip();
    const note = new Zotero.Item("note");
    note.setNote("<p>Window test</p>");
    await note.saveTx();
    const before = new Set(Zotero.getMainWindows());
    try {
      await (Zotero as any).Notes.open(note.id, null, { openInWindow: true });
      let win: any;
      await waitFor(() => {
        win = Zotero.getMainWindows().find((w) => !before.has(w));
        return !!win?.document.getElementById("menu_ToolsPopup");
      });
      try {
        assert.isNotOk(win.ZoteroPane?.libraryView, "note-only window");
        await toolsSubmenu(win);
      } finally {
        win.close();
      }
    } finally {
      await note.eraseTx();
    }
  });
});
