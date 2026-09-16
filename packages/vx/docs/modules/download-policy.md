# `src/orchestrator/download-policy.ts` — `--download` modes + the deferral gate

## Purpose

Decides, ONCE per task at plan time, whether a remotely-executed task's
outputs come home. Two questions live here: what mode each task gets, and
which tasks are safe to defer at all. Both are answered before scheduling,
so `--dry` can show them and the scheduler never re-derives them.

See [`design/download-policy-cas-cache-2026-08.md`](../design/download-policy-cas-cache-2026-08.md).

## Public surface

```ts
export type DownloadMode = 'eager' | 'deferred' | 'never'

export function deferralEligibility(nodes: Map<string, TaskNode>): Map<string, string> // ineligible id → why
export function resolveDownloadModes(args: {
  nodes: Map<string, TaskNode>
  policy: 'all' | 'toplevel' | 'none'
  localPlaced: ReadonlySet<string> // placed on a local executor — they write in place
  remoteOnly: ReadonlySet<string> // `exec.remote: 'only'`
}): { modeOf: Map<string, DownloadMode>; downgrades: Map<string, string> }
```

- `resolveDownloadModes` — per task, in this order: `never` for
  `exec.remote: 'only'`; `eager` for policy `all` or a locally-placed
  task; `eager` for a requested or surfaced task under `toplevel`;
  `eager` for an ineligible producer, with the reason in `downgrades`
  (what `--dry` prints); else `deferred`. Groups get no mode. Under
  `all` the eligibility gate is not even computed.
- `deferralEligibility(nodes)` → ineligible ids mapped to the reason.

## The gate

A dependent's key folds an upstream's KEY, never its output content
(pure-input transitive hashing), so deferral cannot move a key that way.
The one real channel is a task whose `cache.inputs` can OBSERVE a
producer's outputs on disk — then its key differs by whether the bytes
arrived. Ineligible producers run `eager`; a refusal would break a
working build, so the gate is a DOWNGRADE, never an error.

Four ways to be ineligible, each conservative in the direction that
matters:

- a same-project reader whose input-glob static prefix can overlap one of
  the producer's output-glob prefixes (`src/**` vs `dist/**` cannot, and
  the coarse "same project" rule the design first sketched would have
  left `--download=none` with nothing to defer);
- any task declaring `cache.inputs.runtime` / `workspaceRuntime` — a
  shell command's reads cannot be bounded, and deferral SKIPS the output
  clean, so a stale prior build is exactly what it would sample;
- any task declaring `cache.inputs.workspaceFiles` (boundary-free);
- the producer declaring `cache.outputs.workspaceFiles` (root-anchored).

A leading wildcard yields prefix `.` and reaches everything; a cacheable
task with no declared `files` counts as reading its whole project.

## Invariants

- `--download` is a RunOption, never task config, and never folded into a
  key — it is transfer tuning and cannot change what a command produces.
- `exec.remote: 'only'` is `never` in both directions; `--download`
  cannot override it.

## Tests

`tests/download-policy.test.ts` (gate both directions incl. the
false-positive controls, mode resolution, and the e2e lifecycle).
