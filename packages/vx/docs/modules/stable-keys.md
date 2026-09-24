# `src/orchestrator/stable-keys.ts` — shared stable-key derivation

## Purpose

Identifies tasks whose cache key is provably independent of any
upstream's OUTPUTS — the only tasks safe to probe/restore ahead of the
schedule. Factored out so remote-prefetch and the local short-circuit
can never drift on the stability gate.

## Public surface

- `deriveStableKeys(args)` — topo walk deriving every task's key the
  same way execute-task does; returns stable+cacheable non-group tasks
  with their keys. A persistent task gets no key, as on the live path,
  so its dependents fold nothing of it on either path (item 727:
  recording one gave them a second key a `--force` run never saved
  under; `keyed-projects.test.ts` R4 compares the two paths' keys).
- `dependsOnSiblingOutputs(node, upstreamOutputProjects, hasWsOutputUpstream)`
  — the conservative gate, fed the TRANSITIVE-upstream output producers
  `deriveStableKeys` accumulates in topo order. The key is preliminary
  (→ unstable) when a same-project upstream declares `outputs.files`
  (project-relative inputs read this project's dir), or the task reads
  `cache.inputs.workspaceFiles` (boundary-free) and ANY upstream declares
  outputs — `outputs.files` in any project OR `outputs.workspaceFiles`.
  Transitive because a producer reached through a no-output intermediate
  still poisons the key. A task with no `cache` block is a producer too,
  where `undeclaredWriteReach` (`sandbox-request.md`) says it may write:
  its own project counts as an `outputs.files` project, the rest of the
  workspace as an `outputs.workspaceFiles` producer, and a sandboxed one
  with no write grant as nothing (item 743: an uncached `gen` writing a
  same-project `build`'s declared input was classed stable, and seeds
  A,B,B,A replayed B on the fourth run, turborepo#13788).

The helpers (`synthUpstream`, `topoOrder`) are internal and not exported.

## Invariants

- When unsure → unstable (lazy read-through is always correct).
- Reuses the run's `hashCache`; touches NO cache layer (keys only).
