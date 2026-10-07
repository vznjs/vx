# Workstream CC: cache and remote cache

- **CC-9.** A secret value the 8 MiB capture bound cut left a piece on
  each side of the dropped middle; the whole-value mask missed both, so
  the cache entry stored them and every hit replayed them. The capture
  is now masked with `maskCaptured`, which masks those pieces too
  (`SecretMask.maskCut`). Rows: `capture-cap.test.ts` › "leaves no piece
  of it at the head’s end or the tail’s start of the entry",
  `secret-mask.test.ts` › "maskCut masks the pieces a cut leaves, a
  whole value across one, and nothing else".
- **CC-1.** A refused restore left an empty directory behind when a later
  entry had created a deeper one (`dist/` then `dist/sub/`): abort pruned in
  staging order and tried `dist/` while `dist/sub/` still held it. Abort now
  prunes newest first. Row (`archive-security.test.ts`):
  `abort prunes a created chain whose deeper directory a later entry created`.
