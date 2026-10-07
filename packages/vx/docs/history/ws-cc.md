# Workstream CC: cache and remote cache

- **CC-12.** A blob-size verdict (A-60) was keyed by the index bytes and pathspecs alone, but names workspace-relative paths: a nested workspace sharing the cache (`VX_CACHE_DIR`) read the outer one's verdict and trusted a resized (filtered) blob, a stale key. The repo→workspace prefix now keys it too. `blob-verdict.test.ts` › "a verdict is keyed by the workspace too: a nested workspace on the same index reads its own".
- **CC-1.** A refused restore left an empty directory behind when a later
  entry had created a deeper one (`dist/` then `dist/sub/`): abort pruned in
  staging order and tried `dist/` while `dist/sub/` still held it. Abort now
  prunes newest first. Row (`archive-security.test.ts`):
  `abort prunes a created chain whose deeper directory a later entry created`.
