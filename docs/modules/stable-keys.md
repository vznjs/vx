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
- `dependsOnSiblingOutputs(node, nodes)` — the conservative gate: a
  same-project upstream with declared `outputs.files`, or a
  `workspaceFiles` read overlapping an upstream's workspace outputs,
  makes the key preliminary → unstable.
- `synthUpstream`, `topoOrder` — helpers.

## Invariants

- When unsure → unstable (lazy read-through is always correct).
- Reuses the run's `hashCache`; touches NO cache layer (keys only).
