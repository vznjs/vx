# `src/cache/scoped-cache.ts` — the run's `cache.scope` over every layer

## Purpose

A scoped run (`cache.scope: 'pr-123'`) reads the default key, then the
scope's, and writes only the scope's, in the local store and every remote
alike (owner, 2026-10-14). `prepare.ts` wraps the resolved cache in it when
the run names a scope; no layer below knows a scope exists.

## Public surface

```ts
export class ScopedCache implements CacheLayer {
  constructor(inner: CacheLayer, scope: string)
}
```

Every `CacheLayer` method is implemented by delegation under the rules
below.

## Rules

- **The scope's key** is `xxh3("vx-cache-scope", scope, task key)`, 16
  hex like a task key, so every wire stores it unchanged. An artifact
  records the key it was packed under and ingest refuses another, so a
  collision is a miss.
- **Reads** (`get`, `getMany`, `has`, `prefetch`) ask the default key,
  then the scope's. A default artifact a remote ingest refuses is a miss
  there, and the scope's key is asked next (Security F6). A batch probe
  that finds only the scope's key marks the default key absent, so its
  GET is skipped.
- **Writes** (`save`, `ingest`) go to the scope's key only. Whether a run
  writes at all is the policy's call.
- **Callers speak task keys.** The key that served each one (a hit's, or
  the scope's on a save) is remembered, and the restore, the output index
  (`loadOutputFilesBatch`, `recordOutputDirs`, stamps), `outputsPath`,
  `artifactSize` and the run's history rows use it, so `vx why` reads the
  components of the entry that answered. An entry returned carries the
  task key.
- **One disk, many scopes** (Security F4): a scoped run's local entry
  sits under its scope's key, so a later run with no scope or another
  scope misses it; an entry with no scope serves every run.
