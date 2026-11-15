// Polyfills for language features rmapi-js (v14+) uses that Zotero's Gecko
// (Firefox 115 ESR for Zotero 7) lacks. Must be imported before anything that
// imports rmapi-js: its classes define `[Symbol.asyncDispose]` methods when the
// module is evaluated.

const S = Symbol as any;
// Same fallback esbuild's and TypeScript's `using` helpers look up.
if (!S.asyncDispose) S.asyncDispose = Symbol.for("Symbol.asyncDispose");
if (!S.dispose) S.dispose = Symbol.for("Symbol.dispose");

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL = B64.slice(0, 62) + "-_";

interface Base64Options {
  alphabet?: "base64" | "base64url";
  omitPadding?: boolean;
  lastChunkHandling?: "loose" | "strict" | "stop-before-partial";
}

const U8 = Uint8Array as any;

if (typeof U8.prototype.toBase64 !== "function") {
  U8.prototype.toBase64 = function (
    this: Uint8Array,
    opts: Base64Options = {},
  ): string {
    const chars = opts.alphabet === "base64url" ? B64URL : B64;
    let out = "";
    for (let i = 0; i < this.length; i += 3) {
      const n =
        (this[i] << 16) | ((this[i + 1] ?? 0) << 8) | (this[i + 2] ?? 0);
      const left = this.length - i;
      out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63];
      out += left > 1 ? chars[(n >> 6) & 63] : opts.omitPadding ? "" : "=";
      out += left > 2 ? chars[n & 63] : opts.omitPadding ? "" : "=";
    }
    return out;
  };
}

if (typeof U8.fromBase64 !== "function") {
  U8.fromBase64 = function (text: string, opts: Base64Options = {}) {
    const chars = opts.alphabet === "base64url" ? B64URL : B64;
    const clean = text.replace(/[\s=]/g, "");
    const out: number[] = [];
    let bits = 0;
    let acc = 0;
    for (const c of clean) {
      const v = chars.indexOf(c);
      if (v < 0) throw new SyntaxError(`invalid base64 character "${c}"`);
      acc = ((acc << 6) | v) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((acc >> bits) & 0xff);
      }
    }
    return new Uint8Array(out);
  };
}

export {};
