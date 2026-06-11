# `src/orchestrator/task-hash.ts` — cache-key derivation

## Purpose

The single place that selects and assembles the parts of a task's
cache key: resolved inputs, env values, task-config JSON, project
`package.json` bytes, workspace fingerprint, and filtered upstream
hashes. Split out of `execute-task.ts` because `plan.ts` and
`prepare.ts` need the hashing surface without the execution glue.

It lives in `orchestrator` (not `cache`) deliberately: key-part
selection composes graph types (`TaskNode`, `TaskOutcome`), and
pushing it into `cache` would force a `cache → graph` edge the
dependency matrix forbids. The byte-level folding itself stays in
`Cache.key()`.

## Public surface

```ts
export interface HashCache // memoizes file-content hashes within a run
export function createHashCache(): HashCache

export interface ComputeHashArgs // node, workspaceRoot, fingerprint, cache, …
export async function computeTaskHash(args: ComputeHashArgs): Promise<string>
export function computeGroupHash(upstream: TaskOutcome[]): string
```

- `computeTaskHash` — resolves `cache.inputs.files` (git-backed),
  reads `cache.inputs.env` host values, hashes the resolved task
  config and the project `package.json`, folds in filtered upstream
  hashes, and calls `cache.key({...})`.
- `computeGroupHash` — for group tasks (no `exec`): rolls up upstream
  hashes only, so downstream keys still cascade through the group.

## Invariants

- Any change to what participates in the key requires a
  `CACHE_VERSION` bump (see
  [`../caching.md`](../caching.md#bumping-cache_version)).
- Hash algorithm is xxHash3 via `util/hash.ts` (16-hex keys).

## Tests

Covered through `tests/orchestrator.test.ts` (cache-hit/invalidations
e2e) and `tests/plan-format.test.ts` / plan tests (predicted keys
match executed keys).
