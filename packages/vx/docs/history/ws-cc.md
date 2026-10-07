# Workstream CC: cache and remote cache

- **CC-8.** `Cache.storeFallback` and `Cache.storeMoved` were set and never read: removed, with the `entries` probe that fed only `storeMoved`. Two prune comments claimed a 900-hash chunking that no code does (`inHashes` binds one `json_each` parameter): corrected.
- **CC-1.** A refused restore left an empty directory behind when a later
  entry had created a deeper one (`dist/` then `dist/sub/`): abort pruned in
  staging order and tried `dist/` while `dist/sub/` still held it. Abort now
  prunes newest first. Row (`archive-security.test.ts`):
  `abort prunes a created chain whose deeper directory a later entry created`.
