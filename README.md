# Zotero reMarkable Sync

> [!WARNING]
> **This is an experimental add-on** (but I am using it frequently, so issues tend to be fixed quickly).
> It reads and writes the undocumented `.rm`
> v6 format and mutates documents in your reMarkable cloud account. Bugs can
> reorder, corrupt, or delete annotations and files. **Back up your reMarkable
> data and your Zotero library before using it, and treat every sync as
> potentially destructive.** Use at your own risk.
>
> In practice, sync works well in both directions. Zotero and reMarkable
> annotations do not map exactly onto each other, though, so some annotations
> do not transfer that well.

A [Zotero](https://www.zotero.org/) plugin (Zotero 8 to 10) that keeps your
PDFs **and annotations** in sync with a [reMarkable](https://remarkable.com/) tablet.

- **Tag-driven** — PDF attachments tagged `@remarkable` (configurable) are pushed to the device.
- **Bidirectional** — PDFs go up; highlights and ink strokes made on the device come
  back as **native Zotero annotations**.
- **On demand or scheduled** — sync from a context menu / button, or on a timer.
- **Self-contained** — talks to the reMarkable cloud directly through the
  [remarkable-annotations](https://github.com/bpiwowar/remarkable-annotations)
  library, compiled to WebAssembly and shipped in the plugin; no external binary
  required.


## How it works

```
Zotero  ──push (tagged PDFs)──▶  reMarkable cloud
        ◀──pull (annotations)──
```

The reMarkable cloud stores annotations as separate `.rm` v6 vector blobs. This plugin
downloads those, parses them, maps their coordinates onto the PDF page, and writes the
result back as native Zotero highlight/ink annotations.

## Development

```bash
npm install        # also installs the husky pre-commit hook
npm start          # launch Zotero with hot-reload
npm run build      # build the .xpi and type-check
npm test           # run unit tests (in Zotero)
npm run lint:fix   # format + lint
npm run test:shared && npm run test:polyfills
                   # offline checks: sync note and keyed pages, polyfills
RM_DEVICE_TOKEN=... RM_SOURCE="<title prefix>" npm run devtest
                   # live round trip on the cloud; writes only in "zotrem-dev"
```

The reMarkable side (reading and writing `.rm` pages, shapes, mapping coordinates
to the PDF, PDF page sizes) is the
[remarkable-annotations](https://github.com/bpiwowar/remarkable-annotations) library
(Rust, compiled to WebAssembly), a git submodule in
[`libs/remarkable-annotations`](libs/remarkable-annotations). Its npm package is
built from the submodule (`npm run build:wasm`, needs Rust and wasm-pack) before
`npm install`. [`src/modules/remarkable/annotations.ts`](src/modules/remarkable/annotations.ts)
wraps it for the sync code, and [`cloud.ts`](src/modules/remarkable/cloud.ts)
makes the requests its cloud client asks for.
The plugin keeps the Zotero side: credentials, the sync engine and the UI.

### Connecting to reMarkable

In the plugin preferences, paste a one-time code from
<https://my.remarkable.com/device/browser/connect> and click **Connect**. The resulting
device token is stored in Zotero preferences.

## Usage

- **Connect**: Settings → _Zotero reMarkable Sync_ → paste a one-time code from
  <https://my.remarkable.com/device/browser/connect>.
- **Sync**: right-click a paper → _reMarkable: Add to sync_ (this tags its best
  PDF `@remarkable`; right-click a PDF row to pick another one), then the toolbar
  **Sync now** button (or set an interval in preferences).
- **Tools → reMarkable**: _Sync now_, _Force re-pull annotations_, _Remove pulled
  annotations_ (removes only plugin-created annotations), _Clean up device
  folder…_ (see below).
- **Cleanup**: _Clean up device folder…_ lists documents in the reMarkable sync
  folder that are not linked to a PDF tagged for sync, and asks for each one:
  **Ignore** (default), **Relink** (when a Zotero PDF matches — tags it and
  links it without re-uploading) or **Move to trash** (recoverable on the
  device). Nothing changes until a final confirmation. Sub-folders are left
  alone.

Text highlights become Zotero highlights, freehand highlighter becomes
translucent highlights, pen strokes become ink, rectangles drawn with the
device's shape tool become Zotero area (image) annotations, and page tags become
a tagged note on the page. Highlights and ink made in Zotero
are pushed to the device, and page tags removed in Zotero are removed there. Your
own Zotero annotations, comments and tags are never overwritten by a pull.

See [How sync works](#how-sync-works) for the details: phases, modes, conflict
handling and known limits.

## How sync works

This section describes what the plugin does when it syncs, which settings and
actions change that, and where each step lives in the code. Line links point to
the code as of this writing; follow the function name if they drift.

### Overview

A sync run has three phases, always in this order:

```
            1. PDF push              2. annotation push        3. pull
Zotero  ── tagged PDFs ──▶  ── Zotero annotations ──▶  ◀── device annotations,
                                + page-tag removals          page tags ──
```

1. **PDF push** ([`pushAll`](src/modules/sync/engine.ts#L184)) uploads the
   PDF of every item tagged for sync that is new or whose file changed.
2. **Annotation push** ([`pushAnnotations`](src/modules/sync/push.ts#L234))
   writes annotations made in Zotero onto the reMarkable pages, and removes page
   tags that were removed in Zotero.
3. **Pull** ([`pullAll`](src/modules/sync/engine.ts#L360)) reads the
   tablet's annotations and page tags and mirrors them as native Zotero
   annotations.

Pushing before pulling matters: a change made in Zotero reaches the device
first, so the pull that follows sees it and does not undo it.

The tablet only shows pushed changes after the document is closed and
reopened on it.

### What is synced

- **PDFs:** PDF attachments carrying the sync tag (`@remarkable` by default,
  pref `syncTag`), in every editable library
  ([`findSyncedPdfs`](src/modules/sync/engine.ts)). Each becomes one
  reMarkable document in the configured folder (pref `folder`). A paper counts
  as synced when one of its PDFs is.
  - _Add to sync_ on a paper tags its best PDF (Zotero's choice), so a paper
    with several PDFs gives one document. On a PDF row, it tags that PDF.
  - Versions up to 0.3 tagged the paper. The first sync moves that tag to the
    PDFs already synced, or to the best PDF
    ([`migrateItemTags`](src/modules/sync/engine.ts)).
- **The state:** the link between an attachment and its document is a
  `SyncRecord` ([`state.ts`](src/modules/sync/state.ts)), keyed by the
  attachment key. It holds the document id and hash, the PDF's SHA-256, and the
  bookkeeping described below. See [Several computers](#several-computers) for
  where it is stored.

### Modes and settings

| Setting          | Values                         | Effect                                                                                                                                          |
| ---------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `syncMode`       | `manual` (default), `interval` | `manual` syncs only on request. `interval` also runs a full sync every `syncInterval` minutes ([`scheduler.ts`](src/modules/scheduler.ts#L17)). |
| `syncInterval`   | minutes, default 30            | Period of the timer in `interval` mode.                                                                                                         |
| `deleteOnUnsync` | `true` (default), `false`      | The default button of the "Remove from sync" dialog: delete the document on the reMarkable, or keep it.                                         |
| `syncTag`        | default `@remarkable`          | The tag that marks items for sync.                                                                                                              |
| `folder`         | default `Zotero`               | Destination folder on the reMarkable, created if missing ([`ensureFolder`](src/modules/remarkable/annotations.ts)).                             |

#### Scope: all items or one item

| Trigger                                         | Scope             | Code                                                                 |
| ----------------------------------------------- | ----------------- | -------------------------------------------------------------------- |
| Toolbar button, Tools → reMarkable → _Sync now_ | every synced item | [`runSyncNow()`](src/modules/ui.ts#L73)                              |
| Item pane → _Sync now_                          | that item only    | [`renderSection`](src/modules/ui.ts#L742) calls `runSyncNow([item])` |
| Interval timer                                  | every synced item | [`tick`](src/modules/scheduler.ts#L17)                               |

A single-item sync limits all three phases to that item's attachments. The PDF
push gets an explicit attachment list, and the annotation push and pull get
`onlyKeys`. If the first attempt fails (usually a stale session), `runSyncNow`
re-authenticates and retries once.

### Several computers

Several computers can sync the same Zotero library with the same reMarkable
account. Three mechanisms make this work.

#### The shared sync note

Each synced PDF attachment keeps its record in its own note (the attachment's
note field, shown when the attachment is selected), under a **reMarkable sync**
heading and a "Do not edit below this line" warning. Zotero sync carries it to
the other computers, so they all share the records.

- **Your text is kept:** text before or after the block stays where it is. The
  plugin replaces its own block in place
  ([`noteWith`](src/modules/sync/state.ts)), and empties the note only when
  nothing of yours is left. (Zotero 8 shows attachment notes read-only, so such
  text comes from an older Zotero or from another tool.)
- **"Migrate to Item Note":** Zotero offers this on any non-empty attachment
  note. It moves the whole note, our block included, into a new note related to
  the attachment, and empties the attachment's note. The block names its
  attachment, so the next sync run puts it back into the attachment's note and
  removes it from the new note: the new note keeps your text, or is erased if
  nothing else is left
  ([`reclaimFromNotes`](src/modules/sync/state.ts)).
- **Hidden from search:** Zotero's quick search ("All Fields & Tags",
  "Everything") matches note text. The record is therefore deflated and written
  as Braille characters, one per byte (U+2800–U+28FF): no typed query matches
  it. Only the heading words match.
- **Authoritative:** the notes are the state. `<Zotero data dir>/remarkablesync/state.json`
  is only a local, readable cache, so the status column can read records
  synchronously.
- **Reloaded every run:** a sync run starts with a Zotero sync, then reloads
  every note ([`beginRun`](src/modules/sync/engine.ts)), and ends with
  another Zotero sync ([`endRun`](src/modules/sync/engine.ts)). This narrows
  the window in which a computer works from an outdated note. Without Zotero
  sync set up, both steps only reload the notes.
- **Written only on change:** a note is rewritten only when its record changes.
- **Deleting the block** makes the plugin forget the link. The next sync finds
  the document again by its PDF hash (below).
- **Migration:** a `state.json` from before the notes (v0.3 and earlier) is
  moved into the notes once, at startup.

Zotero does not merge note text. If two computers change the same attachment's
note between two Zotero syncs, Zotero shows its conflict window and keeps the version
you choose. The next two mechanisms keep the outcome safe whichever is chosen.

#### Relinking by PDF hash

The cloud names each file by the SHA-256 of its bytes, the same hash as the
record's `fileHash`. When a tagged PDF has no record, the PDF push looks for a
document in the sync folder, not linked to any record, whose PDF has that hash
([`unlinkedByPdfHash`](src/modules/sync/engine.ts)). It links to that
document instead of uploading a duplicate. The record is marked `adopted`: the
annotation push skips it until a pull has run, so the annotations another
computer pulled are recognised by their signature first.

#### Pushed annotations carry their Zotero key

Each annotation pushed from Zotero is written under its own author on the page.
The author's uuid encodes the annotation key
([`zkey.ts`](src/modules/remarkable/zkey.ts)): `7a6f7472-656d-8000-8000-`
followed by the key as a base-33 number. Any computer reads it from the page
itself:

- **The pull ignores these items:** they mirror a Zotero annotation, so they
  are never imported, whichever computer pushed them
  ([`withoutZoteroItems`](src/modules/sync/engine.ts)).
- **The push replaces them:** when rewriting an annotation, every item under its
  author is removed first, including items another computer wrote. Items under
  another author that are exact copies of what is written (same shape, colour
  and text) are removed too: leftovers of a push whose tracking was lost.

The tablet keeps these author entries when it saves the page
([rules the tablet enforces](https://github.com/bpiwowar/remarkable-annotations#rules-the-tablet-enforces)). A page
holds at most 255 authors. Past that, annotations are written under the page's
own author, as before.

Annotations pushed by earlier versions sit under the tablet's author. The next
push rewrites them once under their own author.

### Phase 1: PDF push

[`pushAll`](src/modules/sync/engine.ts#L184) handles each attachment as
follows:

- **No record:** if the sync folder holds an unlinked document with the same
  PDF hash, the attachment is linked to it
  ([relinking](#relinking-by-pdf-hash)). Otherwise the PDF is uploaded and a
  record is created.
- **Record exists, same file hash, document still on the device:** the item is
  skipped.
- **Document deleted on the reMarkable:** the plugin respects that. It
  [`stopSync`](src/modules/sync/engine.ts#L77)s the attachment: the record is
  dropped and the sync tag is removed from the PDF. Nothing is uploaded again.
- **In the Zotero trash:** skipped (in every phase) until restored.
- **File changed in Zotero, or a forced overwrite:** the document is replaced.
  1. For a changed file, the old document is pulled first, so annotations made
     on the tablet reach Zotero. If that pull fails, the old copy is kept and
     nothing is uploaded. A forced overwrite ("Zotero wins") skips the pull.
  2. The PDF is uploaded as a new document, carrying over the page tags.
  3. The record is reset by
     [`freshRecord`](src/modules/sync/engine.ts#L149). Annotations pulled
     from the old copy become the user's own, so the annotation push writes
     them to the new copy. Page-tag notes stay
     tracked.
  4. The old document is moved to the reMarkable trash, where it can be
     recovered.

#### Uploading with the real page list

[`uploadPdf`](src/modules/remarkable/annotations.ts) writes one page per PDF page, using the
page count from [`pdfPageCount`](src/modules/sync/engine.ts#L46), so
annotations can be pushed before the document is opened on the tablet (see
[`uploadPdf`](src/modules/remarkable/annotations.ts)).

### Phase 2: annotation push (Zotero → reMarkable)

[`pushAnnotations`](src/modules/sync/push.ts#L234) processes each synced document in two steps.

#### Step 1: page-tag removals

[`pushPageTagRemovals`](src/modules/sync/push.ts#L144) compares two things:

- **The baseline:** `rec.pageTags`, the tablet's tags on each page as of the
  last pull.
- **What's in Zotero:** the tags still present on that page's tag note.

A baseline tag missing from the note is one the user removed in Zotero
([`removedPageTags`](src/modules/sync/push.ts#L111)). Deleting the note
removes all of that page's tags. Those tags are filtered out of the document's
`.content` `pageTags` and committed. The baseline is then updated so the removal
isn't applied twice.

Tags added on the tablet in the meantime are not in the baseline, so they
survive. Tags added in Zotero are never pushed.

#### Step 2: highlights, underlines and ink

These are the annotation types that get pushed. Only annotations that originate
in Zotero are pushed: anything listed in `rec.annotationKeys` came from the
tablet and is skipped.

- **Converting:** each annotation is turned into reMarkable items
  ([`annotationToRm`](src/modules/sync/push.ts#L61)).
  - **Highlights and underlines:** one glyph range per line.
  - **Ink:** fineliner strokes.
  - **Colours:** mapped to the device palette.
- **Grouping:** annotations are grouped by reMarkable page. A page is rewritten
  only when an annotation on it was added, deleted or edited since the last
  push. Edits are detected with
  [`pushFingerprint`](src/modules/sync/annotations.ts#L135) (type, colour,
  text and exact position), stored as `rev` in `rec.pushedItems`.
- **Rewriting a page:**
  - **The page already has a `.rm` file:** new items are appended to its layer,
    and items previously pushed for deleted annotations are removed.
  - **The page has none:** a `.rm` is cloned from another page's structure
    ([`loadTemplate`](src/modules/sync/push.ts#L209)), or a blank one is
    built.
- **Tracking:** `rec.pushedItems` records which reMarkable item ids each Zotero
  annotation became, so that deleting the annotation in Zotero deletes them on
  the tablet.
- **Tablet annotations deleted in Zotero:** each pull records which tablet
  items every annotation came from (`rec.annotationSources`: page uuid and item
  ids). When such an annotation is deleted in Zotero, its items are removed
  from that page ([`deletedPulled`](src/modules/sync/push.ts#L183)), and the
  annotation stops being tracked.
- **Zotero annotations erased on the tablet:** when every item pushed for a
  Zotero annotation is gone from its page (and the page is still there), the
  next sync moves the annotation to the Zotero trash and stops tracking it:
  the push does it for a page it rewrites (before writing
  the page, so the annotation is not written back), the pull for the others. The check is skipped when the document is still the
  version our last push wrote (`rec.pushedVersion`). Restoring the annotation
  from the trash pushes it again.
- **Placeholder guard:** if the device lists fewer pages than the PDF has, it
  still holds the placeholder page list. The document is skipped with the log
  line "open it once on the reMarkable"
  ([push.ts](src/modules/sync/push.ts#L321)).

#### Reading, writing and committing pages

Pages are read with [`parseRmPage`](src/modules/remarkable/annotations.ts) and rewritten with
[`rebuildPage`](src/modules/remarkable/annotations.ts), which drops our previous items (and
pulled items deleted in Zotero) by id and appends the current ones. All pages
of a document go in one commit ([`putPages`](src/modules/remarkable/annotations.ts)); page-tag
removals use `updateDocument`. How pages are parsed, the rules the tablet
enforces on new items, and how commits work are in the
[`remarkable-annotations` README](https://github.com/bpiwowar/remarkable-annotations#readme).

Each write names the document hash read at the start of the push. If the
document changed on the cloud since (new ink from the tablet), the cloud client refuses
the write with `HashNotFoundError`. Nothing is overwritten: the document is
counted as skipped, and the next sync pulls the new ink before pushing again.

### Phase 3: pull (reMarkable → Zotero)

[`pullAll`](src/modules/sync/engine.ts#L360) skips a document whose hash
equals `rec.lastPulledVersion`, unless forced. Otherwise
[`fetchAnnotations`](src/modules/remarkable/annotations.ts) reads every annotated page and the
page tags, by PDF page (see
[the library README](https://github.com/bpiwowar/remarkable-annotations#pages-and-pdf-pages)).

[`applyAnnotations`](src/modules/sync/annotations.ts#L471) then mirrors the
device onto the attachment.

#### What gets created

| reMarkable         | Zotero                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text highlight     | highlight (adjacent same-colour lines merged)                                                                                                                          |
| highlighter stroke | translucent highlight                                                                                                                                                  |
| pen stroke         | ink                                                                                                                                                                    |
| page tags          | one yellow note in the page's top-left corner, comment `reMarkable page tags: a, b`, Zotero tags `a`, `b` ([`buildPageTagNote`](src/modules/sync/annotations.ts#L405)) |

#### Matching

Annotations are matched by a **content signature**:
`type|page|x|y|extra`, for example the first 24 characters of a highlight's
text, or a note's tag list ([`sig`](src/modules/sync/annotations.ts#L84),
[`existingSig`](src/modules/sync/annotations.ts#L95)).

- **A device annotation whose signature is already present** (pulled earlier,
  or the user's own annotation in the same place) is not created again. This
  is also why annotations pushed from Zotero don't come back as duplicates.
- **A device annotation not yet present** is created, and its key is added to
  `rec.annotationKeys`.
- **An annotation in `rec.annotationKeys` that is gone from the device** is
  deleted in Zotero, unless the user edited it (next section).
- **A pulled annotation the user deleted in Zotero** is normally deleted on the
  tablet by the push that comes before the pull (phase 2). If that didn't happen
  (the tablet changed those items since the last pull), the
  pull still doesn't create it again
  ([`withZoteroDeletions`](src/modules/sync/engine.ts#L331)). Each pull
  stores the signature of every tracked annotation (`rec.annotationSigs`). At
  the next pull, the signatures of tracked annotations missing from Zotero go
  to `rec.deletedSigs`, which suppresses them. _Overwrite Zotero from
  reMarkable_ clears the suppressions. Page-tag notes are excluded, since
  deleting one removes the tags on the tablet instead.
- **The user's own annotations** (not in `annotationKeys`) are never modified
  or deleted.

#### User edits on pulled annotations

[`isUserEdited`](src/modules/sync/annotations.ts#L165) decides whether the
user edited a pulled annotation:

- **Any annotation:** it has a comment or tags.
- **A page-tag note:** it has a tag that isn't a device tag. Removing device
  tags doesn't count, since that is pushed instead (phase 2).

When an edited annotation disappears from the device:

- **The device annotation was only modified** (extended or redrawn): the
  matching replacement is the same type on the same page with the largest
  overlap ([`findReplacement`](src/modules/sync/annotations.ts#L244)). The
  Zotero annotation is updated **in place**, with the same key, so links from
  notes keep working.
  - **Comment:** the user's comment is kept
    ([`mergedEdits`](src/modules/sync/annotations.ts#L184)). For a page-tag
    note whose comment is still the generated one, the new generated comment is
    used instead.
  - **Tags:** the user's tags are kept and the device's current tags are added.
- **The device annotation was deleted:** the Zotero annotation is kept and
  becomes the user's own, no longer tracked.

After applying, the record stores the new `annotationKeys` and their
signatures, the document hash as `lastPulledVersion`, the updated
`deletedSigs`, and the page-tag baseline `pageTags` used by phase 2.

### Other actions

| Action                                             | Where                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add to sync                                        | context menu, item pane | Tags the best PDF of each selected paper, or each selected PDF ([`addToSync`](src/modules/sync/engine.ts)). Nothing is uploaded until the next sync.                                                                                                                                                                                                                                                                                                                                                            |
| Remove from sync                                   | context menu, item pane | Dialog ([`askUnsync`](src/modules/ui.ts#L331)): **Delete** or **Keep** the reMarkable copy, plus "pull first" (default on). **Delete** then asks: **Move to trash** (default, recoverable from the tablet) or **Delete permanently** (purge). [`removeFromSync`](src/modules/sync/engine.ts#L576) does a final pull if asked; if that pull fails, the documents are kept on the device. It then removes the tag and record, and deletes the document if chosen. Not connected: only the Zotero side is changed. |
| Overwrite device from Zotero                       | context menu            | Forced replacement of the selection's documents, without a final pull ("Zotero wins"), plus annotation push ([`runOverwriteFromZotero`](src/modules/ui.ts#L256)). The old copies go to the reMarkable trash.                                                                                                                                                                                                                                                                                                    |
| Overwrite Zotero from reMarkable                   | context menu            | Resets the pull state ([`resetPullState`](src/modules/sync/engine.ts#L504)), then a forced pull for the selection ([`runOverwriteFromRemarkable`](src/modules/ui.ts#L291)).                                                                                                                                                                                                                                                                                                                                     |
| Push annotations                                   | Tools → reMarkable      | Phase 2 only, for every item ([`runPush`](src/modules/ui.ts#L173)).                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Force re-pull annotations                          | Tools → reMarkable      | Phase 3 for every item, ignoring `lastPulledVersion` ([`runForcePull`](src/modules/ui.ts#L136)). Safe: matching prevents duplicates.                                                                                                                                                                                                                                                                                                                                                                            |
| Remove pulled annotations                          | Tools → reMarkable      | Deletes every annotation the plugin created and resets pull tracking ([`clearPulledAnnotations`](src/modules/sync/engine.ts#L470)). The next pull recreates them.                                                                                                                                                                                                                                                                                                                                               |
| Clean up device folder                             | Tools → reMarkable      | Lists documents directly in the sync folder that no synced item owns ([`findOrphans`](src/modules/sync/cleanup.ts#L82)), and offers **Ignore**, **Relink** (tag the matching item and record the link without re-uploading) or **Move to trash** for each ([`applyDecisions`](src/modules/sync/cleanup.ts#L175)).                                                                                                                                                                                               |
| Item moved to the Zotero trash                     | automatic               | Nothing on the device; sync skips the item until it is restored ([`isInTrash`](src/modules/sync/engine.ts#L556)).                                                                                                                                                                                                                                                                                                                                                                                               |
| Item deleted permanently in Zotero (trash emptied) | automatic               | The notifier ([`onNotify`](src/hooks.ts#L110)) calls [`unsyncByKeys`](src/modules/sync/engine.ts#L523): the record is dropped and, if `deleteOnUnsync` is on, the document is moved to the reMarkable trash.                                                                                                                                                                                                                                                                                                    |

### Status dot

The item-tree column ([`stateOf`](src/modules/column.ts#L25)) shows the
state of each synced paper (over its PDFs) and of each synced PDF row:

- **○ (tagged, never synced):** the PDF has the sync tag but no record yet.
- **◆ (changed):** a Zotero annotation hasn't been pushed, was edited since it
  was pushed, or was deleted since.
- **● green (synced recently) / ● grey (synced a while ago):** nothing pending.

### Known limits

- **Annotations pulled before v0.3.1 have no recorded source.** Deleting one
  in Zotero only keeps it from coming back; a forced re-pull (_Force re-pull
  annotations_) records the sources.
- **Concurrent edits of a sync note.** Two computers syncing the same PDF
  between two Zotero syncs make Zotero ask which note version to keep. The
  other version's bookkeeping is lost; relinking and keyed authors limit the
  effect to, at worst, a pulled annotation created twice.
- **Deleted pulled annotations.** A pulled annotation deleted in Zotero but
  not on the tablet is kept from coming back by its signature in the shared note. If that note version is
  lost in a conflict, the next pull may create it again.
- **Page tags go to Zotero only, except removals.** Tags added in Zotero are
  not sent to the tablet, and document-level tags are not synced.
- **Commas in tag names aren't supported.** The note's comment is
  comma-separated, so such a tag is read back as two.

## Credits

Built on [`windingwind/zotero-plugin-template`](https://github.com/windingwind/zotero-plugin-template)
and [`zotero-plugin-toolkit`](https://github.com/windingwind/zotero-plugin-toolkit).
reMarkable cloud access and `.rm` v6 parsing/serialization are ported from
[`rmapi-js`](https://github.com/erikbrinkman/rmapi-js) (in
remarkable-annotations); `.rm` format understanding
draws on [`rmscene`](https://github.com/ricklupton/rmscene) and
[`rmc`](https://github.com/ricklupton/rmc).

## License

AGPL-3.0-or-later
