# `src/orchestrator/stable-keys.ts` — shared stable-key derivation

## Purpose

Identifies tasks whose cache key is provably independent of any
upstream's OUTPUTS — the only tasks safe to probe/restore ahead of the
schedule. Factored out so remote-prefetch and the local short-circuit
can never drift on the stability gate.

## Public surface

- `deriveStableKeys(args)` — topo walk deriving every task's key the
  same way execute-task does; returns stable+cacheable non-group tasks
  with their keys.
- `dependsOnSiblingOutputs(node, upstreamOutputProjects, hasWsOutputUpstream)`
  — the conservative gate, fed the TRANSITIVE-upstream output producers
  `deriveStableKeys` accumulates in topo order. The key is preliminary
  (→ unstable) when a same-project upstream declares `outputs.files`
  (project-relative inputs read this project's dir), or the task reads
  `cache.inputs.workspaceFiles` (boundary-free) and ANY upstream declares
  outputs — `outputs.files` in any project OR `outputs.workspaceFiles`.
  Transitive because a producer reached through a no-output intermediate
  still poisons the key.
- `synthUpstream`, `topoOrder` — helpers.

## Invariants

- When unsure → unstable (lazy read-through is always correct).
- Reuses the run's `hashCache`; touches NO cache layer (keys only).
