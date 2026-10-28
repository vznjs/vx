# `src/cache/plugin-cache.ts` — a plugin's own entries in the cache

## Purpose

What `setup` and `schedule` receive as `ctx.cache` (plugin.md § `ctx.cache`;
design `design/shared-timings-2026-10.md`): a plugin keeps small blobs in
the cache the workspace declares, through the layers tasks use, without
reaching a remote itself (2026-10-14 21:06). `@vzn/vx-history`
is its first user.

## Public surface

```ts
export const PLUGIN_ENTRY_MAX_BYTES = 1048576
export interface PluginCache {
  get(key: string, scoped?: boolean): Promise<Uint8Array | null> // scoped defaults to true
  put(key: string, bytes: Uint8Array): Promise<void>
  has(key: string, scoped?: boolean): Promise<boolean | null>
  hasMany(keys: readonly string[], scoped?: boolean): Promise<Set<string> | null>
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
  remote's policy (the run's) gates it. The local store keeps every
  entry under its name's key. A scoped run writes a remote only under the
  scope's key (`scopedKey`) and reads one key per request (2026-10-18):
  the scope's, or with `scoped` false the default. A run
  with no scope uses the default key either way.
- **Immutable.** A local write is `INSERT OR IGNORE`; a remote write
  asks `has` first and skips a present key.
- **Bounded.** An entry is at most `PLUGIN_ENTRY_MAX_BYTES`: a bigger
  `put` stores nothing, and a remote body over it is a miss, its stream
  cancelled at the cap. An empty `put` stores nothing, and an empty or
  odd remote body (no Blob or Response, a null body) is a miss, never
  kept: write-once would hide every later good body on this machine.
- **Never a throw.** Every failure is an absent answer (`null`, `false`, a
  skipped write). A remote's fault is said once per remote, call and
  message, as a task artifact's is (to the remote's `onError`, else
  stderr): unsaid, a remote down left DTE planning on no timings with
  no line saying why. `has` is `null` when no
  layer could answer; `hasMany` is `null` when a readable remote has no
  batch probe or its probe fails, so the plugin falls back to `get`.
- Entries are pruned by age with the run history (`pruneOlderThan`).

## Tests

`tests/plugin-cache.test.ts`.

## Run store (`run-store.ts`)

What a run that writes a remote keeps of itself (`docs/modules/plugin.md`
§ Run report and run bytes): `writesRunStore(remotes)` says whether any
remote takes the run's writes, `runEntryName(runId, taskId, 'log' | 'outputs')`
names an entry, `putRunEntry(remotes, scope, name, bytes)` writes it to
each writing remote once (a remote that fails it is said, as a remote
cache fault is, and the others still keep it), and `packRunOutputs(root, paths)` makes the plain
ustar of a failed task's outputs. Keys are `xxh3('vx-run\0' + name)`,
scoped as tasks are; `getRun` reads them. Never the local store.
