startup-begin = reMarkable Sync is loading
startup-finish = reMarkable Sync is ready

menuitem-sync-now = reMarkable: Sync now
menuitem-push = reMarkable: Push annotations to device
menuitem-force-pull = reMarkable: Force re-pull annotations
menuitem-clear-pulled = reMarkable: Remove pulled annotations
menuitem-cleanup = reMarkable: Clean up device folder…
menuitem-add-to-sync = reMarkable: Add to sync
menuitem-remove-from-sync = reMarkable: Remove from sync
menuitem-overwrite-from-zotero = reMarkable: Overwrite device from Zotero
menuitem-overwrite-from-remarkable = reMarkable: Overwrite Zotero from device

status-synced = Synced to reMarkable
status-not-synced = Not synced
status-not-connected = Not connected to reMarkable. Connect in the plugin preferences.

sync-now = Sync now
sync-running = Syncing…
sync-done = Pushed { $pushed }, skipped { $skipped }, failed { $failed }
sync-complete = { $files } up · { $sent } sent · +{ $added } −{ $removed }{ $stopped ->
    [0] {""}
   *[other] { " · " }{ $stopped } unsynced (deleted on device)
}
safe-mode-blocked = Safe mode is on — turn it off in preferences to push annotations to the device.
pull-done = Pulled +{ $added } −{ $removed }
clear-done = Removed { $count } pulled annotation(s)
push-done = Pushed { $pushed } annotation(s) to device, skipped { $skipped }
overwrite-zotero-done = Device overwritten from Zotero: { $sent } annotation(s) sent
overwrite-remarkable-done = Zotero overwritten from device: +{ $added } −{ $removed }
nothing-selected = No items selected
sync-error = reMarkable sync error: { $error }

cleanup-title = Clean up reMarkable folder
cleanup-scanning = Looking for untracked documents on reMarkable…
cleanup-none = No untracked documents in the reMarkable folder
cleanup-no-folder = The reMarkable sync folder was not found
cleanup-ask-doc = [{ $index }/{ $total }] “{ $name }” is in the reMarkable sync folder but not linked to an item tagged for sync.
    Last modified: { $modified }
cleanup-ask-match-record = It was previously synced with “{ $title }” ({ $library }), which is no longer tagged. Relink re-adds the tag.
cleanup-ask-match-title = It matches “{ $title }” ({ $library }){ $matches ->
    [1] {""}
   *[other] {" "}(first of { $matches } matches)
}. Relink tags the item and links it to this document (no re-upload).
cleanup-ask-no-match = No matching Zotero item was found.
cleanup-btn-delete = Move to trash
cleanup-btn-ignore = Ignore
cleanup-btn-relink = Relink
cleanup-ignore-rest = Ignore all remaining documents
cleanup-btn-apply = Apply
cleanup-confirm = About to move { $trash } document(s) to the reMarkable trash and relink { $relink }. Continue?
cleanup-done = Cleanup: { $trashed } moved to trash, { $relinked } relinked{ $failed ->
    [0] {""}
   *[other] , { $failed } failed
}
unsync-title = Remove from reMarkable sync
unsync-ask = Stop syncing { $count ->
    [1] this item
   *[other] these { $count } items
} with the reMarkable. What should happen to the copy on the reMarkable?
unsync-btn-delete = Delete on reMarkable
unsync-btn-keep = Keep on reMarkable
unsync-pull-first = Pull annotations from the reMarkable first
unsync-done = Removed from sync
