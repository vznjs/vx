# Workstream CC: cache and remote cache

- **CC-8.** `Cache.storeFallback` and `Cache.storeMoved` were set and never read: removed, with the `entries` probe that fed only `storeMoved`. Two prune comments claimed a 900-hash chunking that no code does (`inHashes` binds one `json_each` parameter): corrected.
