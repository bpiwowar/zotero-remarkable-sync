// Zotero annotation keys encoded as reMarkable author uuids.
//
// Each annotation pushed from Zotero is written under its own author on the
// page, whose uuid encodes the annotation key. Any computer can then tell which
// Zotero annotation a device item came from, without local state. The tablet
// keeps these author entries, and an erased item keeps its author id.
//
// Format (UUIDv8): 7a6f7472-656d-8000-8000-<key, 12 hex digits>, the key read
// as a base-33 number over Zotero's key alphabet (33^8 < 2^48).

const ALPHABET = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
const BASE = BigInt(ALPHABET.length);
const PREFIX = "7a6f7472-656d-8000-8000-";

export function keyToUuid(key: string): string | null {
  if (!/^[23456789A-NP-Z]{8}$/.test(key)) return null;
  let n = 0n;
  for (const c of key) n = n * BASE + BigInt(ALPHABET.indexOf(c));
  return PREFIX + n.toString(16).padStart(12, "0");
}

export function uuidToKey(uuid: string): string | null {
  const u = uuid.toLowerCase();
  if (!u.startsWith(PREFIX) || u.length !== PREFIX.length + 12) return null;
  const hex = u.slice(PREFIX.length);
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  let n = BigInt("0x" + hex);
  let key = "";
  for (let i = 0; i < 8; i++) {
    key = ALPHABET[Number(n % BASE)] + key;
    n /= BASE;
  }
  return n === 0n ? key : null;
}

/** Zotero key of each author of a page encoding one (author id -> key). */
export function keyedAuthors(
  authors: Map<number, string>,
): Map<number, string> {
  const out = new Map<number, string>();
  for (const [id, uuid] of authors) {
    const key = uuidToKey(uuid);
    if (key) out.set(id, key);
  }
  return out;
}

/** Highest author id a page can hold (CrdtId stores it in one byte). */
export const MAX_AUTHOR = 255;
