# Universal agents & pools — design

> **Status:** proposal (2026-07-04); Phase 1 implemented same day.
> **Builds on / inherits (not re-litigated):** `distributed-execution-2026-07.md`
> (the shipped agents model — session registry, same-checkout correctness law
> §6, `deriveStableKeys`, artifact-store transport, `SUBMITTER_LABEL`
> self-registration); the one-connection cloud model + trust scopes (decision
> log 2026-07-04); provider-neutral core (core `src/` names no vx-cloud). This
> design does **not** touch the correctness law, the wire hash equality, or
> trust scoping — it changes _when/how_ a pool is engaged and _who_ is in it,
> not _how a task's key is derived_.

## What we're solving

Today distribution is a CI-shaped, per-run opt-in: `VX_CLOUD_DISTRIBUTE=<n>` +
a reachable serve, hard-error if the serve is down. The local machine
participates only as the self-registered submitter-agent. The owner's vision is
broader and simpler: **a run is work submitted to a pool; this machine is
always a member of the pool; adding capacity (helper boxes, CI agents, cloud
burst) is incremental and never changes how you type `vx run`.** "Small stays
fast; big scales" — the degenerate pool (self only) must remain byte-for-byte
today's in-process run.

The good news from the code: the universal primitive already exists.
`runAgentLoop` (`dist/agent-loop.ts`) is hosted identically by `cli/agent.ts`
and by `dist/submit.ts`'s in-process self-registration. What's missing is (a)
**ambient enablement** (a connected pool should distribute without a per-run
env var, and fail _safe_ to local, like delegation), (b) **capacity-awareness**
(don't pessimize a solo run by routing it through a serve with no helpers
present), and (c) an **honest roadmap** from the shipped submission-scoped pool
to a standing shared pool.

## A. Target architecture — the universal pool model

**A pool is a set of agents rendezvoused by a serve. A `vx run` submits its
task graph to the pool. This machine is always in the pool.** Three roles,
which collapse by scale:

| Role                                                   | Entry                                                                  | What it owns                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **serve** (rendezvous/coordinator)                     | `vx-cloud serve` → `AgentRegistry` + `DistScheduler` + `ArtifactStore` | session registry, per-submission scheduling, the artifact transport             |
| **agent** (pool member that executes)                  | `vx-cloud agent` → `runAgentLoop`                                      | pull assignments, run them as scoped core `run()`s, upload artifacts            |
| **submitter** (member that owns the graph + exit code) | `cloud().backend()` → `distributedBackend` → `runAgentLoop` (self)     | build the graph, submit, self-register as an agent, render, materialize outputs |

The universal agent primitive is **`runAgentLoop`** — one loop, two hosts
(standalone process and in-process submitter). Local, CI, and cloud agents are
_the same binary and the same loop_; they differ only in **where they run** and
**who owns their lifecycle** (a dev's spare box / a CI matrix / a k8s
Deployment / a burst autoscaler). This is the "universal" claim, and it is
already ~90% true in code; the design formalizes it and removes the artificial
split between "the submitter's local-degrade path" and "the remote-agent path."

### The collapse that keeps the fast path sacred

The invariant "zero hot-path overhead when no pool is configured" is preserved
not by routing a solo run through a pool-of-one, but by **collapsing to
`localBackend()` whenever the pool has no reachable external capacity.**

```
pool = {self}                 pool = {self + helpers, one submission}   pool = {standing agents, many runs}
  no serve, no wire             serve rendezvous, submission-scoped         serve rendezvous, multi-run
  in-process run() → localBackend            DistScheduler (today)             multi-run scheduler (NEXT)
  == today, 0 overhead          CI matrix / solo multi-machine              team pool / cloud burst
```

The decision to leave the fast path is **config-gated** (a pool is _configured_:
`VX_CLOUD_DISTRIBUTE`, or a connected environment with `distribute`) and then
**capacity-gated** (for ambient pools, actually distribute only when helpers are
present). No config → the `backend()` rung declines with one env read →
`localBackend()`. That is the whole reason the plain run stays fast.

### Two pool topologies (be honest about the seam)

The shipped `AgentRegistry` is **submission-scoped**: agents register to
`{workspaceId, session}`, one active submission at a time, sequential
submissions reuse the agents. This is _correct and sufficient_ for:

- **CI pipelines** — session = `gh-<runId>-<attempt>`, agents = the matrix, one
  `vx run ci` submission (or sequential `lint` then `test`).
- **Solo dev + own helper machines** — session = `local`, all the dev's
  machines share `{repoId, local}`, one run at a time.

It is **not** sufficient for a **standing shared team pool** (long-lived agents,
_multiple devs' runs concurrently multiplexed with fairness_). That is the
cross-run queueing/fairness the shipped design deliberately fenced. This design
keeps the fence for now but names the evolution precisely (§D #7): the standing
pool is a _scheduler_ evolution on the _same_ registry + `runAgentLoop`, not a
new component. Submission-scoped is the floor; the standing pool is the ceiling;
the architecture is the same three roles at both ends.

## B. The easy-start → scale ladder

Each tier is additive; **the `vx run` command never changes.**

### Tier 0 — Solo local (default, zero config)

```
vx run build
```

No serve, no plugin config engaged. Core's scheduler already parallelizes across
**all cores of this machine**. `cloud().backend()` finds no pool configured →
declines → `localBackend()` → in-process `run()`. Byte-identical to today.

> **Anti-misconception:** a _single_ machine does **not** benefit from a pool —
> its cores are already saturated by core concurrency in one process. A pool
> only helps with **multiple machines**. Tier 1 is the first tier a pool does
> anything.

### Tier 1 — Personal multi-machine pool

```
# on the host box (e.g. the beefy desktop, likely already running the dashboard):
vx-cloud serve
vx-cloud agent --url http://desktop:4321        # this box also executes
# on each helper box (same git checkout, same commit):
vx-cloud agent --url http://desktop:4321
# once, on the machine you type `vx run` on:
vx-cloud connect http://desktop:4321 --distribute
```

Then, forever after: `vx run build` fans out across desktop + helpers and leaves
`dist/` populated locally. **Under the hood (the Phase 1 delta):** `--distribute`
writes `distribute` onto the connected environment (mirrors `--delegate`).
`cloud().backend()` reads `activeEnvironment()?.distribute` and — **only when
helpers are actually present** (a one-GET capacity probe) — returns
`distributedBackend` in **ambient mode**: serve down or **zero remote agents →
silently run locally** (Tier 0 speed); helpers present → distribute.

### Tier 2 — Ephemeral CI agents (today's model, now ambient)

```yaml
# main job:
- run: vx-cloud connect "$VX_CLOUD_URL" --token "$VX_CLOUD_TOKEN" --distribute
- run: vx run ci
# agent jobs (matrix of N):
- run: vx-cloud agent --url "$VX_CLOUD_URL" --token "$VX_CLOUD_TOKEN"
```

Enablement is the connection's `distribute` instead of `VX_CLOUD_DISTRIBUTE=<n>`
in every step. CI keeps **hard-provisioned** semantics via the explicit path
(`VX_CLOUD_DISTRIBUTE` remains as the explicit, hard-error escape hatch): submit
regardless of the instantaneous agent count (agents may join ms after submit).

### Tier 3 — Standing shared team pool (NEXT — needs the multi-run scheduler)

```
# a deployed serve; long-lived agents (systemd / k8s Deployment):
vx-cloud agent --url https://vx.team.internal --token … --session team-pool
# any dev:
vx-cloud connect https://vx.team.internal --token … --distribute
vx run test    # multiplexed across the standing pool alongside teammates' runs
```

**Under the hood (not built here):** the registry's one-active-submission-per-
session becomes a **multi-run scheduler** — a session holds a _queue_ of
submissions fairly interleaved across shared agents. Everything else (registry,
`runAgentLoop`, artifact transport, correctness law) is unchanged.

### Tier 4 — Cloud autoscale burst (NEXT — vx emits the signal, not the fleet)

```
# an autoscaler (k8s HPA / a small controller / a GH matrix sizer) reads:
GET /v1/agents?ws=<id>&session=<s>   →  { agents, capacity, ready }
# and scales `vx-cloud agent` replicas up/down.
```

vx **emits queue-depth + capacity** and owns _task placement only_. Machine
lifecycle stays with k8s / the CI matrix / the controller — a managed fleet is a
permanent non-goal.

## C. Streamlining plan

1. **Ambient enablement replaces the per-run env var.** Before: `export
VX_CLOUD_DISTRIBUTE=2` before every run. After: `vx-cloud connect <url>
--distribute` **once**; the connection carries the execution policy exactly
   as it already carries `delegate`. `VX_CLOUD_DISTRIBUTE` stays only as the
   explicit hard-provisioned escape hatch.
2. **Ambient distribution fails _safe_, not _hard_.** `distributedBackend`
   gains `mode: 'explicit' | 'ambient'`. Explicit (env/opts) → unreachable is a
   hard error, submit regardless of agent count (CI). Ambient (connection) →
   unreachable **or zero remote capacity → run locally** (delegation's fail-safe
   rule — the same fall-through that already handles dirty-tree / forwardArgs /
   persistent / non-remote-cache gates).
3. **Name + dedup the universal agent primitive.** `cli/agent.ts` and
   `dist/submit.ts` independently derive session, capture git/identity, and set
   the cache env. Extract shared helpers (a future `dist/membership.ts`) so "the
   submitter is just an in-process agent" is literal in code. `runAgentLoop`
   stays the single loop. (Deferred past Phase 1.)
4. **Env-var surface.** No new user-facing env vars; one (`VX_CLOUD_DISTRIBUTE`)
   demoted from "required" to "escape hatch." Policy lives on the connection.
5. **`<n>` becomes advisory-optional.** `--distribute` with no argument is valid
   (`distribute: true`); an explicit count is allowed but never required.

## D. Complete-CI gap analysis (ranked, tagged)

1. **Ambient pool enablement (connection `distribute`)** — the local-pool
   keystone. `plugin.ts` + `environments.ts` + `cli/env.ts`. **SHIP NOW (P1).**
2. **Fail-safe ambient distribution** — an always-on connection degrades to
   local when the pool is down. `dist/submit.ts`. **SHIP NOW (P1).**
3. **Capacity gate for ambient distribution** — without it, ambient distribute
   _pessimizes solo runs_. `registry.availableCapacity` + `GET /v1/agents`.
   **SHIP NOW (P1).**
4. **Agent heartbeat / liveness** — `AgentRegistry` detects death only on WS
   `close`; a half-open TCP agent stalls its in-flight tasks for the OS TCP
   timeout. Add `lastSeenAt` + a sweep reusing `onAgentLeave` reassignment.
   **NEXT.**
5. **Queue-depth / capacity signal endpoint** — the autoscaling input (Tier 4)
   and the P1 capacity gate are the same data. P1 ships the _counts_; the
   _ready-queue depth_ for autoscaling is a small follow-on. **SHIP NOW (counts)
   / NEXT (ready depth).**
6. **Turnkey CI recipes** — a GitHub Actions composite action + reusable
   workflow (main job + agent matrix, `connect --distribute`), plus a GitLab
   `include`. **NEXT.**
7. **Standing shared pool + multi-run fair scheduler** — the
   one-active-submission-per-session rule blocks concurrent runs on a shared
   standing pool. Evolution: a session holds a submission _queue_; the scheduler
   round-robins ready tasks across shared agents with per-submission fairness;
   `commitSha` enforcement becomes per-submission. Large but self-contained
   (registry + scheduler; `runAgentLoop` + correctness law untouched). **NEXT
   (the big one).**
8. **Intra-task sharding** (split one 20-min test task across agents) —
   **NON-GOAL** for the pool layer. vx's unit of distribution is the _task_
   ("one command per task" + "shell is the API"). Sharding needs the command to
   be shard-aware; the right shape is a future task-config convention (`shards:
n` → n sibling assignments with `VX_SHARD_INDEX`/`VX_SHARD_TOTAL`) — a
   separate design.
9. **LAN pool auto-discovery (mDNS)** — **NON-GOAL / optional.** `connect <url>`
   (or a shared `environments.json`) is explicit and sufficient.
10. **Managed autoscaler / fleet controller** — **NON-GOAL (permanent).** vx
    emits signals (#5); k8s HPA / the CI matrix / a thin controller owns machine
    lifecycle.
11. **Multi-tenancy / per-workspace ACLs** — **NON-GOAL (unchanged):** one
    bearer per serve; trust _tiers_ are server-derived and already handle
    fork-PR isolation.
12. **Input shipping (distribute a dirty tree)** — **NON-GOAL (permanent),**
    fenced by the same-checkout contract: dirty trees run locally.

## E. Phase 1 — the shipped slice

**Goal:** a connected pool distributes `vx run` with no per-run flag, stays as
fast as today when no helpers are present, and never breaks a run when the pool
is down. Provider-neutral (all in `@vzn/vx-cloud`), hot-path-safe (only engages
when an environment is connected _with_ `distribute`), no core change, no
`CACHE_VERSION`/`SCHEMA` bump, correctness law untouched.

### Seam changes

1. **`environments.ts`** — `EnvironmentEntry.distribute?: number | boolean`
   (mirrors `delegate?`), threaded through the validator (drop-unknown, so no
   `ENVIRONMENTS_VERSION` bump — additive-optional, safe both directions) and
   `CloudEnvironment`.
2. **`cli/env.ts`** — `parseConnectArgs` accepts `--distribute` (→ `true`) and
   `--distribute=<n>` / `--distribute <n>` (→ integer), alongside `--delegate`;
   `connectCmd` persists it; `env ls` shows a `distribute` column.
3. **`dist/registry.ts`** — `availableCapacity(workspaceId, session)` → counts
   of agents/capacity, "remote" = agents whose `labels` exclude
   `SUBMITTER_LABEL`. Pure read.
4. **`cli/serve.ts`** — in the `/v1/agents` block, a non-WS-upgrade GET returns
   `availableCapacity` JSON (behind `authorized()` + the Origin gate). `?ws=` +
   `?session=`; unknown → zeros.
5. **`dist/submit.ts`** — `DistributedBackendOptions.mode: 'explicit' |
'ambient'` (default explicit). Ambient replaces the `reachable()` check with
   a capacity probe: network error → `fallback('pool unreachable')`;
   `remoteAgents === 0` → `fallback` silently (fast small case);
   `remoteAgents > 0` → submit. All existing refusal gates already call
   `fallback()`, so ambient inherits fail-safe for free.
6. **`plugin.ts`** — `backend(ctx)` gains an **ambient rung** before delegation:
   `activeEnvironment()?.distribute` set → `distributedBackend({ mode:
'ambient', … })`; else fall through to the existing decline → `localBackend`.
   `activeEnvironment()` is already called in `backend()` for delegate, and only
   when `cloud()` is declared — zero added cost on the plain path; the dynamic
   `import('./dist/submit.js')` only fires when an ambient pool is configured.

### Known limitation (documented)

Two _different_ devs ambient-distributing the same repo against one shared serve
land on the same `{repoId, local}` session and interfere (one-active-submission
refusal / commit-mismatch drops) — harmless to correctness (the same-checkout
law + trust scopes hold), fixed by the standing-pool session/multi-run work
(#7). Solo dev + own machines, and CI (distinct sessions per run), are correct.

### Deliberately out of Phase 1

Heartbeat (#4), ready-queue-depth for autoscaling, the composite action (#6),
the multi-run scheduler (#7), a `vx-cloud pool up` convenience verb, and any
session-model change.
