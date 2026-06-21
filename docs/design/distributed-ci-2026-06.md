# Distributed execution on CI — the killer-feature roadmap

Status: **Phase A-B SHIPPED 2026-06-21** (real coordinator + worker; see
`docs/progress/implementation-log-2026-06.md` Step 4). Phase C-E
deferred. Owner ask: "distributed tasks execution on CI easily." Builds
on `execution-service-2026-06.md` (the pluggable `RunBackend` + `vx
serve` foundation) and the cache layer cluster (local + remote,
Turbo-wire-compatible).

## Implementation snapshot (2026-06-21)

| Phase                                                                     | Status                                                                                                               | Commit / Files                                                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Phase A: Coordinator inside `vx serve`                                    | ✓ shipped (own subcommand, not inside `vx serve`)                                                                    | `src/cli/coordinator.ts`, `src/orchestrator/coordinator-prepare.ts` |
| Phase B: Multi-worker, `vx run --worker`                                  | ✓ shipped                                                                                                            | `src/cli/worker.ts`, `src/orchestrator/worker-exec.ts`              |
| Protocol extension (worker:\*, task:assign, cache:exists, coord:drain)    | ✓ shipped                                                                                                            | `src/orchestrator/protocol.ts`                                      |
| JSON-RPC 2.0 envelope adapters for distributed messages                   | ✓ shipped                                                                                                            | `src/orchestrator/wire.ts` (worker._ + coord._ namespaces)          |
| Per-node cache hash dispatch (content addressing for assignment)          | ✓ shipped                                                                                                            | `coordinator-prepare.ts:computeTaskHashForCoord`                    |
| Disconnect recovery (stranded in-flight → re-queued)                      | ✓ shipped                                                                                                            | `coordinator.ts websocket.close`                                    |
| End-to-end tests                                                          | ✓ shipped                                                                                                            | `tests/distributed-e2e.test.ts`, `tests/distributed.test.ts`        |
| Phase C: GHA composite (`vx/distributed-action`)                          | ✗ deferred — needs a real testbed                                                                                    |
| Phase D: Capability labels filter, critical-path priority, cache-affinity | ✗ deferred — predictive priorities are wired (Step 1); coordinator just doesn't read them yet                        |
| Phase E: Signed manifests, sparse-clone worker                            | ✗ deferred — HMAC signing already shipped for the cache layer (apps/cloud Step 5); the worker side is the open piece |

## 1. The one-paragraph pitch

A `vx run` on CI should saturate the available compute, regardless of
whether that compute is a single 64-core runner or fifty 2-core
runners spread across a matrix. Today every runner re-executes the
same graph in isolation, racing only against the remote cache for
hits. Tomorrow, a CI job posts its graph to a **coordinator**, every
matrix worker registers as an executor, and the coordinator dispatches
ready tasks to the least-loaded worker. Content addressing makes work
**fungible** — any worker producing artifact `<hash>` satisfies every
consumer of `<hash>` — so the system has no notion of "this task
belongs to this runner." The execution graph is one global queue, and
matrix parallelism becomes a perf knob the user dials without
restructuring their pipeline.

This generalizes the foundation that already exists: `serviceBackend`
already submits a `RunRequest` to an arbitrary origin and receives a
streamed `WireEvent` log + final `RunResult`. We extend it from
"one client, one service" to "many clients submit, many workers
execute, one coordinator routes" — same protocol, same content
addressing, fundamentally more parallelism.

## 2. Why this matters (vs. Turbo / Nx)

**Turbo Remote Cache** ships hits but never executes work for you.
A 30-package CI build on Turbo is a 30-package serial-or-shard exercise
on your CI host; the remote cache eliminates redundant _recompilation_
across runs, never _intra-run_ parallelism beyond `--concurrency`.

**Nx Cloud DTE** (distributed task execution) does ship this, but it
is a hosted-only commercial product. The OSS Nx CLI does not include a
self-hostable agent protocol; if you want DTE on your own infra you
write it yourself.

**vx's wedge**: ship a **self-hostable, OSS, Turbo-wire-compatible**
distributed-execution layer that runs on any CI provider (GitHub
Actions, GitLab CI, Buildkite, CircleCI, self-hosted Jenkins) with
zero new infrastructure beyond "a coordinator process that lives
during the build." Composes with the existing remote cache so warm
hits short-circuit dispatch entirely. Free DTE for everyone.

## 3. Topology

Three roles, all running the same `vx` binary in different modes:

```
                ┌──────────────────────────────────────────┐
                │  coordinator   (one per CI run/job)      │
                │  • global ready-queue                    │
                │  • assignment policy                     │
                │  • run state + event fan-out             │
                │  • cache-aware (asks "is hash present?") │
                └────┬─────────────────┬───────────────────┘
                     │ submit / stream │ subscribe (CI log + dashboard)
                     ▼                 ▲
┌─────────────────┐  │  ┌────────────────┐  ┌────────────────┐
│ submitter       │──┤  │ worker[0]      │  │ worker[N]      │
│ (`vx run`)      │  │  │ vx run --serve │  │ vx run --serve │
│  builds graph   │  │  │ --worker       │  │ --worker       │
│  attaches to    │  │  │                │  │                │
│  coordinator    │  │  │  pulls ready   │  │  pulls ready   │
└─────────────────┘  │  │  task; spawns; │  │  task; spawns; │
                     │  │  uploads cache │  │  uploads cache │
                     │  └────────────────┘  └────────────────┘
                     │           │                │
                     │           ▼                ▼
                     │  ┌───────────────────────────────────┐
                     │  │  remote cache (existing layer)    │
                     │  │  shared store of <hash>.tar.zst   │
                     │  └───────────────────────────────────┘
                     │
                     ▼
                  GitHub Actions log (stream)
```

**Coordinator** owns the global state: graph + cache key per node, the
ready frontier, which nodes are assigned/in-flight on which worker,
and the streaming event log. It runs on the CI job's "primary" runner
(any container with a port; on GHA, the matrix index 0 runner is fine)
and exits at end-of-graph.

**Workers** are stateless and fungible. Each runs `vx run --worker
<coord-url>`, opens a single websocket, registers with `{ capacity:
<concurrency>, capabilities: <labels> }`, then loops: pull next task,
spawn, stream output to coordinator, save to (local + remote) cache,
ack. No worker needs to know about any other worker.

**Submitter** is the CI script that wants the build done. It runs
`vx run lint test build --coordinator <coord-url>`, which is the
existing `serviceBackend` with a different transport variant. The
submitter sees the same `WireEvent` stream + framed output the local
backend produces today.

These roles **can collapse**: on a single-machine `vx serve`, one
process is coordinator + worker + submission target. The matrix
expansion is identical code paths, just more workers attached.

## 4. The wire (extension of today's protocol)

`orchestrator/protocol.ts` already defines `Server|ClientMessage` over
WS. We extend with two new message families — coordinator↔worker and
coordinator↔submitter — designed so a v0.5 client (today's `vx serve`)
keeps working unchanged:

```ts
// Coordinator-side messages (NEW)
type WorkerToCoord =
  | { t: 'worker:hello'; workerId: string; capacity: number; labels: string[] }
  | { t: 'worker:pull'; available: number } // backpressure-aware pull
  | { t: 'worker:start'; taskHash: string; pid?: number }
  | { t: 'worker:stdout' | 'worker:stderr'; taskHash: string; chunk: string }
  | { t: 'worker:done'; taskHash: string; outcome: WireOutcome } // outcome carries: exit, cpu, rss, cache provenance
  | { t: 'worker:bye'; reason: 'idle-timeout' | 'shutdown' }

type CoordToWorker =
  | { t: 'task:assign'; node: WireTaskNode; hash: string }
  | { t: 'cache:exists'; hash: string; present: boolean } // pre-spawn shortcut
  | { t: 'drain' } // graceful shutdown
```

Submitter↔coordinator reuses today's `RunRequest` → streamed
`WireEvent` → `RunResult` exactly. The submitter doesn't know it's
distributed; only the coordinator side changes.

**Content addressing is the invariant.** Every message keys off
`taskHash` (the existing pure-input v22 hash). The coordinator never
needs to "track" a task across runners — when `worker:done` arrives
with hash `H`, every downstream node that folds `H` becomes a
candidate for the ready queue, regardless of which worker produced it.
Output bytes live in the cache (local→remote), keyed by `H`, so the
next consumer that needs them pulls from there. The coordinator
forwards _log_ output back to the submitter; it does not move artifact
bytes.

## 5. Assignment policy

Naive first: **least-loaded** (worker with the most free capacity
gets the next ready task). Sufficient for homogeneous matrices. Three
extensions land as evidence demands:

1. **Capability labels.** A worker registers `labels: ['linux-x64',
'docker', 'gpu']`; a task can declare `runOn: ['gpu']` in its
   config and the coordinator only assigns to matching workers. Same
   shape as GitHub Actions `runs-on`; we adopt the syntax to remove a
   concept users already know.
2. **Cache-affinity hints.** A worker reports `recentHashes: [...]`
   (top-K LRU of locally-cached hashes) on each pull. When two
   workers can take a task and one already has the upstream's
   artifact warm in its local cache, prefer that worker — saves a
   remote download. Pure perf, no correctness implication.
3. **Critical-path priority.** The coordinator runs the topo-DP
   critical-path computation on the graph and prioritizes nodes on
   the longest remaining path. Today's scheduler does this in-process;
   the coordinator does the same across workers.

Priority + assignment is the _only_ moving piece in the coordinator.
Everything else is bookkeeping.

## 6. Failure modes (cataloged, each with a deliberate behavior)

| Failure                           | Behavior                                                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker disconnects mid-task       | Task transitions back to `ready`; reassign. Output of a dead task is uncacheable (process gone), so this is safe — we just re-execute on another worker.                                                                 |
| Worker disconnects after `done`   | Outcome is already in the coordinator + the artifact is already saved to the remote cache (worker uploads before `worker:done`). No loss.                                                                                |
| Coordinator dies                  | Whole run dies. The submitter receives `{ t: 'error' }` and falls back to local (the existing fail-safe). Acceptable — coordinator owns the run.                                                                         |
| Submitter dies                    | Coordinator detects WS close; **continues** the run (artifacts still go to remote cache for future runs to hit). This is the in-flight-dedup pattern from `execution-service-2026-06.md` generalized to dropped clients. |
| Network partition between workers | Workers don't talk to each other; nothing to partition.                                                                                                                                                                  |
| Coordinator OOM on huge graphs    | Per-task state is small (hash + status + slot). 100k tasks ≈ a few MB. Not a near-term concern.                                                                                                                          |

The cache layer's existing **never-fail** rule (remote errors → local
miss, run continues) extends naturally: a worker that can't reach the
remote cache uploads on retry queue; if it never recovers, the
artifact is local-only and the next consumer re-executes. Correctness
is preserved; only perf degrades.

## 7. The CI integration story (what the user types)

### 7.1 GitHub Actions (the dominant case)

A reusable composite action `vx/distributed-action@v1` (we ship it)
encapsulates the dance:

```yaml
jobs:
  build:
    strategy:
      matrix:
        worker: [0, 1, 2, 3, 4, 5, 6, 7] # 8-way parallelism
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: vznjs/vx-distributed-action@v1
        with:
          tasks: lint test build
          # Coordinator elected automatically — matrix.worker == 0 hosts it.
          # Others register as workers.
```

Behind the scenes:

- All matrix runners share a step in which they read a
  build-scoped token (GitHub's `${{ runner.os }}-${{ github.run_id }}-${{
github.run_attempt }}`) and a coordinator address (the public
  hostname of matrix `0`, exposed via tailscale/cloudflared/ngrok or
  the action's own short-lived tunnel).
- Matrix `0` runs `vx coordinator --tasks <tasks>` which builds the
  graph and listens for workers.
- Matrix `1..N` run `vx run --worker <coord>` which registers
  and starts pulling work.
- All N runners receive the same streamed output (every runner's job
  log shows the same run), so any one of them is enough for
  debugging. The coordinator's runner is the authoritative one — it
  exits with the run's exit code.

**No new infrastructure needed.** The action provides an ephemeral
tunnel between matrix workers via a short-lived `tailscale up
--authkey=<oauth-derived>` (free tier sufficient) OR via direct GH
runner IPs (when on self-hosted). Both are documented.

### 7.2 Generic CI (GitLab, Buildkite, …)

Same primitives, simpler shape — most CIs let you start a
"coordinator" service container that other jobs connect to. We
document the canonical patterns; the protocol is the contract.

### 7.3 Self-hosted runner farms

The compelling case. A company runs a fleet of `vx run --worker
$COORDINATOR` daemons on whatever beefy boxes they have (an old Mac
Studio in the corner, idle dev machines, dedicated farm hardware).
The CI submits the graph to a coordinator the daemons are already
attached to, work flows there. Coordinator is just `vx serve`
upgraded with the assignment policy. Self-hosted Nx Cloud, but free
and Turbo-cache-compatible.

## 8. Local DX (this isn't only for CI)

The same protocol powers a **local hivemind**: every developer's
laptop, when idle, can register as a worker against a team
coordinator. Your test run uses Alice's spare cores. This is the
**company-wide compute pool** the hosted-service entry hints at,
materialized without a hosted service.

We don't have to ship this on day one, but the protocol must not
preclude it. The same gating rules apply: opt-in, network-bounded
(team VPN / tailscale), capability-labeled (don't run my untrusted
worker on Alice's GPU).

## 9. Sandboxing (the trust story)

A worker executes arbitrary shell strings from another machine. This
is a sharp tool. Mitigations, in order:

1. **Default deny untrusted submissions.** A worker only accepts
   `task:assign` for tasks whose `taskConfigHash` it can verify
   against a _signed manifest_ the submitter pre-published. The
   manifest pins every task's command + inputs + env capture, signed
   with the same HMAC key vx already uses for the remote cache. A
   worker that can't verify the manifest refuses the assignment.
2. **Existing sandbox layer.** Tasks with `sandbox: {}` already run
   under SRT (macOS) / bwrap (Linux) with strict allow/deny lists.
   Distributed exec turns this on by default for tasks coming from a
   non-local coordinator — you can dial down per-task as needed.
3. **No sibling visibility.** A worker holds the bare minimum
   workspace: a sparse clone keyed by the task's `inputs.files` +
   `workspaceFiles` glob set. Materialized from the remote cache or
   git directly. Workers never see code they don't need.

The honest framing: distributed CI on trusted self-hosted infra works
today with item 2 alone. Items 1 + 3 are what unlock "rent a worker
from anywhere."

## 10. Phasing (each phase ships independent value)

| Phase | Ships                                                                                                                                                         | Validates                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **A** | Coordinator role inside `vx serve`. One worker (the same process). All-in-one binary. The submitter pattern works end-to-end against a single in-proc worker. | The protocol is sound. No new transport surface.                                       |
| **B** | Multi-worker. `vx run --worker <coord>`. Least-loaded assignment. Cache-affinity hints deferred.                                                              | Multi-process work flows; failures handled per §6.                                     |
| **C** | GitHub Actions composite. Matrix orchestration as documented in §7.1. Real CI smoketest.                                                                      | The user-facing story is real. Numbers from a real monorepo on real GHA.               |
| **D** | Capability labels + critical-path priority + cache-affinity. Submitter retry on coord failure.                                                                | Production-grade. Heterogeneous fleets work.                                           |
| **E** | Signed manifests + sparse-clone worker. Trust story for "rent a worker."                                                                                      | Hosted/3rd-party-worker viable. Foundation for `vx cloud` (see `vx-cloud-2026-06.md`). |

Phase A is small (the in-process refactor: extract `WorkerLoop` from
the existing scheduler; the coordinator hosts a queue the worker
pulls from). Each subsequent phase is a horizon, not a feature flag —
no half-built coordinator behind a flag, ship it or don't.

## 11. Performance North Star

The promise the architecture makes:

> A `vx run` of an N-task graph, parallelism-bound on K workers,
> completes in time _T(serial) / min(K, P)_ where P is the graph's
> critical path. Cache hits are subtracted from `T(serial)`. The
> distributed-coordination overhead is sub-second for graphs ≤ 10k
> tasks.

This is **better than Turbo** (whose CI-side parallelism is bounded
by one runner's `--concurrency`) and **comparable to Nx DTE** (which
ships this behavior in their hosted product). The differentiator is
that vx ships it as OSS, self-hostable, free.

## 12. What this means for the docs / DX surface

- `vx coordinator [tasks...]` — new top-level subcommand. Builds the
  graph + opens the WS; exits when the graph is done.
- `vx run --worker <url>` — flag on existing `vx run`. Stateless
  worker loop.
- `vx run --coordinator <url>` — submission against an external
  coordinator. Resolves to `serviceBackend(<url>, sink)`.
- One new page `docs/distributed.md` (matched in `apps/docs/`)
  walking the CI integration end-to-end with the GHA action.
- `docs/comparison.md` updated to flip "distributed CI" from gap to
  shipped, with the SLO from §11 as the headline.

## 13. Non-goals (deliberately scoped down)

- **Cross-language workers.** Workers run the same Bun runtime; we
  don't define a language-agnostic execution gRPC. (A `vx worker
--shell-only` mode might come later for non-Bun infra, but it
  doesn't change the protocol.)
- **Cluster scheduling.** We're not building Kubernetes. A worker is
  a long-lived process; orchestrating _its_ lifecycle is the user's
  job. We provide health endpoints and graceful drain.
- **Persistent run history.** The `runs` table already records what
  ran; that's enough. The coordinator is ephemeral by design.

## 14. Open questions (tracked, not blocking)

- **Backpressure on stdout fan-out.** A worker streams every byte to
  the coordinator, which fans out to every connected submitter. If
  10 submitters watch the same run, that's 10× egress for each
  stdout chunk. Solution path: only the _primary_ submitter (first
  to attach) gets full output; secondary submitters subscribe to a
  reduced channel (status + summary). Defer until measured.
- **Eviction of stale `recentHashes` hints.** A worker that's been
  up for hours has a degraded LRU; the affinity hint becomes stale.
  Worker periodically reposts. Bounded staleness OK — affinity is a
  hint, not correctness.
- **Coordinator HA.** Single point of failure. For a CI build it's
  fine (one job, one coordinator); for a long-lived hosted
  deployment, a coordinator restart drops the run. The hosted-cloud
  proposal addresses this; locally we accept it.
