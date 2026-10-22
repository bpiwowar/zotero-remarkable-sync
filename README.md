# Zotero reMarkable Sync

> [!WARNING]
> **This is an experimental add-on.** It reads and writes the undocumented `.rm`
> v6 format and mutates documents in your reMarkable cloud account. Bugs can
> reorder, corrupt, or delete annotations and files. **Back up your reMarkable
> data and your Zotero library before using it, and treat every sync as
> potentially destructive.** Use at your own risk.
>
> To limit the risk, **Safe mode is on by default**: the plugin only _pulls_
> annotations from the reMarkable into Zotero and uploads PDFs — it never
> modifies annotations already on the device. Turn it off in the plugin
> preferences to push Zotero annotations back to the device (the riskier path).

A [Zotero 7](https://www.zotero.org/) plugin (supports up to Zotero 10) that keeps your
PDFs **and annotations** in sync with a [reMarkable](https://remarkable.com/) tablet.

- **Tag-driven** — items tagged `@remarkable` (configurable) are pushed to the device.
- **Bidirectional** — PDFs go up; highlights and ink strokes made on the device come
  back as **native Zotero annotations**.
- **On demand or scheduled** — sync from a context menu / button, or on a timer.
- **Pure TypeScript** — talks to the reMarkable cloud directly via
  [`rmapi-js`](https://github.com/erikbrinkman/rmapi-js); no external binary required.

> Status: early development. See [`MILESTONES`](#milestones) below.

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
npm test           # run unit tests
npm run lint:fix   # format + lint
```

### Connecting to reMarkable

In the plugin preferences, paste a one-time code from
<https://my.remarkable.com/device/browser/connect> and click **Connect**. The resulting
device token is stored in Zotero preferences.

## Usage

- **Connect**: Settings → _Zotero reMarkable Sync_ → paste a one-time code from
  <https://my.remarkable.com/device/browser/connect>.
- **Sync**: tag an item `@remarkable` (right-click → _reMarkable: Add to sync_),
  then the toolbar **Sync now** button (or set an interval in preferences).
- **Tools menu**: _Sync now_, _Force re-pull annotations_, _Remove pulled
  annotations_ (removes only plugin-created annotations).

Annotations sync **reMarkable → Zotero** only; the Zotero side is never modified
destructively, so you can keep annotating on the device. Text highlights become
Zotero highlights, freehand highlighter becomes translucent highlights, and pen
strokes become ink.

## Milestones

- **M0** — scaffold, tooling, pre-commit ✅
- **M1** — push tagged PDFs, auth, preferences, context-menu UX ✅
- **M2** — pull annotations back as native Zotero annotations ✅
- **M3** — scheduled auto-sync ✅ · further polish ongoing
- **M4** — Zotero → reMarkable annotation push (write `.rm` v6), bidirectional
  deletion, per-item overwrite, status indicator ✅

## Credits

Built on [`windingwind/zotero-plugin-template`](https://github.com/windingwind/zotero-plugin-template)
and [`zotero-plugin-toolkit`](https://github.com/windingwind/zotero-plugin-toolkit).
reMarkable cloud access via [`rmapi-js`](https://github.com/erikbrinkman/rmapi-js); `.rm`
format understanding draws on [`rmscene`](https://github.com/ricklupton/rmscene) and
[`rmc`](https://github.com/ricklupton/rmc).

## License

AGPL-3.0-or-later
