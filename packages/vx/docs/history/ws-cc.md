# Workstream CC: cache and remote cache

- **CC-4.** vx-reapi's cache save hashed an artifact between 256 KiB
  and the batch limit (~4 MiB) on one read and `writeBlob` read it whole
  again to send: F-50's race (a second writer renaming over the file
  sent B under A's digest). It is now read once, hashed and sent; only
  past the batch limit are there two streamed passes. Row: "a mid-size
  artifact is hashed and sent from one read" (stream-cache.test.ts).
- **CC-1.** A refused restore left an empty directory behind when a later
  entry had created a deeper one (`dist/` then `dist/sub/`): abort pruned in
  staging order and tried `dist/` while `dist/sub/` still held it. Abort now
  prunes newest first. Row (`archive-security.test.ts`):
  `abort prunes a created chain whose deeper directory a later entry created`.
