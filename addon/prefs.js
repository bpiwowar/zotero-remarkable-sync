// Default preferences. Keys are prefixed with `prefsPrefix` at build time.

// Tag that marks which items should be synced to the reMarkable.
pref("syncTag", "@remarkable");
// Destination folder on the reMarkable (top-level name or "/"-separated path).
pref("folder", "Zotero");
// The folder's id and parent once resolved (for the "folder" path in
// "folderPath"), so that syncs only check it is still there.
pref("folderPath", "");
pref("folderId", "");
pref("folderParent", "");
// reMarkable device token obtained from the one-time code (empty = not connected).
pref("deviceToken", "");
// Sync trigger: "manual" (on demand only) or "interval" (timer).
pref("syncMode", "manual");
// Auto-sync interval in minutes (used when syncMode === "interval").
pref("syncInterval", 30);
// When removing an item from sync, also delete it from the reMarkable cloud.
pref("deleteOnUnsync", true);
// Safe mode: never modify annotations on the reMarkable (pull only). PDFs are
// still uploaded ("storing" is non-destructive). On by default.
pref("safeMode", true);
// Group nearby pen strokes, drawn one after the other, into one Zotero ink
// annotation (handwriting reads as one annotation instead of one per stroke).
pref("groupStrokes", true);
// How close (PDF points) a stroke must be to a stroke of the group to join it.
pref("groupStrokesGap", 12);
