// The reMarkable cloud, through remarkable-annotations' sans-I/O client
// (WebAssembly): the library decides which requests to make, this module
// makes them (fetch) and waits between retries.
//
// `Cloud` has the methods of rmapi-js's RemarkableApi that the sync code uses,
// with the same results; rmapi-js's types describe them.

import type { DocumentContent, Entry, ItemRef, RawEntry } from "rmapi-js";
import * as wasm from "remarkable-annotations";

// --- Errors --------------------------------------------------------------

/** A cloud error, with the library's error kind. */
export class CloudError extends Error {
  readonly kind: string;
  readonly status?: number;
  constructor(error: { kind: string; message: string; status?: number }) {
    super(error.message);
    this.name = "CloudError";
    this.kind = error.kind;
    this.status = error.status;
  }
}

/** The document changed on the cloud since it was read: nothing was written. */
export class HashNotFoundError extends CloudError {
  constructor(error: { kind: string; message: string }) {
    super(error);
    this.name = "HashNotFoundError";
  }
}

/** Too many concurrent changes of the cloud (generation conflicts). */
export class GenerationError extends CloudError {
  constructor(error: { kind: string; message: string }) {
    super(error);
    this.name = "GenerationError";
  }
}

function cloudError(error: {
  kind: string;
  message: string;
  status?: number;
}): CloudError {
  switch (error.kind) {
    case "hashNotFound":
      return new HashNotFoundError(error);
    case "generation":
      return new GenerationError(error);
    default:
      return new CloudError(error);
  }
}

// --- Running operations ----------------------------------------------------

type Step =
  | {
      type: "request";
      method: string;
      url: string;
      headers: [string, string][];
      body?: Uint8Array;
    }
  | { type: "sleep"; ms: number }
  | { type: "done"; json?: string; bytes?: Uint8Array; text?: string }
  | {
      type: "error";
      error: { kind: string; message: string; status?: number };
    };

type Done = Extract<Step, { type: "done" }>;

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** Run an operation to its end: make its requests, wait between retries. */
export async function run(op: wasm.CloudOperation): Promise<Done> {
  try {
    let step = op.start() as Step;
    for (;;) {
      if (step.type === "request") {
        let response;
        try {
          const r = await fetch(step.url, {
            method: step.method,
            headers: step.headers,
            body: step.body,
          });
          response = {
            status: r.status,
            statusText: r.statusText,
            body: new Uint8Array(await r.arrayBuffer()),
          };
        } catch (e) {
          response = { networkError: String(e) };
        }
        step = op.resume(response) as Step;
      } else if (step.type === "sleep") {
        // The library gives the longest wait; spread retries (as rmapi-js).
        await sleep(Math.random() * step.ms);
        step = op.resume(undefined) as Step;
      } else if (step.type === "done") {
        return step;
      } else {
        throw cloudError(step.error);
      }
    }
  } finally {
    op.free();
  }
}

const json = async <T>(op: wasm.CloudOperation): Promise<T> =>
  JSON.parse((await run(op)).json ?? "null") as T;

// --- Connecting --------------------------------------------------------------

/** Exchange a one-time code for a device token. */
export async function register(
  code: string,
  deviceDesc = "browser-chrome",
): Promise<string> {
  const done = await run(
    wasm.cloudRegister(code, deviceDesc, globalThis.crypto.randomUUID()),
  );
  return done.text!;
}

/** A session on the cloud, from a device token. */
export async function connectCloud(deviceToken: string): Promise<Cloud> {
  const done = await run(wasm.cloudAuth(deviceToken));
  return new Cloud(new wasm.CloudSession(done.text!));
}

// --- The cloud ---------------------------------------------------------------

/** A page of `fetchAnnotations`, as the library returns it. */
export interface WasmDocPage {
  pdfPageIndex: number;
  pageUuid: string;
  page: unknown;
}

/** The cloud, as the sync code calls it (formerly rmapi-js's RemarkableApi). */
export type RemarkableApi = Cloud;

export class Cloud {
  constructor(private readonly session: wasm.CloudSession) {}

  /** Low-level access to a document's files. */
  readonly raw = {
    getEntries: (ref: ItemRef) =>
      json<{ entries: RawEntry[] }>(this.session.getEntries(ref.id, ref.hash)),
    getHash: async (ref: ItemRef): Promise<Uint8Array> =>
      (await run(this.session.getHash(ref.id, ref.hash))).bytes!,
  };

  /** The id and hash of every item: the root listing only (cached; `refresh`
   *  reads the cloud's root again). */
  listRefs(refresh = false): Promise<ItemRef[]> {
    return json(this.session.listRefs(refresh));
  }

  /** An item's `.metadata` (name, type, parent). */
  getMetadata(
    ref: ItemRef,
  ): Promise<{ visibleName: string; type: string; parent?: string }> {
    return json(this.session.getMetadata(ref.id, ref.hash));
  }

  /** Every document and folder (cached; `refresh` reads the cloud again). */
  listItems(refresh = false): Promise<Entry[]> {
    return json(this.session.listItems(refresh));
  }

  getContent(ref: ItemRef): Promise<DocumentContent> {
    return json(this.session.getContent(ref.id, ref.hash));
  }

  /** Merge `content` into a document's `.content`. */
  updateDocument(
    ref: ItemRef,
    content: Partial<DocumentContent>,
  ): Promise<ItemRef> {
    return json(
      this.session.updateDocument(ref.id, ref.hash, JSON.stringify(content)),
    );
  }

  /** Move an item to another folder ("trash" for the trash). */
  move(ref: ItemRef, parent: string): Promise<ItemRef> {
    return json(this.session.move(ref.id, ref.hash, parent));
  }

  /** Delete an item for good. */
  async purge(ref: ItemRef): Promise<void> {
    await run(this.session.purge(ref.id, ref.hash));
  }

  /**
   * Replace the `.rm` files of some pages in one commit. Fails with
   * HashNotFoundError if the document changed since `ref` was read.
   */
  putRmPages(ref: ItemRef, pages: Map<string, Uint8Array>): Promise<ItemRef> {
    return json(
      this.session.putRmPages(
        ref.id,
        ref.hash,
        [...pages.keys()],
        [...pages.values()],
      ),
    );
  }

  /** Upload a PDF with its page list (one page per PDF page) and page tags. */
  uploadPdf(
    visibleName: string,
    bytes: Uint8Array,
    folderId: string,
    tags: string[],
    pageCount: number | undefined,
    pageTags: Record<string, string[]>,
  ): Promise<ItemRef> {
    const uuids = Array.from({ length: 2 + (pageCount ?? 0) }, () =>
      globalThis.crypto.randomUUID(),
    );
    return json(
      this.session.uploadPdf(
        visibleName,
        bytes,
        folderId,
        tags,
        pageCount,
        JSON.stringify(pageTags),
        uuids,
        Date.now(),
      ),
    );
  }

  /** The id of a "/"-separated folder path, creating missing folders. */
  ensureFolder(path: string): Promise<string> {
    const uuids = path.split("/").map(() => globalThis.crypto.randomUUID());
    return json(this.session.ensureFolder(path, uuids, Date.now()));
  }

  /** Every annotated page of a document, and its page tags. */
  fetchAnnotations(ref: ItemRef): Promise<{
    pages: WasmDocPage[];
    pageTags: { pdfPageIndex: number; names: string[] }[];
    content: DocumentContent | null;
  }> {
    return json(this.session.fetchAnnotations(ref.id, ref.hash));
  }

  /** Each PDF page's reMarkable page uuid and `.rm` entry, if any. */
  async mapPdfPages(
    ref: ItemRef,
  ): Promise<
    Map<number, { pageUuid: string; rmEntry?: { id: string; hash: string } }>
  > {
    return new Map(await json(this.session.mapPdfPages(ref.id, ref.hash)));
  }
}
