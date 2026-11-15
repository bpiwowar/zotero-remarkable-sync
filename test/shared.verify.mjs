// Multi-computer sync building blocks: Zotero keys as author uuids, items
// written under their own author, and the shared state note round-trip.
//
// Run via `npm run test:shared` (bundles first).

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { keyToUuid, uuidToKey, keyedAuthors } = await import(
  join(root, ".scaffold/zkey.mjs")
);
const { parseRmPage } = await import(join(root, ".scaffold/annotations.mjs"));
const { rebuildPage, blankStructure } = await import(
  join(root, ".scaffold/annotations.mjs")
);
const { noteWith, parseNote } = await import(join(root, ".scaffold/state.mjs"));

// --- keys <-> uuids ---------------------------------------------------------
for (const key of [
  "ABCD2345",
  "22222222",
  "ZZZZZZZZ",
  "N7QK3XPM",
  "IIIIIIII",
]) {
  const uuid = keyToUuid(key);
  assert.match(uuid, /^7a6f7472-656d-8000-8000-[0-9a-f]{12}$/);
  assert.equal(uuidToKey(uuid), key);
}
assert.equal(keyToUuid("abcd2345"), null, "lower case is not a Zotero key");
assert.equal(keyToUuid("ABCD1234"), null, "1 is not in the alphabet");
assert.equal(keyToUuid("ABCDO234"), null, "O is not in the alphabet");
assert.equal(uuidToKey("d01ed883-3136-815b-9290-e1c9f940f74e"), null);
assert.equal(uuidToKey("79736d72-636e-1000-8000-000000000001"), null);

// --- items under their own author ------------------------------------------
const blank = blankStructure();
const stroke = (y) => ({
  tool: 17,
  colorIndex: 0,
  thickness: 2,
  pointWidth: 16,
  isHighlighter: false,
  points: [
    { x: 0, y },
    { x: 10, y: y + 1 },
  ],
});
const register = new Map([
  [2, keyToUuid("ABCD2345")],
  [3, keyToUuid("WXYZ6789")],
]);
const out = rebuildPage(
  blank.structure,
  [stroke(1), stroke(2)],
  [],
  new Set(),
  {
    ...blank,
    authors: [2, 3],
    register,
  },
);
assert.deepEqual(
  out.ids.map((i) => i.part1),
  [2, 3],
);
assert.ok(
  out.ids.every((i) => i.part2 >= blank.startCounter),
  "counters above the page's",
);
const page = parseRmPage(out.bytes);
const byAuthor = keyedAuthors(page.authors);
assert.equal(byAuthor.get(2), "ABCD2345");
assert.equal(byAuthor.get(3), "WXYZ6789");
assert.equal(page.authors.get(blank.author), blank.authors.get(blank.author));
assert.deepEqual(
  page.strokes.map((s) => byAuthor.get(s.ids[0].part1)),
  ["ABCD2345", "WXYZ6789"],
);
// A later rewrite reuses the registered authors and counts above every item.
const again = rebuildPage(out.bytes, [stroke(3)], [], new Set(), {
  layerId: page.layerId,
  lastItemId: page.lastItemId,
  author: blank.author,
  startCounter: page.maxCounter + 1,
  authors: [3],
});
const page2 = parseRmPage(again.bytes);
assert.equal(page2.authors.size, 3);
assert.equal(again.ids[0].part1, 3);
assert.ok(again.ids[0].part2 > page.maxCounter);

// --- shared state note (in the attachment's own note) -----------------------
const { encodePayload, decodePayload, parseBlock } = await import(
  join(root, ".scaffold/state.mjs")
);
const record = {
  docId: "00000000-0000-4000-8000-000000000001",
  docHash: "h",
  fileHash: "f",
  visibleName: 'A <title> & "quotes" — ünïcode',
  lastPushed: 1,
  annotationKeys: ["AAAAAAAA"],
  annotationSigs: { AAAAAAAA: "highlight|0|10|20|some text" },
};
const p = { key: "ATTKEY23", record };

// The payload is Braille only: no typed query can match it.
const payload = await encodePayload(p);
assert.match(payload, /^[\u2800-\u28ff]+$/);
assert.ok(!/highlight|page|[a-z]{3}/i.test(payload));
assert.deepEqual(await decodePayload(payload), p);
assert.equal(await decodePayload(payload.slice(0, -5)), null, "truncated");
assert.equal(await decodePayload("remarkableSync"), null);

// A blank note gets just our block.
const fresh = await noteWith("", p);
assert.match(fresh, /Do not edit below this line/);
assert.deepEqual(await parseBlock(fresh), p);
assert.deepEqual(await parseNote(fresh), record);

// The user's text is kept, before our block, inside the editor's wrapper.
const user =
  '<div data-schema-version="9"><p>My own note on this PDF.</p></div>';
const both = await noteWith(user, p);
assert.ok(both.startsWith('<div data-schema-version="9"><p>My own note'));
assert.ok(both.endsWith("</pre></div>"));
assert.deepEqual(await parseNote(both), record);

// Text typed before and after the block stays in place on update.
const around = both.replace("</pre></div>", "</pre><p>Typed after.</p></div>");
const changed = { key: p.key, record: { ...record, docHash: "h2" } };
const updated = await noteWith(around, changed);
assert.equal((updated.match(/<pre>/g) ?? []).length, 1);
assert.equal((updated.match(/<h2>/g) ?? []).length, 1);
assert.ok(updated.indexOf("My own note") < updated.indexOf("<h2>"));
assert.ok(updated.indexOf("</pre>") < updated.indexOf("Typed after."));
assert.deepEqual(await parseBlock(updated), changed);

// Removing gives the user's text back; nothing left means an empty note.
assert.equal(await noteWith(both, null), user);
assert.equal(
  await noteWith(around, null),
  '<div data-schema-version="9"><p>My own note on this PDF.</p><p>Typed after.</p></div>',
);
assert.equal(await noteWith(fresh, null), "", "nothing left: empty note");

// As the note editor may rewrite it: <code> inside <pre>, line breaks.
const edited = both
  .replace("<pre>", '<pre class="x"><code>')
  .replace("</pre>", "</code></pre>")
  .replace(/(<code>[\u2800-\u28ff]{40})/, "$1\n");
assert.deepEqual(await parseNote(edited), record);
assert.equal(await noteWith(edited, null), user);
assert.equal(await parseNote("<p>remarkable sync is mentioned</p>"), null);

console.log("✓ shared sync: key uuids, keyed authors, state note");
