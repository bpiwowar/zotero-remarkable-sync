// Loads the remarkable-annotations WebAssembly module, shipped in the plugin
// as content/wasm/remarkable_annotations_wasm_bg.wasm (copied there by the
// build, see zotero-plugin.config.ts).

import { config } from "../../../package.json";
import { initAnnotations } from "./annotations";

export const WASM_URL = `chrome://${config.addonRef}/content/wasm/remarkable_annotations_wasm_bg.wasm`;

/** Fetch the module's bytes from the plugin and initialise it. */
export async function loadAnnotations(): Promise<void> {
  const resp = await fetch(WASM_URL);
  initAnnotations(new Uint8Array(await resp.arrayBuffer()));
}
