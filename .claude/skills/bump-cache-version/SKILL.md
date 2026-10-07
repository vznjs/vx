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

1. **`packages/vx/src/cache/key-fold.ts`** — `const CACHE_VERSION = 'vx-cache-vN'`.
   Increment N.
2. **`docs/caching.md`** — append to the "Bumping `CACHE_VERSION`" section
   the version + reason.
3. **`docs/modules/cache.md`** — the quoted current version, and the
   `CacheKeyInput` / `CacheEntry` shape if it changed.
4. **`CLAUDE.md`** § Live invariants — the quoted `CACHE_VERSION`.
5. **`docs/STATUS.md`** — the shipped entry that carries the change says
   why the bump was needed (or why it was not: a key-derivation fix whose
   old key was already wrong is self-healing; a machine-local acceleration
   table with a fallback — `output_dirs`, 2026-09-03 — is not identity).
6. **Cache tests** (`packages/vx/tests/cache*.test.ts`, and the digest `tests/key-fold.test.ts` pins) — key-derivation
   assertions and storage-layout fixtures.
7. **`packages/vx/tests/contract/stored-format.json`** — regenerate with
   `VX_UPDATE_CONTRACT=1 bun test tests/contract-stored-format.test.ts`
   (from `packages/vx`). It records each stored layout beside its version
   and fails a layout that moved under an unchanged one.

8. **`packages/vx-docs/src/content/docs/guides/upgrading.md`** — a bump is a
   breaking commit (`type!:` + `BREAKING CHANGE:` footer), and
   `site-upgrading.unsafe.test.ts` wants its footer there, newest first
   (`bun packages/vx/scripts/upgrading.ts` regenerates it from a full clone;
   in a shallow one, add the entry by hand).

## After the bump

Run the gate from the repo root (never `bun test` alone — it cannot see a
type error):

```sh
bun packages/vx/src/bin.ts run ci --all
```

Then commit with a body that explains why the bump was needed — future
you will read it to understand cache invalidation history.

## Reference

The current version and the reasoning live in `CLAUDE.md` § Live
invariants and `docs/caching.md`; the history is in git (the decision log
was retired 2026-09-02). Current: `vx-cache-v40`, core `SCHEMA_VERSION`
`v32` (bumped 2026-10-06 for the shared store; a
`SCHEMA_VERSION` bump drops the whole index, so it is taken only when a
stored shape changes).
