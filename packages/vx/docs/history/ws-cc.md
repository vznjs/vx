# Workstream CC: cache and remote cache

- **CC-12.** A blob-size verdict (A-60) was keyed by the index bytes and pathspecs alone, but names workspace-relative paths: a nested workspace sharing the cache (`VX_CACHE_DIR`) read the outer one's verdict and trusted a resized (filtered) blob, a stale key. The repo→workspace prefix now keys it too. `blob-verdict.test.ts` › "a verdict is keyed by the workspace too: a nested workspace on the same index reads its own".
