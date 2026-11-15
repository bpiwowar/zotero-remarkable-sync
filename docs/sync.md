# How sync works

This document describes what the plugin does when it syncs, which settings and
actions change that, and where each step lives in the code. Line links point to
the code as of this writing; follow the function name if they drift.

## Overview

A sync run has three phases, always in this order:

```
            1. PDF push              2. annotation push        3. pull
Zotero  ── tagged PDFs ──▶  ── Zotero annotations ──▶  ◀── device annotations,
                                + page-tag removals          page tags ──
                                (skipped in safe mode)
```

1. **PDF push** ([`pushAll`](../src/modules/sync/engine.ts#L146)) uploads the
   PDF of every item tagged for sync that is new or whose file changed.
2. **Annotation push** ([`pushAnnotations`](../src/modules/sync/push.ts#L211))
   writes annotations made in Zotero onto the reMarkable pages, and removes page
   tags that were removed in Zotero.
3. **Pull** ([`pullAll`](../src/modules/sync/engine.ts#L278)) reads the
   tablet's annotations and page tags and mirrors them as native Zotero
   annotations.

Pushing before pulling matters: a change made in Zotero reaches the device
first, so the pull that follows sees it and does not undo it.

The tablet only shows pushed changes after the document is closed and
reopened on it.

## What is synced

- **Items:** regular Zotero items carrying the sync tag (`@remarkable` by
  default, pref `syncTag`), in every editable library
  ([`findSyncItems`](../src/modules/sync/engine.ts#L107)). Each PDF attachment
  of such an item becomes one reMarkable document in the configured folder
  (pref `folder`).
- **The state:** the link between an attachment and its document is a
  `SyncRecord` ([`state.ts`](../src/modules/sync/state.ts#L5)), stored in
  `<Zotero data dir>/remarkablesync/state.json` and keyed by the attachment key.
  It holds the document id and hash, the PDF's SHA-256, and the bookkeeping
  described below.

## Modes and settings

| Setting          | Values                         | Effect                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syncMode`       | `manual` (default), `interval` | `manual` syncs only on request. `interval` also runs a full sync every `syncInterval` minutes ([`scheduler.ts`](../src/modules/scheduler.ts#L17)).                                                                                              |
| `syncInterval`   | minutes, default 30            | Period of the timer in `interval` mode.                                                                                                                                                                                                         |
| `safeMode`       | `true` (default), `false`      | When on, nothing on the tablet is modified except uploading PDFs. This skips the whole annotation push, including page-tag removals ([`pushAnnotations`](../src/modules/sync/push.ts#L221), [`isSafeMode`](../src/modules/sync/engine.ts#L68)). |
| `deleteOnUnsync` | `true` (default), `false`      | The default button of the "Remove from sync" dialog: delete the document on the reMarkable, or keep it.                                                                                                                                         |
| `syncTag`        | default `@remarkable`          | The tag that marks items for sync.                                                                                                                                                                                                              |
| `folder`         | default `Zotero`               | Destination folder on the reMarkable, created if missing ([`ensureFolder`](../src/modules/remarkable/client.ts#L88)).                                                                                                                           |

### Scope: all items or one item

| Trigger                            | Scope             | Code                                                                    |
| ---------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| Toolbar button, Tools → _Sync now_ | every synced item | [`runSyncNow()`](../src/modules/ui.ts#L72)                              |
| Item pane → _Sync now_             | that item only    | [`renderSection`](../src/modules/ui.ts#L746) calls `runSyncNow([item])` |
| Interval timer                     | every synced item | [`tick`](../src/modules/scheduler.ts#L17)                               |

A single-item sync limits all three phases to that item's attachments. The PDF
push gets an explicit attachment list, and the annotation push and pull get
`onlyKeys`. If the first attempt fails (usually a stale session), `runSyncNow`
re-authenticates and retries once.

## Phase 1: PDF push

[`pushAll`](../src/modules/sync/engine.ts#L146) handles each attachment as
follows:

- **No record:** the PDF is uploaded and a record is created.
- **Record exists, same file hash, document still on the device:** the item is
  skipped.
- **Document deleted on the reMarkable:** the plugin respects that. It
  [`stopSync`](../src/modules/sync/engine.ts#L77)s the attachment: the record is
  dropped and the sync tag is removed from the item, unless another of its PDFs
  is still synced. Nothing is uploaded again.
- **File changed in Zotero:** the PDF is uploaded as a **new** document and the
  record points to it. The old document stays on the tablet (see
  [Limits](#known-limits)).

### Uploading with the real page list

[`uploadPdf`](../src/modules/remarkable/client.ts#L135) writes a `.content`
listing one page uuid per PDF page, using the page count from
[`pdfPageCount`](../src/modules/sync/engine.ts#L46).

rmapi-js's own `putPdf` would write a single placeholder page. The tablet
replaces that only when the document is first opened, so annotations could not
be pushed until then. If the page count is unknown, the plugin falls back to
`putPdf`.

## Phase 2: annotation push (Zotero → reMarkable)

[`pushAnnotations`](../src/modules/sync/push.ts#L211) does nothing in safe mode.
Otherwise it processes each synced document in two steps.

### Step 1: page-tag removals

[`pushPageTagRemovals`](../src/modules/sync/push.ts#L140) compares two things:

- **The baseline:** `rec.pageTags`, the tablet's tags on each page as of the
  last pull.
- **What's in Zotero:** the tags still present on that page's tag note.

A baseline tag missing from the note is one the user removed in Zotero
([`removedPageTags`](../src/modules/sync/push.ts#L110)). Deleting the note
removes all of that page's tags. Those tags are filtered out of the document's
`.content` `pageTags` and committed. The baseline is then updated so the removal
isn't applied twice.

Tags added on the tablet in the meantime are not in the baseline, so they
survive. Tags added in Zotero are never pushed.

### Step 2: highlights, underlines and ink

These are the annotation types that get pushed. Only annotations that originate
in Zotero are pushed: anything listed in `rec.annotationKeys` came from the
tablet and is skipped.

- **Converting:** each annotation is turned into reMarkable items
  ([`annotationToRm`](../src/modules/sync/push.ts#L60)).
  - **Highlights and underlines:** one glyph range per line.
  - **Ink:** fineliner strokes.
  - **Colours:** mapped to the device palette.
- **Grouping:** annotations are grouped by reMarkable page. A page is rewritten
  only when its set of pushed annotation keys changed (an annotation was added
  or deleted).
- **Rewriting a page:**
  - **The page already has a `.rm` file:** new items are appended to its layer,
    and items previously pushed for deleted annotations are removed.
  - **The page has none:** a `.rm` is cloned from another page's structure
    ([`loadTemplate`](../src/modules/sync/push.ts#L186)), or a blank one is
    built.
- **Tracking:** `rec.pushedItems` records which reMarkable item ids each Zotero
  annotation became, so that deleting the annotation in Zotero deletes them on
  the tablet.
- **Placeholder guard:** if the device lists fewer pages than the PDF has, it
  still holds the placeholder page list. The document is skipped with the log
  line "open it once on the reMarkable"
  ([push.ts](../src/modules/sync/push.ts#L282)).

### Committing changes

[`updateDocumentPages`](../src/modules/remarkable/rmupload.ts#L134) writes
through the raw content-addressed API. It runs these steps:

1. Upload the new `.rm` blobs and, optionally, an edited `.content`.
2. Bump `.metadata`'s `lastModified`.
3. Rebuild the document's entry list.
4. Rebuild the root list.
5. Commit the root hash, guarded by the generation number.

It refuses to commit a root that would drop a document. It retries on a
generation conflict, and also when the document is not yet in the root (just
uploaded).

## Phase 3: pull (reMarkable → Zotero)

[`pullAll`](../src/modules/sync/engine.ts#L278) skips a document whose hash
equals `rec.lastPulledVersion`, unless forced. Otherwise
[`fetchAnnotations`](../src/modules/remarkable/rmdoc.ts#L95) does the following:

- reads `.content` to get the page order and `redirectionPageMap` (reMarkable
  page → PDF page, see
  [`pdfIndexByPageId`](../src/modules/remarkable/rmdoc.ts#L60));
- parses each page's `.rm` (v6) file;
- groups the page tags by PDF page
  ([`pageTagsOf`](../src/modules/remarkable/rmdoc.ts#L37)).

[`applyAnnotations`](../src/modules/sync/annotations.ts#L443) then mirrors the
device onto the attachment.

### What gets created

| reMarkable         | Zotero                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text highlight     | highlight (adjacent same-colour lines merged)                                                                                                                             |
| highlighter stroke | translucent highlight                                                                                                                                                     |
| pen stroke         | ink                                                                                                                                                                       |
| page tags          | one yellow note in the page's top-left corner, comment `reMarkable page tags: a, b`, Zotero tags `a`, `b` ([`buildPageTagNote`](../src/modules/sync/annotations.ts#L379)) |

### Matching

Annotations are matched by a **content signature**:
`type|page|x|y|extra`, for example the first 24 characters of a highlight's
text, or a note's tag list ([`sig`](../src/modules/sync/annotations.ts#L82),
[`existingSig`](../src/modules/sync/annotations.ts#L93)).

- **A device annotation whose signature is already present** (pulled earlier,
  or the user's own annotation in the same place) is not created again. This
  is also why annotations pushed from Zotero don't come back as duplicates.
- **A device annotation not yet present** is created, and its key is added to
  `rec.annotationKeys`.
- **An annotation in `rec.annotationKeys` that is gone from the device** is
  deleted in Zotero, unless the user edited it (next section).
- **The user's own annotations** (not in `annotationKeys`) are never modified
  or deleted.

### User edits on pulled annotations

[`isUserEdited`](../src/modules/sync/annotations.ts#L150) decides whether the
user edited a pulled annotation:

- **Any annotation:** it has a comment or tags.
- **A page-tag note:** it has a tag that isn't a device tag. Removing device
  tags doesn't count, since that is pushed instead (phase 2).

When an edited annotation disappears from the device:

- **The device annotation was only modified** (extended or redrawn): the
  matching replacement is the same type on the same page with the largest
  overlap ([`findReplacement`](../src/modules/sync/annotations.ts#L229)). The
  Zotero annotation is updated **in place**, with the same key, so links from
  notes keep working.
  - **Comment:** the user's comment is kept
    ([`mergedEdits`](../src/modules/sync/annotations.ts#L169)). For a page-tag
    note whose comment is still the generated one, the new generated comment is
    used instead.
  - **Tags:** the user's tags are kept and the device's current tags are added.
- **The device annotation was deleted:** the Zotero annotation is kept and
  becomes the user's own, no longer tracked.

After applying, the record stores the new `annotationKeys`, the document hash
as `lastPulledVersion`, and the page-tag baseline `pageTags` used by phase 2.

## Other actions

| Action                            | Where                   | What it does                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add to sync                       | context menu, item pane | Adds the sync tag ([`addToSync`](../src/modules/sync/engine.ts#L465)). Nothing is uploaded until the next sync.                                                                                                                                                                                                                                                                                     |
| Remove from sync                  | context menu, item pane | Dialog ([`askUnsync`](../src/modules/ui.ts#L330)): **Delete** or **Keep** the reMarkable copy, plus "pull first" (default on). [`removeFromSync`](../src/modules/sync/engine.ts#L480) does a final pull if asked; if that pull fails, the documents are kept on the device. It then removes the tag and record, and deletes the document if chosen. Not connected: only the Zotero side is changed. |
| Overwrite device from Zotero      | context menu            | Forced PDF re-upload plus annotation push for the selection ([`runOverwriteFromZotero`](../src/modules/ui.ts#L255)). Blocked in safe mode.                                                                                                                                                                                                                                                          |
| Overwrite Zotero from reMarkable  | context menu            | Resets the pull state ([`resetPullState`](../src/modules/sync/engine.ts#L418)), then a forced pull for the selection ([`runOverwriteFromRemarkable`](../src/modules/ui.ts#L290)).                                                                                                                                                                                                                   |
| Push annotations                  | Tools                   | Phase 2 only, for every item ([`runPush`](../src/modules/ui.ts#L172)). Blocked in safe mode.                                                                                                                                                                                                                                                                                                        |
| Force re-pull annotations         | Tools                   | Phase 3 for every item, ignoring `lastPulledVersion` ([`runForcePull`](../src/modules/ui.ts#L135)). Safe: matching prevents duplicates.                                                                                                                                                                                                                                                             |
| Remove pulled annotations         | Tools                   | Deletes every annotation the plugin created and resets pull tracking ([`clearPulledAnnotations`](../src/modules/sync/engine.ts#L384)). The next pull recreates them.                                                                                                                                                                                                                                |
| Clean up device folder            | Tools                   | Lists documents directly in the sync folder that no synced item owns ([`findOrphans`](../src/modules/sync/cleanup.ts#L82)), and offers **Ignore**, **Relink** (tag the matching item and record the link without re-uploading) or **Move to trash** for each ([`applyDecisions`](../src/modules/sync/cleanup.ts#L175)).                                                                             |
| Item trashed or deleted in Zotero | automatic               | The notifier ([`onNotify`](../src/hooks.ts#L110)) calls [`unsyncByKeys`](../src/modules/sync/engine.ts#L434), which deletes the document on the reMarkable and drops the record.                                                                                                                                                                                                                    |

## Status dot

The item-tree column ([`stateOf`](../src/modules/column.ts#L25)) shows the
state of each synced item:

- **○ (tagged, never synced):** the item has the sync tag but no record yet.
- **◆ (changed):** a Zotero annotation hasn't been pushed, was edited since it
  was pushed, or was deleted since.
- **● green (synced recently) / ● grey (synced a while ago):** nothing pending.

## Known limits

- **Deleting a tablet annotation in Zotero isn't permanent.** A highlight or
  ink stroke that came from the tablet comes back at the next pull that fetches
  the document (any change on the tablet), or at any forced pull.
  `rec.deletedSigs` is meant to suppress this but nothing fills it in yet.
  Page-tag notes are the exception: deleting one removes the tags on the
  tablet.
- **Edits to an already-pushed annotation are not pushed.** Moving one, or
  changing its colour, leaves its page's set of keys unchanged, so the page
  isn't rewritten. The status dot does show ◆.
- **A changed PDF leaves the old document on the tablet.** The new file is
  uploaded as a new document; the old one has to be removed with _Clean up
  device folder_.
- **Trashing an item in Zotero deletes its reMarkable document straight
  away,** without the confirmation dialog and regardless of `deleteOnUnsync`.
- **Page tags go to Zotero only, except removals.** Tags added in Zotero are
  not sent to the tablet, and document-level tags are not synced.
- **Commas in tag names aren't supported.** The note's comment is
  comma-separated, so such a tag is read back as two.
