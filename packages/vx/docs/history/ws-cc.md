# Workstream CC: cache and remote cache

- **CC-2.** `Cache.getMany` with a task context adopted and served local entries with local reads off (`--force`, `local:w`), where `get` missed: the adopt fallback skipped the read gate. It now checks it. Row: `cache-get-many.test.ts` "honours the read gate with a task context, whose miss may adopt an artifact".
- **CC-1.** A refused restore left an empty directory behind when a later
  entry had created a deeper one (`dist/` then `dist/sub/`): abort pruned in
  staging order and tried `dist/` while `dist/sub/` still held it. Abort now
  prunes newest first. Row (`archive-security.test.ts`):
  `abort prunes a created chain whose deeper directory a later entry created`.
