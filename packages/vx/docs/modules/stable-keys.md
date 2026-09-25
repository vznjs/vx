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

  A **cached** task may rewrite its own inputs in place (a formatter with
  `outputs: []`), and `commandWriteReach` says where: it counts only for
  a reader whose key does not fold its key, on some path of folds
  (`tasks: []`, or a filter that leaves it out). A key that folds the
  rewriter's names what it writes, since what it may rewrite are its own
  inputs; a key that does not was taken over the bytes before it (item
  750: the cached twin of 743's A,B,B,A, replaying B on the fourth run).
  So `deriveStableKeys` carries two sets per task: the projects of every
  cached rewriter upstream, and the subset its key does not fold. A
  dependency it does not fold hands over the whole first set, one it
  folds only its own uncovered subset (a rewriter behind an unfolded
  edge stays uncovered however many folds follow). A cached rewriter
  whose reach is every project — a sandbox grant elsewhere in the
  workspace, or a fingerprinted root file (`mayWriteFingerprint`) —
  makes an unfolding reader unstable; one it folds is already unstable
  itself and inherited. An **uncached** task that may rewrite a
  fingerprinted file (a root `pnpm install`) makes every reader after it
  unstable, folding or not: every key folds the fingerprint, and the
  run re-checks it before a lazy probe (`fingerprint-watch.md`).
  Only a key that leaves some dependency's key out can be preliminary
  for a cached rewriter, so a graph with no `cache.inputs.tasks` filter
  and no persistent task (which has no key to fold) builds none of the
  sets: building them cost about 2 ms (median) of a 27 ms memoised walk
  over the 3,000-task bench.

The helpers (`synthUpstream`, `foldedBy`, `topoOrder`) are internal and
not exported.

## Invariants

- When unsure → unstable (lazy read-through is always correct).
- Reuses the run's `hashCache`; touches NO cache layer (keys only).
