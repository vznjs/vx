# `src/cache/scoped-cache.ts` — the key a scope stores a plugin entry under

## Purpose

A task key reaches every remote plain: core never scopes it (VZN,
2026-10-20). Which branch a read may see is the remote's business:
`turboCache()` names the run's refs on each read, or folds the ref into
the key (`scope: 'key'`), and the server's OIDC trust policy decides
where a write lands. A run's scope (`VX_CACHE_SCOPE`, a plugin's or the
branch's) now keys only what plugins store themselves: `ctx.cache`
entries (`plugin-cache.ts`) and run-store records (`run-store.ts`). So no
`RemoteCacheLayer` method takes a scope.

## Public surface

```ts
export function scopedKey(scope: string, hash: string): string
```

## Rules

- **The scope's key** is `xxh3("vx-cache-scope", scope, key)`, 16 hex
  like a task key, so every wire stores it unchanged.
- **The local store never knows a scope** (2026-10-17): every branch
  shares one local pool under the task keys.
