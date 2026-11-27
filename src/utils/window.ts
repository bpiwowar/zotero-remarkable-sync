export { isWindowAlive, liveMainWindow, libraryViews, allItemsViews };

/**
 * Check if the window is alive.
 * Useful to prevent opening duplicate windows.
 * @param win
 */
function isWindowAlive(win?: Window) {
  return win && !Components.utils.isDeadWrapper(win) && !win.closed;
}

/**
 * A main window that is still open. Zotero 11 has several main windows, any of
 * which may close while others stay open (and on macOS Zotero runs with none),
 * so never cache a window across calls: a closed one becomes a dead wrapper.
 */
function liveMainWindow(): any {
  const win = Zotero.getMainWindow() as any;
  if (isWindowAlive(win)) return win;
  return (Zotero.getMainWindows() as any[]).find((w) => isWindowAlive(w));
}

/**
 * The library views of a main window. Zotero 11 has one per library tab
 * (`ZoteroPane.libraryViews`); earlier versions have a single, implicit one,
 * which `ZoteroPane` itself stands in for (it has `itemsView` and the
 * document holds the elements under their base ids).
 */
function libraryViews(win: any): any[] {
  const pane = win?.ZoteroPane;
  if (!pane) return [];
  if (Array.isArray(pane.libraryViews)) return pane.libraryViews;
  return [pane];
}

/** Every items tree in every open main window. */
function allItemsViews(): any[] {
  const views: any[] = [];
  for (const win of Zotero.getMainWindows()) {
    for (const view of libraryViews(win)) {
      if (view?.itemsView) views.push(view.itemsView);
    }
  }
  return views;
}
