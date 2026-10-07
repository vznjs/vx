# Workstream CC: cache and remote cache

- **CC-13.** `vx-bench/restore-bench.ts` failed with "no such table: entries": since SCHEMA v32 `entries` is in the shared store DB. It now lists hashes through `Cache.dbHandle()`, and restores each artifact into its own empty directory, so no rename replaces a file (unlike a real run, which cleans outputs first; the replace dominated its profile). Proof: run on a 20-package generated workspace.
