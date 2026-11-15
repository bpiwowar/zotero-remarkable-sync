// rmapi-js's model of v6 `.rm` scene files: parse a page into its blocks,
// edit the blocks, serialize them back. Blocks we don't edit are written back
// byte for byte (test/rmscene.verify.mjs).
//
// Neither module is exported from the package entry, so they are imported by
// path.

import {
  rmBrushCode,
  rmColorCode,
} from "../../../node_modules/rmapi-js/dist/codes.js";

// rmapi-js rejects pen and colour codes outside its lists, and then keeps the
// whole item as an opaque block: the tablet's highlights in colours 14 and 15
// would be invisible to us. Accept any code until that is fixed upstream:
// https://github.com/erikbrinkman/rmapi-js/issues/137
for (const schema of [rmBrushCode, rmColorCode]) {
  (schema as any).parse = (code: number) => code;
}

export {
  parseRmScene,
  serializeRmScene,
  RmScene,
} from "../../../node_modules/rmapi-js/dist/rm6.js";
