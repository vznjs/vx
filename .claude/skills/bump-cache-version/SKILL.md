---
name: bump-cache-version
description: Use when changing the cache key derivation or on-disk cache format. Walks the consistent set of files that must update together so existing cached entries are properly invalidated and decisions are recorded.
---

# Bump CACHE_VERSION

Cache identity is folded into the key via a single sentinel constant.
When you change anything that affects what's hashed or what's stored,
you must bump it; otherwise stale entries can produce wrong restores.

## When to bump

- A new field is folded into `Cache.key()` (new input).
- The order of fields in `Cache.key()` changes.
- The on-disk `<hash>/` layout changes (file placement).
- The `CacheEntry` JSON shape changes in a way that affects restore.
- WAL/SQLite schema changes (v10+).

## When NOT to bump

- Refactors that don't change the bytes fed into the hash.
- Doc-only updates.
- Adding stats / history tables (those are separate from cache identity).

## Files to update (in order)

1. **`src/cache.ts`** — `const CACHE_VERSION = 'vx-cache-vN'`. Increment N.
2. **`docs/caching.md`** — append to the "Bumping `CACHE_VERSION`"
   section the version + reason.
3. **`docs/modules/cache.md`** — if the `CacheKeyInput` / `CacheEntry`
   shape changed, update the schema there.
4. **`CLAUDE.md`** — append to the decision log:
   `- **YYYY-MM**: CACHE_VERSION → vN. <reason>. PR #<n>.`
5. **Cache tests** (`src/cache.test.ts`) — if you changed key derivation,
   update the assertions; if you changed storage layout, update e2e
   fixtures.

## After the bump

Run the local check:

```sh
bun run lint && bun run format:check && bun test src/
```

Then commit with a body that explains why the bump was needed — future
you will read it to understand cache invalidation history.

## Reference

Current version, decision log, and reasoning live in `CLAUDE.md` and
`docs/caching.md`. Cache version history:

- v7 → v8: folded `forwardArgs` into the key (PR #2, CLI alignment).
- v8 → v9: TaskConfig JSON shape changed (`exec` array → single,
  `tasks` nested under `run`). PR #3.
- v9 → v10: SQLite-backed metadata + on-disk outputs; per-entry
  manifest removed. PR #<this>.
