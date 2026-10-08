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
  workspaceFingerprint: string
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache // the run's memo — no double hashing
  concurrency: number // the probe pump's width
}
export interface ProbedEntry {
  hash: string
  hit: CacheEntry | null
}
export interface ShortCircuit {
  preProbed: Map<string, ProbedEntry> // every stable task's probe, hit or miss
  restoreTier: Set<string> // the confirmed local hits
  uncachedKeys: Map<string, string> // uncached task id → its reused key
}
export async function startLocalShortCircuit(args: ShortCircuitArgs): Promise<ShortCircuit>
// The tasks a workspace-output glob keeps out of the restore tier (`planRun` asks it too).
export function restoreTierExclusions(
  nodes: Map<string, TaskNode>,
  workspaceRoot: string,
): Set<string>
```

- `startLocalShortCircuit(args)` → `{ preProbed, restoreTier, uncachedKeys }`.
- `uncachedKeys` — the up-front keys of uncached tasks that no upstream
  can change (stable-keys.md), minus every task `restoreTierExclusions`
  names (a root-anchored output may land in its project with no edge).
  execute-task uses one as `upfrontKey` instead of deriving it again:
  500 uncached tasks took 1,000 `task hash` calls (31.0 ms summed, min
  of 8) and now take 500 (10.6 ms); the wall moved within noise
  (B-91).
- `ProbedEntry { hash, hit }` — consumed by execute-task (probe reuse:
  the up-front probes ARE execute's probes, hoisted — no double work).

## Invariants

- Gated by `shouldShortCircuit` (run.ts): a cache with no remote
  layer (`hasRemote` unset — a remote run belongs to remote-prefetch),
  `localRead` on, and at least one node.
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
