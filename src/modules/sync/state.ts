// Mapping between Zotero PDF attachments and reMarkable documents, keyed by
// the attachment item key.
//
// The records are shared between computers through Zotero sync: each synced
// PDF attachment's own note holds its record as JSON, in a block below any
// text the user wrote there. `state.json` in the Zotero data directory is a
// local cache of those notes, so the status column can read records
// synchronously.
//
// The notes are authoritative: `refreshShared()` (run at the start of every
// sync) reloads every note into the cache. A state.json from before the notes
// existed (v1: a bare record map) is migrated into notes once.

import { log, errMsg } from "../../utils/log";

export interface SyncRecord {
  /** reMarkable document id (uuid4) */
  docId: string;
  /** reMarkable document hash at last push */
  docHash: string;
  /** sha-256 of the PDF bytes last pushed (hex) — guards against re-upload */
  fileHash: string;
  /** name shown on the device */
  visibleName: string;
  /** Zotero library the attachment lives in (defaults to user library) */
  libraryID?: number;
  /** epoch ms of last successful push */
  lastPushed: number;
  /** reMarkable doc hash after our last page write: a pull reading that
   *  version knows the device has not changed anything since */
  pushedVersion?: string;
  /** reMarkable doc hash last pulled (skip pull when unchanged) */
  lastPulledVersion?: string;
  /** keys of annotations created on the last pull (for idempotent re-pull) */
  annotationKeys?: string[];
  /** content signature of each annotationKeys entry, so a pulled annotation
   *  later deleted in Zotero can be added to deletedSigs */
  annotationSigs?: Record<string, string>;
  /** device items each annotationKeys entry was built from, so deleting the
   *  annotation in Zotero can delete them on the device */
  annotationSources?: Record<string, PulledSource>;
  /** keys of Zotero annotations already pushed to the device (avoid re-push) */
  pushedKeys?: string[];
  /** Zotero annotations pushed to the device + the reMarkable item ids assigned,
   *  so we can tombstone them on the device when deleted in Zotero */
  pushedItems?: PushedItem[];
  /** signatures of annotations deleted in Zotero, so pull won't re-create them */
  deletedSigs?: string[];
  /** device page tags at the last pull, by PDF page index — the baseline to
   *  tell a tag removed in Zotero from one added on the device */
  pageTags?: Record<string, string[]>;
  /** linked to a document found on the device by its PDF hash, with no
   *  shared record: the annotation push waits for the first pull */
  adopted?: boolean;
}

export interface PulledSource {
  /** reMarkable page uuid */
  page: string;
  /** scene item ids ([part1, part2] each) */
  ids: [number, number][];
}

export interface PushedItem {
  /** Zotero annotation key */
  key: string;
  /** reMarkable page uuid the items were written to */
  page: string;
  /** assigned reMarkable item ids ([part1, part2] each) */
  ids: [number, number][];
  /** content signature, to suppress re-pull if deleted */
  sig?: string;
  /** pushFingerprint() when pushed — a change means the annotation was edited */
  rev?: string;
  /** written under the annotation's own author (zkey.ts), so any computer can
   *  tell which annotation the items belong to; false when the page had no
   *  free author id, unset when written by a version before 0.4 */
  keyed?: boolean;
}

type StateMap = Record<string, SyncRecord>;

/** state.json, version 2: a cache of the shared notes. */
interface CacheFile {
  version: 2;
  records: StateMap;
  /** when this computer last synced each attachment (epoch ms); local only,
   *  so a sync with nothing to do doesn't rewrite the shared notes */
  synced?: Record<string, number>;
}

const IO = globalThis as any;

let cache: StateMap | null = null;
let synced: Record<string, number> = {};

function stateDir(): string {
  return IO.PathUtils.join(Zotero.DataDirectory.dir, "remarkablesync");
}

function stateFile(): string {
  return IO.PathUtils.join(stateDir(), "state.json");
}

// --- Shared notes ------------------------------------------------------------
//
// The record is stored deflated and written as Braille characters, one per
// byte. Zotero's quick search matches note text, and no typed query matches
// Braille, so the notes don't turn up in searches. The local state.json keeps
// a readable copy.

/** Starts our block ("rmsync" in Braille); also how our notes are found. */
const MARKER = "\u2817\u280d\u280e\u283d\u281d\u2809";
/** Then one character for the encoding: deflate-raw, or plain JSON bytes. */
const DEFLATED = "\u2801";
const PLAIN = "\u2800";
/** Marker of the 0.4 development build's child notes (plain JSON). */
const LEGACY_MARKER = "remarkableSync";
const HEADING = "reMarkable sync";

const unescapeHtml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

function streams(): { C?: any; D?: any } {
  const g = globalThis as any;
  const win = g.Zotero?.getMainWindow?.();
  return {
    C: g.CompressionStream ?? win?.CompressionStream,
    D: g.DecompressionStream ?? win?.DecompressionStream,
  };
}

async function pipe(bytes: Uint8Array, transform: any): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  // Errors (corrupt input) surface through the reader below.
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const reader = transform.readable.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const toBraille = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => String.fromCharCode(0x2800 + b)).join("");

function fromBraille(text: string): Uint8Array | null {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i) - 0x2800;
    if (c < 0 || c > 255) return null;
    out[i] = c;
  }
  return out;
}

/** What a block holds: the record, and the attachment it belongs to. */
export interface Payload {
  /** attachment key (so a block moved to another note can be put back) */
  key?: string;
  record: SyncRecord;
}

/** Encode a block's payload (marker included). */
export async function encodePayload(p: Payload): Promise<string> {
  const json = JSON.stringify({ a: p.key, r: p.record });
  const bytes = new TextEncoder().encode(json);
  const { C } = streams();
  if (C) {
    try {
      return (
        MARKER + DEFLATED + toBraille(await pipe(bytes, new C("deflate-raw")))
      );
    } catch {
      /* fall back to plain bytes */
    }
  }
  return MARKER + PLAIN + toBraille(bytes);
}

/** Decode a block's payload, or null if it is not a valid one. */
export async function decodePayload(text: string): Promise<Payload | null> {
  const t = text.replace(/\s+/g, "");
  if (!t.startsWith(MARKER)) return null;
  const flag = t[MARKER.length];
  let bytes = fromBraille(t.slice(MARKER.length + 1));
  if (!bytes) return null;
  try {
    if (flag === DEFLATED) {
      const { D } = streams();
      if (!D) return null;
      bytes = await pipe(bytes, new D("deflate-raw"));
    } else if (flag !== PLAIN) {
      return null;
    }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    const record = data?.r;
    if (typeof record?.docId !== "string") return null;
    return { key: typeof data.a === "string" ? data.a : undefined, record };
  } catch {
    return null;
  }
}

/** Our block: a heading, a warning, and the encoded payload. */
async function blockHtml(p: Payload): Promise<string> {
  return (
    `<h2>${HEADING}</h2>` +
    `<p>Do not edit below this line.</p>` +
    `<pre>${await encodePayload(p)}</pre>`
  );
}

interface Block extends Payload {
  /** span in the note's HTML, our heading and warning included */
  start: number;
  end: number;
}

/**
 * Our blocks in a note: each <pre> holding a valid payload, extended back to
 * our heading when only our warning lies between them. Anything else in the
 * note (before, between or after) is the user's.
 */
async function ourBlocks(html: string): Promise<Block[]> {
  const out: Block[] = [];
  for (const m of html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)) {
    if (!m[1].includes(MARKER)) continue;
    // The note editor may wrap the text in tags (e.g. <code>).
    const payload = await decodePayload(
      unescapeHtml(m[1].replace(/<[^>]+>/g, "")),
    );
    if (!payload) continue;
    const before = html.slice(out.at(-1)?.end ?? 0, m.index!);
    const head = before.lastIndexOf(`>${HEADING}</h`);
    const open = head < 0 ? -1 : before.lastIndexOf("<h", head);
    const between = head < 0 ? "" : before.slice(head + HEADING.length + 1);
    const ours = open >= 0 && !/<pre|<h\d|<img/.test(between.slice(3));
    const offset = out.at(-1)?.end ?? 0;
    out.push({
      ...payload,
      start: ours ? offset + open : m.index!,
      end: m.index! + m[0].length,
    });
  }
  return out;
}

/** The first payload in a note, or null if it has none. */
export async function parseBlock(html: string): Promise<Payload | null> {
  const b = (await ourBlocks(html))[0];
  return b ? { key: b.key, record: b.record } : null;
}

/** The record held by a note, or null if it has none. */
export async function parseNote(html: string): Promise<SyncRecord | null> {
  return (await parseBlock(html))?.record ?? null;
}

/** True if a note's HTML holds no visible text or image. */
const isBlank = (html: string) =>
  !/<img/i.test(html) &&
  unescapeHtml(html.replace(/<[^>]+>/g, "")).trim() === "";

/**
 * The note with our block set to `p`, or removed when null. An existing block
 * is replaced where it stands; otherwise the block goes at the end. The rest
 * of the note is kept as is; a note left with nothing but our block's
 * leftovers becomes empty.
 */
export async function noteWith(
  html: string,
  p: Payload | null,
): Promise<string> {
  const blocks = await ourBlocks(html);
  const block = p ? await blockHtml(p) : "";
  let out = html;
  blocks.reverse().forEach((b, i) => {
    // The first block (last in this reversed walk) takes the new one.
    const put = i === blocks.length - 1 ? block : "";
    out = out.slice(0, b.start) + put + out.slice(b.end);
  });
  if (!p) return isBlank(out) ? "" : out;
  if (blocks.length) return out;
  if (isBlank(out)) return `<div data-schema-version="9">${block}</div>`;
  // Keep the note editor's wrapper around everything.
  const close = out.lastIndexOf("</div>");
  if (/^\s*<div data-schema-version/.test(out) && close >= 0) {
    return out.slice(0, close) + block + out.slice(close);
  }
  return out + block;
}

function attachmentOf(key: string, rec: SyncRecord): Zotero.Item | null {
  const att = Zotero.Items.getByLibraryAndKey(
    rec.libraryID ?? Zotero.Libraries.userLibraryID,
    key,
  );
  return (att as Zotero.Item) || null;
}

/** Write `record` (or its removal) into the attachment's note. */
async function writeNote(
  key: string,
  rec: SyncRecord,
  record: SyncRecord | null,
): Promise<void> {
  try {
    const att = attachmentOf(key, rec);
    if (!att || att.deleted) return;
    const html = att.getNote();
    const current = await parseBlock(html);
    if (
      JSON.stringify(current?.record ?? null) === JSON.stringify(record) &&
      (!record || current?.key === key)
    )
      return; // unchanged
    att.setNote(await noteWith(html, record ? { key, record } : null));
    await att.saveTx({ skipSelect: true });
  } catch (e) {
    log(`state: could not write the sync note of ${key}: ${errMsg(e)}`);
  }
}

/** The record of every attachment note holding one, in editable libraries. */
async function readAllNotes(): Promise<StateMap> {
  const out: StateMap = {};
  for (const lib of Zotero.Libraries.getAll().filter((l) => l.editable)) {
    const search = new Zotero.Search();
    (search as any).libraryID = lib.libraryID;
    search.addCondition("note", "contains", MARKER);
    for (const att of Zotero.Items.get(await search.search())) {
      if (!att.isAttachment() || att.deleted) continue;
      const record = await parseNote(att.getNote());
      // A record always names its library (an old one may not).
      if (record) out[att.key] = { ...record, libraryID: lib.libraryID };
    }
  }
  return out;
}

/** The records of a 0.4 development build child note (plain JSON), if any. */
function legacyRecords(html: string): StateMap | null {
  for (const m of html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)) {
    try {
      const data = JSON.parse(unescapeHtml(m[1].replace(/<[^>]+>/g, "")));
      if (data?.[LEGACY_MARKER] && data.records) return data.records;
    } catch {
      /* not ours */
    }
  }
  return null;
}

/** Put a record back into its attachment's note, unless that has one. */
async function reclaim(
  libraryID: number,
  key: string,
  record: SyncRecord,
): Promise<void> {
  const rec = { ...record, libraryID };
  const att = attachmentOf(key, rec);
  if (!att || att.deleted || (await parseNote(att.getNote()))) return;
  await writeNote(key, rec, rec);
  if (cache) cache[key] = rec;
  log(`state: put the sync record of ${key} back into its note`);
}

/**
 * Put back into the attachments' notes the blocks found in regular notes, and
 * remove them there:
 *  - Zotero's "Migrate to Item Note" moves an attachment's note, our block
 *    included, into a new note related to the attachment;
 *  - the 0.4 development build kept one child note per item.
 * The rest of such a note is the user's and is kept; a note left empty is
 * erased. An attachment whose note already holds a block keeps it.
 */
async function reclaimFromNotes(): Promise<void> {
  for (const lib of Zotero.Libraries.getAll().filter((l) => l.editable)) {
    const ids = new Set<number>();
    for (const marker of [MARKER, LEGACY_MARKER]) {
      const search = new Zotero.Search();
      (search as any).libraryID = lib.libraryID;
      search.addCondition("itemType", "is", "note");
      search.addCondition("note", "contains", marker);
      for (const id of await search.search()) ids.add(id);
    }
    for (const note of Zotero.Items.get([...ids])) {
      if (note.deleted) continue;
      try {
        const html = note.getNote();
        const legacy = legacyRecords(html);
        if (legacy) {
          for (const [key, rec] of Object.entries(legacy))
            await reclaim(lib.libraryID, key, rec);
          await note.eraseTx();
          continue;
        }
        const blocks = await ourBlocks(html);
        if (!blocks.length) continue;
        // A block without its key (unlikely) goes to the related attachment.
        const related = note.relatedItems
          .map((k) => Zotero.Items.getByLibraryAndKey(lib.libraryID, k))
          .filter((it): it is Zotero.Item => !!it && it.isAttachment());
        for (const b of blocks) {
          const key = b.key ?? (related.length === 1 ? related[0].key : null);
          if (!key) {
            log(`state: note ${note.key} holds a sync block of unknown PDF`);
            continue;
          }
          await reclaim(lib.libraryID, key, b.record);
        }
        const rest = await noteWith(html, null);
        if (isBlank(rest)) {
          await note.eraseTx();
        } else {
          note.setNote(rest);
          await note.saveTx({ skipSelect: true });
        }
      } catch (e) {
        log(`state: could not reclaim sync note ${note.key}: ${errMsg(e)}`);
      }
    }
  }
}

// --- Cache file ----------------------------------------------------------------

async function readCacheFile(): Promise<{ records: StateMap; v1: boolean }> {
  try {
    const data = JSON.parse(await IO.IOUtils.readUTF8(stateFile()));
    if (data?.version === 2) {
      synced = data.synced ?? {};
      return { records: data.records ?? {}, v1: false };
    }
    return { records: data ?? {}, v1: true };
  } catch {
    // Missing or unreadable file → start empty.
    return { records: {}, v1: false };
  }
}

async function persist(): Promise<void> {
  const file: CacheFile = { version: 2, records: cache ?? {}, synced };
  await IO.IOUtils.makeDirectory(stateDir(), { ignoreExisting: true });
  await IO.IOUtils.writeUTF8(stateFile(), JSON.stringify(file, null, 2));
}

async function load(): Promise<StateMap> {
  if (cache) return cache;
  const { records, v1 } = await readCacheFile();
  cache = records;
  if (v1) await migrate();
  await reclaimFromNotes();
  return cache!;
}

/** Move the records of a pre-notes state.json into the attachments' notes. */
async function migrate(): Promise<void> {
  const local = cache ?? {};
  const shared = await readAllNotes();
  // Another computer may have migrated an attachment already: its note wins.
  cache = { ...local, ...shared };
  let n = 0;
  for (const [key, rec] of Object.entries(local)) {
    if (key in shared) continue;
    await writeNote(key, rec, rec);
    n++;
  }
  await persist();
  log(`state: migrated ${n} record(s) to the attachments' notes`);
}

// --- API -------------------------------------------------------------------

/**
 * Reload the records from the shared notes (after a Zotero sync may have
 * brought another computer's changes). Records with no note are dropped:
 * another computer stopped syncing them.
 */
export async function refreshShared(): Promise<void> {
  await load();
  await reclaimFromNotes(); // blocks moved to item notes, here or elsewhere
  const shared = await readAllNotes();
  const dropped = Object.keys(cache!).filter((k) => !(k in shared));
  if (dropped.length) {
    log(`state: ${dropped.length} record(s) gone from the shared notes`);
  }
  cache = shared;
  await persist();
}

export async function getRecord(key: string): Promise<SyncRecord | undefined> {
  return (await load())[key];
}

/** Load the state into memory (so getRecordCached works). */
export async function preload(): Promise<void> {
  await load();
}

/** Synchronous record lookup from the in-memory cache (undefined if unloaded). */
export function getRecordCached(key: string): SyncRecord | undefined {
  return cache?.[key];
}

export async function setRecord(
  key: string,
  record: SyncRecord,
): Promise<void> {
  const map = await load();
  map[key] = record;
  await persist();
  await writeNote(key, record, record);
}

export async function removeRecord(key: string): Promise<void> {
  const map = await load();
  const rec = map[key];
  if (rec) {
    delete map[key];
    await persist();
    await writeNote(key, rec, null);
  }
}

export async function allRecords(): Promise<StateMap> {
  return { ...(await load()) };
}

/** Record that these attachments were just synced (by this computer). */
export async function markSynced(keys: string[]): Promise<void> {
  if (!keys.length) return;
  await load();
  const now = Date.now();
  for (const k of keys) synced[k] = now;
  await persist();
}

/** When this computer last synced the attachment (epoch ms), if known. */
export function lastSyncedCached(key: string): number | undefined {
  return synced[key] ?? cache?.[key]?.lastPushed;
}

/** Drop the in-memory cache (forces a reload from disk on next access). */
export function invalidate(): void {
  cache = null;
}
