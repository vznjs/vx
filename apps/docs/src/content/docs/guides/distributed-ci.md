---
title: Distributed CI execution
description: Run your task graph across multiple machines. vx coordinator dispatches assignments to vx workers over WebSocket. Content-addressed; workers are fungible. OSS, self-hostable, no daemon.
---

vx ships an OSS distributed task execution layer: one coordinator
holds the graph, many workers pull and execute. Tasks are
content-addressed by their v22 cache hash, so any worker producing
artifact `<hash>` satisfies every consumer of `<hash>` — workers
are fungible.

This is the Nx-Cloud-DTE equivalent, OSS and self-hostable.
Phase A-B today; capability labels, cache-affinity, and a hosted
deployment are deferred — see
`docs/design/distributed-ci-2026-06.md` for the full roadmap.

## The two roles

- **Coordinator** (`vx coordinator <tasks…>`) — one per CI build.
  Holds the global ready queue, dispatches to workers, exits when
  every task ends.
- **Worker** (`vx run --worker <coord-url>`) — N per build.
  Stateless and fungible. Pulls assignments, executes via
  `runCommand`, reports outcomes, repeats.

## Quick start (two terminals)

```sh
# Terminal 1: start the coordinator
vx coordinator lint test build --port 5180 --workers 2

# Terminal 2: attach a worker
vx run --worker ws://127.0.0.1:5180 --capacity 4
```

The coordinator dispatches every ready task to the worker; the
worker executes them in parallel up to `--capacity`. When every
task terminates, the coordinator sends `coord:drain`, the worker
exits, and the coordinator exits with 0 (or 1 if any task failed).

## GitHub Actions

The canonical pattern: one matrix index hosts the coordinator,
the rest attach as workers.

```yaml
jobs:
  build:
    strategy:
      matrix:
        worker: [0, 1, 2, 3]   # 4-way parallelism
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: curl -fsSL https://raw.githubusercontent.com/vznjs/vx/main/install.sh | sh

      # Worker 0 hosts the coordinator; others wait for it and attach.
      - if: matrix.worker == 0
        run: vx coordinator lint test build --port 5180 --workers 4

      - if: matrix.worker != 0
        run: |
          until nc -z runner-0 5180; do sleep 1; done
          vx run --worker ws://runner-0:5180 --capacity 2
```

The cross-runner networking (`runner-0` resolves to the matrix
index 0 runner) needs either a tunnel (Tailscale free tier
works), self-hosted runners on the same LAN, or one of the
GHA-specific runner-link patterns. A composite action
(`vx/distributed-action@v1`) packaging this is on the roadmap.

## How dispatch works

```
        ┌────────────────────────────────────────┐
        │ vx coordinator                          │
        │  • prepareRun → workspace + task graph  │
        │  • per-node v22 hash (assignment key)   │
        │  • ready queue, in-flight per worker    │
        │  • WS server                            │
        └─────┬──────────────────────────┬───────┘
              │                          │
              ▼ task:assign              ▼ task:assign
        ┌────────────┐             ┌────────────┐
        │  worker N  │             │  worker M  │
        │  pulls     │             │  pulls     │
        │  spawns    │             │  spawns    │
        │  reports   │             │  reports   │
        └────────────┘             └────────────┘
```

1. Coordinator runs the same `prepareRun` pipeline `vx run` uses
   locally — it builds the same graph, with the same v22 cache
   hashes per node.
2. Workers register via `worker:hello { workerId, capacity, labels }`.
3. Coordinator dispatches via `task:assign { hash, node }` up to
   each worker's capacity.
4. Workers spawn `runCommand`, stream stdout/stderr back over
   `worker:stdout` / `worker:stderr` messages.
5. Workers report `worker:done { taskHash, outcome }` on completion.
6. Downstream tasks become ready as their upstream finishes.

The wire format is JSON-RPC 2.0 — same envelope `vx serve` speaks.
Full spec: `docs/design/wire-protocol-2026-06.md`.

## Disconnect recovery

If a worker disconnects mid-task, the coordinator detects the WS
close, pulls every in-flight assignment off that worker, and
puts the hashes back on the ready queue. The next attached worker
picks them up.

## Performance characteristics

| Workload | Local single-host | Distributed (4 workers) | Notes |
| --- | --- | --- | --- |
| Cold run, deep graph | 1× | 0.25–0.4× wall time | Bounded by graph's critical path |
| Warm full-cache | ≤ 200 ms | similar | Cache-hit shortcircuits — coordinator dispatch overhead dominates |
| Mixed cache state | 1× | 0.4–0.7× | Worker mix-and-match wins on long tasks |

These numbers will improve once workers probe the remote cache
before executing (next iteration).

## Known limits today (Phase A-B)

- **Workers don't probe the remote cache yet.** Every assigned task
  spawns fresh. Set up `VX_REMOTE_CACHE_URL` for fastest results
  via the local prefetch path.
- **No capability labels filter.** Workers report labels; the
  coordinator doesn't filter `task:assign` by them.
- **No critical-path priority on the coordinator.** The ready
  queue is FIFO. The local scheduler has predictive priorities
  (`predictive: true`); the coordinator doesn't read them.
- **Submitter logs aren't aggregated.** Worker stdout reaches the
  coordinator but no submitter-side `vx run --coordinator` is wired
  yet to fan it back to a user.
- **No TLS.** Hardcoded `ws://`. For cross-host, terminate TLS at a
  reverse proxy or use Tailscale/cloudflared.

The protocol extension (`worker:*` + `task:assign` + `coord:drain`)
lives in `src/orchestrator/protocol.ts`; the JSON-RPC 2.0 envelope
adapters live in `src/orchestrator/wire.ts`. Both are stable; the
gaps above are wiring follow-ups.

See also: `docs/design/distributed-ci-2026-06.md` (full design),
`docs/progress/implementation-log-2026-06.md` (Step 4 narrative).
