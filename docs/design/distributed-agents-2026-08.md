# Distributed agents: persistent workers + a synchronizer

**Status:** accepted, 2026-08-30. Supersedes the container-per-run agent pool
in `@vzn/vx-agents` and the Kubernetes backend removed the same day
(`agents-nomad-vs-k8s-2026-08.md` records why Nomad won that comparison; this
document explains why vx stopped provisioning altogether).

Nx Agents' concepts without the cloud UI: long-lived workers that keep a
checkout, a `node_modules` and a local cache between runs, and a small
rendezvous service that lets an ephemeral CI job talk to them.

## Why the pool model was wrong

The first design had `vx run` provision its own containers — docker locally,
Nomad on a cluster — prepare each one, and tear them down at the end. Two
things killed it.

**The expensive part died with the run.** Once workers had their own checkout
(the Nx model, chosen because a shared filesystem does not survive a real
cluster), every agent had to `git clone` and install before it was useful.
A pool that lives and dies with one `vx run` pays that on every CI run,
plausibly 30–60 s per machine kind, which can exceed everything distribution
saves.

**vx became infrastructure.** Provisioning meant vx held cloud credentials,
needed network reach to the Nomad API from inside a CI job, and had to push a
git token and cache credentials into a job spec that anyone with cluster read
access can see. Autoscaling, reaping and placement failure handling all became
vx's problem, and none of them are vx's business.

## The shape

    vx run (CI)  ──HTTPS──►  synchronizer  ◄──HTTPS──  worker … worker
         │                                                  │
         └──────────────── remote cache (CAS) ──────────────┘

Four parts, with ownership drawn deliberately.

**The fleet is the operator's.** A Nomad job, a compose file, a systemd unit —
whatever keeps N worker containers alive. Nothing in it is vx-specific and vx
never talks to it. Scaling it is Nomad Autoscaler's job or a human's.

**Workers persist.** A worker registers with the synchronizer and holds a
checkout, an install and a local vx cache. Per run it fetches the commit and
reinstalls only if the workspace fingerprint moved. A task it ran last week may
still be a LOCAL cache hit — a third tier below the remote cache, and a bigger
win than the install amortisation.

**The synchronizer is a rendezvous, not a coordinator.** It exists for one
structural reason: an ephemeral CI job cannot open a connection into a cluster,
and a worker cannot open one back to a job that may not exist in ten minutes.
Both can reach one HTTPS endpoint. It holds a run registry, an assignment queue
per run, a result and log stream back, and a worker registry with heartbeats.
It carries cache keys and metadata, never artifact bytes.

**vx keeps the scheduler.** Assignments are one task at a time, dispatched in
topological order by the `vx run` process. The run record, the summary and
`where` attribution never leave it. This is the line whose crossing got the
whole-run `backend` seam deleted on 2026-08-23, and it stays uncrossed: a
synchronizer that decided task order would be that seam again.

## Why one task per assignment

Nx assigns chunks and the agent runs each task's dependency closure, because Nx
Cloud does not schedule centrally. vx does. By the time an assignment reaches a
worker, every dependency has already run somewhere and its outputs are in the
cache — so the worker only ever RESTORES a dependency, never executes one.

That keeps the `executor` seam honest (`execute()` still means one task) and
keeps the correctness argument short: the worker computes the same cache key
core would, because it runs the same code over the same declared inputs at the
same commit.

## Results

Three kinds, three routes.

- **Exit code and logs** ride the synchronizer, live, so the CI terminal looks
  like an ordinary `vx run`.
- **Artifacts never travel worker→vx directly.** The worker saves its cache
  entry; anything that needs the bytes restores them. Another worker restoring
  a dependency is the normal path. The CI job pulling home the binaries it
  asked for is `--download=toplevel`, which already exists.
- **The run record** never left the submitter.

A remote cache therefore stops being optional. `agents()` without one is not a
degraded setup, it is one where every worker silently re-runs its upstreams —
so the plugin refuses at setup rather than allowing it.

## Placement: the one thing the synchronizer decides

Not order — _which worker_. It routes an assignment to the worker whose state
is closest: same commit (no fetch, no install, warm local cache), else same
branch, else anything eligible. vx cannot make that call because vx cannot see
the other runs. This is legitimately the fleet's business.

Eligibility is a match, not a provisioning instruction. A worker advertises
what it is; a task declares what it needs:

```ts
exec: {
  command: 'playwright test',
  resources: { cpus: 2, memory: 4096, image: 'vx-playwright' },
}
```

- `cpus` is CPU **cores** (fractional allowed), `memory` is **megabytes**.
  No percent forms: a percentage names a fraction of the local run's budget,
  which is meaningless for a machine somewhere else.
- `image` matches the worker's advertised image. It cannot conjure one —
  workers are the operator's.
- All three are pure PLACEMENT and are stripped from the cache key, so the
  same source hits the same entry whether it ran locally or on a worker.
  A task whose output genuinely depends on its toolchain says so with
  `cache.inputs.runtime`, which works locally too.

Nothing eligible is an error naming the task and what it asked for, not a
silent downgrade.

## Worker lifecycle

    register → idle → leased(run) → assignment* → idle → … → drain → exit

- **Register.** Advertise id, image, cores, memory, concurrency, and the
  commit currently checked out (if any).
- **Lease.** A worker serves ONE run at a time. Two concurrent runs at
  different commits cannot share a checkout, and per-run working directories
  would halve the value of a warm `node_modules`. Affinity routing recovers
  most of the utilisation an exclusive lease costs.
- **Sync.** On taking a lease: `git fetch origin <sha> && git checkout <sha>`,
  then `git clean` (excluding `node_modules`), then reinstall **only if** the
  workspace fingerprint moved — the fingerprint already covers `bun.lock`, so
  that decision is free.
- **Assignments.** A warm vx process, not `vx run` per task: the workspace is
  discovered and the config evaluated ONCE per lease. Per assignment it
  restores the task's dependency outputs from the cache, executes, saves the
  entry, and reports.
- **Recycle.** After N assignments or on a health-check failure, a worker
  drains and exits; the fleet manager replaces it. A worker alive for a week
  accumulates untracked files, orphaned processes and disk, and a poisoned one
  would otherwise fail every task it ever takes.

## Wire protocol (v0)

HTTP + JSON, long-poll for work, SSE for the stream back. Deliberately dull:
the point is that both ends can reach one endpoint through any firewall.

| Direction     | Call                              | Purpose                                   |
| ------------- | --------------------------------- | ----------------------------------------- |
| worker → sync | `POST /v0/workers`                | register; returns worker token            |
| worker → sync | `POST /v0/workers/:id/heartbeat`  | liveness + current commit                 |
| worker → sync | `GET /v0/work` (long-poll)        | claim the next assignment                 |
| worker → sync | `POST /v0/assignments/:id/output` | stdout/stderr chunks                      |
| worker → sync | `POST /v0/assignments/:id/result` | exit code, duration, key                  |
| vx → sync     | `POST /v0/runs`                   | open a run (commit, remote, requirements) |
| vx → sync     | `POST /v0/runs/:id/assignments`   | dispatch one task                         |
| vx → sync     | `GET /v0/runs/:id/events` (SSE)   | output + results                          |
| vx → sync     | `DELETE /v0/runs/:id`             | close; releases leases                    |

Latency matters: vx tasks are frequently 100–500 ms, so a poll interval would
dominate. Long-poll on `GET /v0/work` and SSE on the event stream keep the
round trip at one network hop.

**Orphans, both directions.** A run whose events stream drops and whose
heartbeat lapses is expired, its leases released and its in-flight assignments
cancelled. A worker that stops heartbeating has its in-flight assignment
reported failed so vx can re-dispatch. This is the part that is easy to defer
and expensive to defer.

## What core needs

Small, and general rather than agent-specific.

- `TaskPlacement.resources` — the DECLARED `exec.resources`, verbatim, so an
  executor that places work elsewhere resolves it against its own budget
  instead of this host's.
- `TaskExecutor.demand(remaining)` — the tasks still placed on this executor,
  after placement and after each completion. A pooled executor uses it to
  release capacity the run can no longer use instead of holding it to teardown.
- `exec.resources.image`, stripped from the key with `cpus`/`memory`.
- `cpus` in cores, `memory` in MB, percent forms removed — which deletes the
  budget-relative resolution in `orchestrator/resources.ts` rather than adding
  to it.

## Phasing

1. **Core seam** — the four bullets above, with pins.
2. **`@vzn/vx-sync`** — the synchronizer, in-memory state, one process.
3. **Worker mode** — a warm vx process that leases, syncs the checkout and
   serves assignments.
4. **`@vzn/vx-agents` becomes a client** — the `executor` capability dispatches
   through the synchronizer; all provisioning code is deleted.
5. **Operator recipes** — a Nomad job file and a compose file for the fleet.

## Rejected on the way here

- **A shared workspace filesystem** (bind mount / CSI RWX). Works on one host,
  needs a network filesystem across nodes, and vx stats thousands of files per
  run — a correctness question as much as a speed one, since `isOutputsCurrent`
  compares mtime at millisecond precision.
- **Fleeting/taskscaler** (GitLab's autoscaler libraries, MIT, standalone).
  A genuinely good lease broker with `Suspend`/`Resume` that preserves a VM's
  disk. Rejected because its `InstanceGroup` interface is VM-shaped — you scale
  a homogeneous group by count and connect over SSH — so heterogeneous machine
  kinds mean one statically-configured cloud instance group each, and because
  consuming it means a Go process in a Bun repo. If vx ever provisions again,
  this is where to start.
- **One GitLab CI job per vx task.** GitLab's Docker Autoscaler is the fleet
  broker we want, but its unit is a CI job: the scheduler leaves vx, cache hits
  stop being free (job allocation + checkout, seconds, against milliseconds
  today), and the design becomes GitLab-only.
- **Pre-warming to the graph's peak concurrency.** Peak is the wrong number —
  a graph that fans to 100 once and runs 1 thereafter would provision 100
  machines to use each of them once.
