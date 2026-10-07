# Workstream CC: cache and remote cache

- **CC-9.** A secret value the 8 MiB capture bound cut left a piece on
  each side of the dropped middle; the whole-value mask missed both, so
  the cache entry stored them and every hit replayed them. The capture
  is now masked with `maskCaptured`, which masks those pieces too
  (`SecretMask.maskCut`). Rows: `capture-cap.test.ts` › "leaves no piece
  of it at the head’s end or the tail’s start of the entry",
  `secret-mask.test.ts` › "maskCut masks the pieces a cut leaves, a
  whole value across one, and nothing else".
