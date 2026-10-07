# Workstream CC: cache and remote cache

- **CC-2.** `Cache.getMany` with a task context adopted and served local entries with local reads off (`--force`, `local:w`), where `get` missed: the adopt fallback skipped the read gate. It now checks it. Row: `cache-get-many.test.ts` "honours the read gate with a task context, whose miss may adopt an artifact".
