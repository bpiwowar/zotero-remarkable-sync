import { assert } from "chai";
import { config } from "../package.json";

// The pane's load hook runs from content/preferences.js (no inline onload
// handler, which Zotero 11's chrome CSP is going to block).
describe("preferences pane", function () {
  this.timeout(30000);

  it("runs the load hook when the pane opens", async function () {
    const pane = (Zotero.PreferencePanes as any).pluginPanes.find(
      (p: any) => p.pluginID === config.addonID,
    );
    assert.isOk(pane, "pane registered");
    const win = (Zotero.Utilities.Internal as any).openPreferences(pane.id);
    try {
      const status = () =>
        win.document?.getElementById(
          `zotero-prefpane-${config.addonRef}-status`,
        );
      const start = Date.now();
      // The hook replaces the Fluent placeholder with the actual status text.
      while (!status() || status().hasAttribute("data-l10n-id")) {
        if (Date.now() - start > 15000) throw new Error("load hook not run");
        await Zotero.Promise.delay(100);
      }
      assert.isNotEmpty(status().textContent);
    } finally {
      win.close();
    }
  });
});
