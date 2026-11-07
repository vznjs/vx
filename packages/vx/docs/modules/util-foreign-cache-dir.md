# `src/util/foreign-cache-dir.ts` — a cache dir that is not vx's own

## Purpose

A `.vx/cache` linked to `~` or `..` passed every unresolved check: the
run wrote its config bundle and index there, and `vx cache clean`
deleted from it. One check, shared by the config bundle (workspace,
which writes `compiled/` before the cache opens), the cache's open and
the clear, so the refusal comes before vx's first write there.

## Public surface

```ts
export const OWN_DIR_HINT: string
export function refuseForeignCacheDir(cacheDir: string, workspaceRoot: string | undefined): void
```

- `refuseForeignCacheDir` — throws (`VX_E_CONFIG`) when `cacheDir`
  resolves, through links, to home, `/`, or a directory holding
  `workspaceRoot` or a `.git`. A directory not there yet passes (made
  as named). A pass is kept for the process, so the bundle's check and
  the cache's open cost one realpath; a refusal is decided each time.
  Asked by `buildCompiled` (`workspace/config-bytecode.ts`), every open
  of an index (`cache/cache.ts`) and `vx cache clean` before it deletes.
- `OWN_DIR_HINT` — the hint every cache-dir refusal ends with.

## Tests

`tests/cache-clean.test.ts` ("a .vx/cache linked to %s is refused by
the run and by the clear"): neither an index nor `compiled/` appears
where the link leads, and the clear deletes nothing there.
