// Persistent mapping between Zotero PDF attachments and reMarkable documents.
// Stored as a single JSON file in the Zotero data directory. Keyed by the
// attachment item key.

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
}

type StateMap = Record<string, SyncRecord>;

const IO = globalThis as any;

let cache: StateMap | null = null;

function stateDir(): string {
  return IO.PathUtils.join(Zotero.DataDirectory.dir, "remarkablesync");
}

function stateFile(): string {
  return IO.PathUtils.join(stateDir(), "state.json");
}

async function load(): Promise<StateMap> {
  if (cache) return cache;
  try {
    const text = await IO.IOUtils.readUTF8(stateFile());
    cache = JSON.parse(text) as StateMap;
  } catch {
    // Missing or unreadable file → start empty.
    cache = {};
  }
  return cache!;
}

async function persist(): Promise<void> {
  await IO.IOUtils.makeDirectory(stateDir(), { ignoreExisting: true });
  await IO.IOUtils.writeUTF8(stateFile(), JSON.stringify(cache ?? {}, null, 2));
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
}

export async function removeRecord(key: string): Promise<void> {
  const map = await load();
  if (key in map) {
    delete map[key];
    await persist();
  }
}

export async function allRecords(): Promise<StateMap> {
  return { ...(await load()) };
}

/** Drop the in-memory cache (forces a reload from disk on next access). */
export function invalidate(): void {
  cache = null;
}
