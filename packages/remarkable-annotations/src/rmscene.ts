// rmapi-js's model of v6 `.rm` scene files: parse a page into its blocks,
// edit the blocks, serialize them back. Blocks we don't edit are written back
// byte for byte (test/rmscene.verify.mjs). Since rmapi-js 14.4.2, any pen and
// colour code is accepted (the tablet's highlights in colours 14 and 15 among
// them).
//
// The module is not exported from the package entry, so it is imported by
// path (from the workspace root's node_modules, where npm hoists rmapi-js).
// Publishing this package would need it exported upstream first.

export {
  parseRmScene,
  serializeRmScene,
  RmScene,
} from "../../../node_modules/rmapi-js/dist/rm6.js";
