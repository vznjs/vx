# `src/cache/plugin-cache.ts` — a plugin's own entries in the cache

## Purpose

What `setup` and `schedule` receive as `ctx.cache` (plugin.md § `ctx.cache`;
design `design/shared-timings-2026-10.md`): a plugin keeps small blobs in
the cache the workspace declares, through the layers tasks use, without
reaching a remote itself (M 2026-10-14 21:06). `@vzn/vx-schedule-history`
is its first user.

## Public surface

```ts
export const PLUGIN_ENTRY_MAX_BYTES = 1048576
export interface PluginCache {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, bytes: Uint8Array): Promise<void>
  has(keys: readonly string[]): Promise<string[] | null> // the keys some layer holds, one probe per layer
  getRun(name: string): Promise<Uint8Array | null> // run bytes core kept (run-store.ts), first readable remote, uncapped
}
export function pluginCache(plugin: string, host: PluginCacheHost): PluginCache
export const absentPluginCache: PluginCache // every answer absent: a context outside a run
// run-store.ts
export function runEntryName(runId: string, taskId: string, part: 'log' | 'outputs'): string
export function writesRunStore(remotes: readonly ResolvedRemote[]): boolean
export function putRunEntry(
  remotes: readonly ResolvedRemote[],
  scope: string | undefined,
  name: string,
  bytes: Uint8Array,
): Promise<boolean>
export function packRunOutputs(
  workspaceRoot: string,
  paths: readonly string[],
): Promise<Uint8Array | null>
```

## Rules

- **Keys are core's.** An entry's key is `xxh3('vx-plugin\0' + plugin +
'\0' + name)`, 16 hex like a task key, so every wire stores it
  unchanged and no plugin reaches another's entries or a task's.
- **Layers.** The local store (the shared store's `plugin_blobs`) first,
  then each remote `resolveCache` collected, in declared order. A remote
  hit is kept locally when the policy writes the local store.
- **Policy and scope.** The local axes gate the local store; each
  remote's own policy (the run's, narrowed by its `access`) gates it. A
  scoped run reads the default key, then the scope's
  (`scopedKey`, as `ScopedCache`), and writes only the scope's.
- **Immutable.** A local write is `INSERT OR IGNORE`; a remote write
  asks `has` first and skips a present key.
- **Bounded.** An entry is at most `PLUGIN_ENTRY_MAX_BYTES`: a bigger
  `put` stores nothing, and a remote body over it is a miss, its stream
  cancelled at the cap. An empty `put` stores nothing, and an empty or
  odd remote body (no Blob or Response, a null body) is a miss, never
  kept: write-once would hide every later good body on this machine.
- **Silent.** Every failure is an absent answer (`null`, `false`, a
  skipped write), never a throw or a warning. `has` is `null` when no
  layer could answer, so the plugin falls back to `get`.
- Entries are pruned by age with the run history (`pruneOlderThan`).

## Tests

`tests/plugin-cache.test.ts`.

## Run store (`run-store.ts`)

What a run that writes a remote keeps of itself (`docs/modules/plugin.md`
§ Run report and run bytes): `writesRunStore(remotes)` says whether any
remote takes the run's writes, `runEntryName(runId, taskId, 'log' | 'outputs')`
names an entry, `putRunEntry(remotes, scope, name, bytes)` writes it to
each writing remote once, and `packRunOutputs(root, paths)` makes the plain
ustar of a failed task's outputs. Keys are `xxh3('vx-run\0' + name)`,
scoped as tasks are; `getRun` reads them. Never the local store.
