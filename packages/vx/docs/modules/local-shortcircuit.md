# `src/orchestrator/local-shortcircuit.ts` — restore-ahead classify

## Purpose

The up-front CLASSIFY behind the two-tier scheduler: derive every
stable, cacheable, local-read task's key and probe the local cache
ONCE. Confirmed hits become the RESTORE TIER (ready immediately, low
priority — they backfill idle workers while misses own the pool);
stable misses skip execute's lazy probe; unstable tasks stay dep-gated.

## Public surface

```ts
export interface ShortCircuitArgs {
  nodes: Map<string, TaskNode>
  cache: CacheLayer
  workspaceRoot: string
  claimedFiles: readonly string[] // the root files the plugins claim
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache // the run's memo — no double hashing
  concurrency: number // the probe pump's width
  localOnly?: boolean | undefined // `cache` is the local store before a remote: only hits are recorded
}
export interface ProbedEntry {
  hash: string
  hit: CacheEntry | null
}
export interface ShortCircuit {
  preProbed: Map<string, ProbedEntry> // every stable task's probe, hit or miss
  restoreTier: Set<string> // the confirmed local hits
  uncachedKeys: Map<string, string> // uncached task id → its reused key
  groupKeys: Map<string, UpfrontGroupKey> // unkeyed group id → its up-front key + upstream
  remoteAsk: Map<string, string> // behind a remote, each stable local miss → its key
}
export async function startLocalShortCircuit(args: ShortCircuitArgs): Promise<ShortCircuit>
// The tasks a workspace-output glob keeps out of the restore tier (`planRun` asks it too).
export function restoreTierExclusions(
  nodes: Map<string, TaskNode>,
  workspaceRoot: string,
): Set<string>
```

- `startLocalShortCircuit(args)` → `{ preProbed, restoreTier, uncachedKeys, groupKeys, remoteAsk }`.
- `uncachedKeys` — the up-front keys of uncached tasks that no upstream
  can change (stable-keys.md), minus every task `restoreTierExclusions`
  names (a root-anchored output may land in its project with no edge).
  execute-task uses one as `upfrontKey` instead of deriving it again:
  500 uncached tasks took 1,000 `task hash` calls (31.0 ms summed, min
  of 8) and now take 500 (10.6 ms); the wall moved within noise
  (B-91).
- `groupKeys` — every unkeyed group's up-front key with the upstream it
  folded (stable-keys.md). execute-task uses the key as `upfrontGroupKey`
  when the live upstream has the same ids and keys in the same order, and
  derives it otherwise: 1,090 `installDeps` groups were rolled up twice per
  warm run, ~30 upstream ids sorted, joined and hashed each time (X-149).
- `remoteAsk` — behind a remote cache, each stable task the local store
  missed, with its key: the remote may hold it. `held-servers.ts` holds a
  server whose every dependant is a local hit or in `remoteAsk` until the
  remote answers, and never starts it when all of them hit.
- `ProbedEntry { hash, hit }` — consumed by execute-task (probe reuse:
  the up-front probes ARE execute's probes, hoisted — no double work).

## Invariants

- Gated by `shouldShortCircuit` (run.ts): `localRead` on and at least
  one node. With a remote declared the classify probes the local store
  alone (`localOnly`): a local hit is certain and joins the restore tier
  as it does with no remote; a local miss is left out of `preProbed`, so
  execute asks the layers and the remote GETs stay on remote-prefetch's
  fire-and-forget path, never before the first spawn.
- An `outputs.workspaceFiles` producer upstream takes its dependents out
  of BOTH tiers — not just the restore tier. A root-anchored output is
  boundary-ignoring, so it can land in a dependent's own project dir; and
  execute-task reuses a `preProbed` hash verbatim, which makes probe reuse
  a stale-hit path when the key is preliminary.
- On top of that, `restoreTierExclusions` keeps out of the restore tier
  every task whose project directory (or own `workspaceFiles` input
  prefix) a declared workspace output's static prefix reaches, and every
  transitive dependant of one; a prefix at the root reaches everything,
  which is the graph-wide rule item 584 replaced. The dependants are
  reached by one walk up the dependant edges on an explicit stack: a
  recursion per edge threw `RangeError` out of the classify, failing the
  run, on a 50,000-deep chain over a writer.
- Never throws — degrades to the normal schedule.
- Measured: mixed workload −6.6%; warm all-hit at parity.
