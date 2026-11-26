import { ZoteroToolkit } from "zotero-plugin-toolkit/ztoolkit";
import { config } from "../../package.json";

export { createZToolkit };

function createZToolkit() {
  const _ztoolkit = new ZoteroToolkit();
  /**
   * Alternatively, import toolkit modules you use to minify the plugin size.
   * You can add the modules under the `MyToolkit` class below and uncomment the following line.
   */
  // const _ztoolkit = new MyToolkit();
  initZToolkit(_ztoolkit);
  return _ztoolkit;
}

function initZToolkit(_ztoolkit: ReturnType<typeof createZToolkit>) {
  _ztoolkit.basicOptions.log.prefix = `[${config.addonName}]`;
  // Always disable the toolkit console logger: on Zotero 9 it initialises a
  // ConsoleAPI via the removed `ChromeUtils.import`, which throws. We log via
  // src/utils/log.ts (Zotero.debug) instead.
  _ztoolkit.basicOptions.log.disableConsole = true;
  _ztoolkit.UI.basicOptions.ui.enableElementJSONLog = __env__ === "development";
  _ztoolkit.UI.basicOptions.ui.enableElementDOMLog = __env__ === "development";
  // Toolkit 6 no longer registers the zotero://ztoolkit-debug and
  // zotero://plugin handlers; never call DebugBridge.register() in shipped
  // builds (issue #12).
  _ztoolkit.basicOptions.api.pluginID = config.addonID;
  _ztoolkit.ProgressWindow.setIconURI(
    "default",
    `chrome://${config.addonRef}/content/icons/favicon.png`,
  );
}

import { BasicTool, unregister } from "zotero-plugin-toolkit";
import { UITool } from "zotero-plugin-toolkit";

class MyToolkit extends BasicTool {
  UI: UITool;

  constructor() {
    super();
    this.UI = new UITool(this);
  }

  unregisterAll() {
    unregister(this);
  }
}
