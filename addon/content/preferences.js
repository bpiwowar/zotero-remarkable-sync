/* global Zotero, window, document */
// Preference pane script (registered via PreferencePanes `scripts`), replacing
// an inline onload handler: Zotero 11's chrome CSP will block inline handlers.
// Zotero runs this before inserting the pane, then dispatches a non-bubbling
// "load" event on the pane's root element. A capturing listener sees it on the
// document (Gecko does not propagate element load events up to the window).
document.addEventListener(
  "load",
  (event) => {
    if (event.target?.id === "zotero-prefpane-__addonRef__-root") {
      Zotero.__addonInstance__?.hooks.onPrefsEvent("load", { window });
    }
  },
  true,
);
