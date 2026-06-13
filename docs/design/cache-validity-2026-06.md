# Validity-filtered caching (replaces output-fold early cutoff)

Status: **deferred** (2026-06-13). A complete, green foundation is
built on branch `claude/cache-validity` (CACHE v22 / SCHEMA v21) and
NOT merged. Deep review found it correct but **perf-neutral as built**:
the execute path still derives `artifactId = H(inputKey + expects)`
mid-run and cascades exactly like v21, and `probeByInputKeys` (the
upfront batch — the entire point) is unwired. Merging would bump
`CACHE_VERSION` (one forced rebuild for every user) for zero current
benefit. The real win needs a phase-2 orchestrator rewrite (consume
the batch probe → resolve validity upfront → parallel-restore), which
is a sizeable, risky change to the hottest path for a cascade cost we
have never measured. Revisit only when a warm-run profile shows the
per-task cache cascade is actually material. The one genuinely
valuable finding from the review — the skip-restore staleness bug —
was extracted and fixed on `main` independently (see decision log).

## The problem with output-fold (v21)

Today a downstream key folds its upstream's `outputsHash`:

```
key(app) = H(app.inputs + config + … + outputsHash(lib))
```

Because the upstream's _output identity_ is inside the key, you cannot
look `app` up until `lib` has resolved — so even a fully-cached run
walks the graph top-to-bottom, one SQL read gating the next. There is
no way to know the plan upfront, no batched probe, no parallel restore.
Output bytes must be hashed to derive keys.

The cutoff it buys (an upstream that re-runs but emits byte-identical
output doesn't cascade misses) is real but was adopted speculatively
from vite-task (`c57be80`), never measured against a workload.

## The reframe

Keep the exact same cached data, but **move the upstream output out of
the lookup key and into a stored, filterable attribute.**

```
input_key(task) = H(own inputs + env + config + pkg.json + ws-fingerprint)
                  └── NO upstream component. Filesystem-derivable upfront.

entry stores:  expects = { dep_id: outputsHash(dep) at build time }   (per direct dep)
artifact_id    = H(input_key + expects)        ← the <id>.tar.zst filename

A cached entry is a VALID hit iff:
  its input_key matches the task's current input_key
  AND for every direct dep, dep's CURRENT outputsHash == expects[dep]
```

Multiple entries may share an `input_key` (same own-inputs, different
upstream-output states) — they differ by `expects` and therefore by
`artifact_id`. This is identical storage to v21 (one artifact per
distinct input×upstream-output combination); only the **index**
changes: `input_key` becomes a queryable column so the stable part is
batch-probeable, and `expects` becomes a filter instead of being baked
into the primary key.

### Why this dominates

- **Upfront plan**: every `input_key` is filesystem-derivable, so one
  parallel pass + one batched `WHERE input_key IN (...)` yields all
  candidate rows before anything runs.
- **Parallel restore**: confirmed hits restore in any order (snapshots
  are self-contained) — no topological wait on a fully-cached run.
- **Cutoff preserved**: a miss that emits a stable output lets a
  pending dependent's candidate match → rescue (restore instead of
  run).
- **Multi-state preserved**: branch ping-pong keeps both rows under one
  `input_key`; the filter picks the one matching current upstream
  output.
- **Output hashing only on execute**: never on the upfront decision,
  never on a hit. Folded into the save pass (tee bytes through xxh3
  during tar/zstd — no second walk over big artifacts).

## Decision flow

1. **Upfront, parallel.** Compute every task's `input_key`. One
   batched probe groups candidate rows per task.
2. **Settle the easy majority in-memory (no execution).**
   - No candidate rows → **definite miss**.
   - Candidates exist AND all direct deps are themselves confirmed
     hits → compare `expects` against each dep's chosen row's
     `outputs_hash` (already in hand) → **hit** (pick matching row) or
     **miss**.
3. **Defer only miss-chains.** A candidate whose validity hinges on a
   dep that is a not-yet-executed miss is **pending** that dep.
4. **Execute misses topologically** (genuine data dependency — the
   command reads upstream files off disk). On finish, compute
   `outputsHash` in the save pass. Re-evaluate pending dependents:
   - a pending dependent's candidate now matches → **rescue** (restore,
     don't run);
   - else it runs and saves a fresh row (`expects` = the dep output
     hashes it actually consumed).

## Async, non-blocking output hashing

The output hash must never gate a worker.

- **Folded into save**: the save path already reads every output byte
  to tar+zstd it; tee through xxh3 in the same streaming pass. Not a
  separate pass.
- **Worker-yield rescue**: when a miss completes, its dependents do not
  hold a worker waiting for the hash — they return to the ready queue
  with a pending rescue-check while workers pull other ready tasks. On
  any wide graph the hash resolves off the critical path; on a
  degenerate narrow chain the only cost is hash latency (tens of ms)
  vs the multi-second rebuild it may save.
- **`expects` backfill + drain**: an entry's artifact is written
  immediately; its `expects` columns are filled as upstream hashes
  resolve. At run end, drain any pending hashes before closing the DB
  (execution is already done — off the critical path). An entry with
  un-backfilled `expects` is treated as "revalidate by re-running"
  (safe; forfeits one hit) if the process dies mid-drain.

## Remote cache

Remote probing parallelizes the same way: for a task whose deps are all
hits, `expects` (hence `artifact_id`) is known upfront → batch the
remote existence/fetch checks. Pending-on-miss tasks probe remote once
their upstream resolves. Same `onRemoteError` → miss degradation.

## Edge cases

- **No declared outputs**: `expects` for a dep with no outputs is the
  dep's task-hash fallback (matches today's no-outputs behavior — a
  side-effect task always invalidates dependents on input change).
- **Group tasks**: no exec, no artifact; a group's "output identity"
  rolls up its members' identities (as today).
- **`--dry`/plan**: predicts using the same batch-probe + validity
  logic; pending-on-miss tasks are reported as misses (the dry path
  can't know a not-yet-run output) — documented divergence, matches the
  conservative direction.

## Migration

Pre-alpha. Bump `CACHE_VERSION` + `SCHEMA_VERSION`; old entries drop on
first run (schema gate already does this). Old artifacts orphan and
reap on `vx cache prune`.

## Test plan

- Re-pin the two v21 cascade tests to the new contract (identical
  output → dependent rescued/hit; output change → dependent reruns).
- Validity unit tests: input_key stable across upstream change;
  expects-match → hit; expects-mismatch → miss; multi-row pick.
- Upfront batch: all-hits run does ONE probe, restores without topo
  order (assert no per-layer serialization).
- Rescue: miss with stable output rescues a pending dependent;
  miss with changed output reruns it.
- Multi-state: build state A, state B, back to A → A hits (branch
  ping-pong).
- Async hashing: a miss completing does not block a sibling/dependent
  worker on the hash (assert via injected slow-hash + scheduler order);
  run-end drain backfills `expects`.
- No-outputs task: dependents invalidate on its input change.
