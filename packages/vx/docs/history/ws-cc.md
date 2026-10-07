# Workstream CC: cache and remote cache

- **CC-13.** `vx-bench/restore-bench.ts` failed with "no such table: entries": since SCHEMA v32 `entries` is in the shared store DB. It now lists hashes through `Cache.dbHandle()`, and restores each artifact into its own empty directory, so no rename replaces a file (unlike a real run, which cleans outputs first; the replace dominated its profile). Proof: run on a 20-package generated workspace.
- **CC-1.** A refused restore left an empty directory behind when a later
  entry had created a deeper one (`dist/` then `dist/sub/`): abort pruned in
  staging order and tried `dist/` while `dist/sub/` still held it. Abort now
  prunes newest first. Row (`archive-security.test.ts`):
  `abort prunes a created chain whose deeper directory a later entry created`.
