# Distributed execution (vx agents) — design

> **Status:** proposal (2026-07-03) — the implementation review Phases 4–5 of
> `dev-flows-ci-agents-2026-07.md` §7 were fenced behind.
>
> **Builds on / inherits (NOT re-litigated here):**
>
> - `dev-flows-ci-agents-2026-07.md` §4.3 + §10.1 — the agents model:
>   serve-as-rendezvous, submitted graphs, same-checkout contract, NO input
>   shipping, outputs propagate via the shared cache, registration keyed
>   `{workspaceId, session, commitSha}`, the submitter self-registers as an
>   agent, `worker` → `agent` rename, `VX_CLOUD_DISTRIBUTE` enablement (no
>   core CLI flag).
> - `core-cloud-split-2026-06.md` §3.4 — "persistent coordinator deferred to
>   its own design." This is that design, cut down: the serve is already the
>   long-lived process, so _persistent coordinator_ = _session registry on the
>   serve_. Cross-run queueing/fairness stays out (§10).
> - The SHIPPED serve platform (decision log 2026-07-03): bearer auth
>   (`authorized()`), `/v1/meta`, multi-workspace IngestStore, the
>   `/v8/artifacts` artifact store, `/mcp`, unix socket. Distribution is a new
>   consumer of these parts, not a change to them.
> - The skeleton being evolved: `packages/cloud/src/cli/coordinator.ts` (282
>   lines, ephemeral per-run), `cli/worker.ts` (161 lines, cache-blind),
>   `protocol-dist.ts`, `coordinator-prepare.ts`, core `worker-exec.ts`.

## 1. What we're solving

Tier C of the CI story: a main `vx run ci` fans its task graph out across N
agent machines that share the same checkout, cache hits are never executed
anywhere, outputs move between machines only through the serve's artifact
store, and the main job renders one normal vx run and owns the exit code.
The Nx Agents contract on parts vx already shipped.

The skeleton exists but is wrong in three load-bearing ways this design
fixes:

1. **The coordinator is its own ephemeral process** (own port 5180, no auth,
   `.vx/coordinator.json`, builds the graph from _its_ checkout). The serve
   is the rendezvous now — it has auth, a stable URL, the artifact store on
   local disk, and it outlives runs.
2. **Assignment is keyed by an upfront hash that is wrong for unstable-key
   tasks**, and the hash is computed with `upstream: []`
   (`computeTaskHashForCoord`) — it is not the real cache key of anything.
3. **The worker is cache-blind** (`workerExecute` = bare spawn): outputs never
   upload, downstream tasks on other agents can't restore, and nothing
   prevents executing a task the cache already has. Distribution without
   cache participation is strictly worse than one big runner.

## 2. Access pattern

What actually happens, how often, with what payloads:

- **Per CI pipeline:** 1 submission (a few hundred KB of wire graph at 1–3 k
  tasks: id + view + deps + 16-hex stable hash per node), N agent WS
  connections (N ≤ 16 realistically), one `hello` each.
- **Per task:** one assignment message (~100 bytes), a stdout/stderr stream
  (the same volume the local logger would see), one `agent:done` (~300
  bytes). Artifact bytes flow agent → serve (`PUT /v8/artifacts`) once per
  cache miss and serve → agent (`GET`) once per dep restore per agent (then
  the agent's local cache holds it).
- **Per warm task:** ZERO messages after the submission — the serve prunes it
  with a **local `stat`** on its own artifact dir. The dominant CI case
  (small diff, mostly-warm graph) must cost the serve a directory of stats,
  not N HTTP probes.
- **Registry:** in-memory, tens of entries, touched on hello/close/submit.
  Nothing here needs persistence — a serve restart mid-pipeline fails that
  pipeline loudly (§9) and the next one is fine.

## 3. Architecture overview

```
main job: vx run ci  (VX_CLOUD_DISTRIBUTE=8)          agent matrix: vx-cloud agent
  cloud() backend → distributedBackend                   same commit, own checkout
  ├ prepareRun (has the checkout)                        ├ hello {workspaceId, session,
  ├ deriveStableKeys (reuses run hashCache)              │        commitSha, capacity}
  ├ dist:submit {session, graph, stable hashes}          ├ receive task:assign {taskId}
  ├ self-register as agent (same loop as below) ─────────┤ scoped core run():
  ├ render relayed WireEvents (createWireRenderer)       │   vx run <taskId> — deps restore
  └ materialize outputs (targeted restores)              │   from cache, task executes, save
                                                         │   uploads to the serve store
             ▼                                           └ agent:done {taskId, OutcomeView}
  vx-cloud serve  ── /v1/agents WS (bearer-gated)
    • session registry {workspaceId, session} → agents (+ commitSha check)
    • per-submission scheduler (the old coordinator guts, graph SUBMITTED not self-built)
    • cache prune: stat its own /v8 artifact dir by stable hash — hits never dispatch
    • relays agent events → the submitter as ordinary ServerMessage WireEvents
    • /v8/artifacts — the transport agents' LayeredCache reads/writes (already shipped)
```

Three planes, all existing wire shapes:

| Plane     | Transport                                                                 | Contract                                                                 |
| --------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| control   | WS on the serve (`/v1/agents` for agents; the default WS for submissions) | `protocol-dist.ts` v1 (§7)                                               |
| render    | the SAME `ServerMessage` stream delegation uses                           | submitter code path = `serviceBackend` + `createWireRenderer`, unchanged |
| artifacts | `/v8/artifacts` Turbo wire (shipped)                                      | agents' `LayeredCache` via `VX_REMOTE_CACHE_*` env — zero new transport  |

## 4. The session registry on the serve

This is the whole "persistent coordinator" increment: the serve is already
long-lived; it gains an in-memory registry and a per-submission scheduler.
No global queue, no fairness, no persistence (§10).

### 4.1 Spec

- **`/v1/agents` WS upgrade**, gated by the existing `authorized()` (bearer
  header; `?token=` on the upgrade already works; unix-socket connections
  bypass, as everywhere).
- First message must be
  `agent:hello { protocol, agentId, workspaceId, session, commitSha, capacity, labels? }`.
  `protocol !== DIST_PROTOCOL_VERSION` → `agent:refused` naming both
  versions, close. Anything else before hello → close.
- **Registry key: `{workspaceId, session}`.** A session holds: connected
  agents (id → capacity, commitSha, inFlight set, send fn), the active
  submission (or none), `lastActivityAt`.
- **commitSha enforcement:** validated at PAIRING time, not hello time
  (agents usually register before the main job submits). On submission, every
  registered agent with a different sha gets `agent:refused` (both SHAs
  named) and is dropped from the session; a later hello mismatching an
  ACTIVE submission is refused the same way. Agents in a session with no
  submission are held as-is.
- **Agent death:** WS close re-queues that agent's in-flight task ids at the
  FRONT of the ready queue and re-dispatches (the existing coordinator
  logic, kept verbatim). Safe: an agent reports `done` only after its scoped
  run resolves, which is after `drainUploads()` — a dead agent never
  uploaded a torn artifact, and a _did-upload-then-died_ task re-executes as
  a warm hit on the next agent (the reassigned scoped run probes the store
  and restores instead of executing — free idempotency).
- **One active submission per session.** A second concurrent `dist:submit`
  on the same key → `{t:'error'}` naming the session ("already has an active
  submission"). SEQUENTIAL submissions reuse the registered agents — this is
  why the registry outlives a run (a main job runs `vx run lint` then
  `vx run test` against the same matrix).
- **Session GC:** a 60 s sweep removes sessions with no connected agents AND
  no active submission AND `lastActivityAt` older than 15 min. In-memory
  only; serve restart = empty registry.

### 4.2 Scheduler (per submission)

The old `coordinator.ts` ready-queue/dispatch/complete/reassign logic moves
into a serve module, with these changes:

- **Graph is SUBMITTED, never self-prepared** (`prepareForCoordinator` dies
  — the serve has no checkout). Nodes arrive as
  `{ id, deps, view: TaskView, stableHash? }`.
- **Cache prune before dispatch:** for every node with a `stableHash`, the
  scheduler probes the serve's OWN artifact store — `ArtifactStore.has(hash)`
  = one `file.exists()` stat on local disk, a new 3-line method. A hit marks
  the task terminal-success without dispatching anywhere, and emits a
  synthesized `task:complete` (`status: 'restored-remote'`, `restored:
false`, `hash`, `durationMs` from the `<hash>.duration` sidecar when
  present). Unstable-key tasks (no submitted hash) always dispatch; the
  executing agent's own probe short-circuits them there (§6.1).
- **Assignment key = task id** (`task:assign { taskId }`). No hash, no
  command, no `projectDir` on the wire — absolute paths from one machine are
  wrong on another; the agent resolves everything from its own checkout.
- **Dispatch preference (one line):** among agents with free capacity,
  prefer one that already executed a dep of this task — reduces dep-restore
  traffic and duplicate execution of uncacheable intermediates (§6.5). Tie
  → first free. Nothing smarter.
- **Groups** are never assigned: a group node completes automatically when
  its deps are terminal, with a synthesized rolled-up outcome.
- **Event relay:** every agent `start/stdout/stderr/done` is mapped to the
  corresponding `WireEvent` and sent to the submitter as ordinary
  `{t:'event'}` `ServerMessage`s; `run:start` at accept, `run:status` footer
  lines (plain-text tallies, §6.7) + `run:end` + `{t:'result'}` at drain.
  The submitter renders through the SAME `createWireRenderer` path
  delegation uses — zero new client rendering code.

## 5. Submission path

### 5.1 One mechanism: the `cloud()` backend capability

Enablement is exactly dev-flows decision 7: **`VX_CLOUD_DISTRIBUTE=<n>`**
(or `cloud({ distribute: n })`), `<n>` = advisory expected agent count. No
core CLI flag, no `RunRequest` change — the submission is a cloud-only wire
message carrying the `RunRequest` inside it, so core's protocol is untouched.

`cloud().backend()` gains one rung above delegation: when distribute is set,
lazily import and return `distributedBackend(serveUrl, token)`. The serve
resolves through the existing ladder (`serviceUrl` opt > `VX_SERVICE_URL` >
`VX_CLOUD_URL` > active environment > local serve advertisement). Distribute
set + no reachable serve = **hard `UserError`** — distribution was explicitly
requested; silently running locally would hide a broken matrix forever. (This
deliberately differs from delegation's fail-safe-to-local rule: delegation is
ambient, distribution is an explicit opt-in.)

`distributedBackend.run(request)`:

1. `prepareRun(request…)` — the submitter has the checkout. Refusal gates
   checked here (§5.3).
2. `deriveStableKeys(prepared…)` — the SAME derivation remote-prefetch and
   the local short-circuit share (`stable-keys.ts`), reusing the run's
   `hashCache`. Stable nodes carry their hash in the wire graph; unstable
   nodes carry none.
3. Open the serve WS, send
   `dist:submit { protocol, session, workspaceId, commitSha, expectedAgents, agentTimeoutMs, request, nodes }`.
4. **Self-register as an agent** (§5.2) over a second WS to `/v1/agents` —
   the same loop the `agent` verb runs, in-process.
5. Render streamed events (`createWireRenderer`) until `{t:'result'}`.
6. **Materialize outputs** (§6.6), return the `RunResult`.

Session + identity come from shared helpers in cloud: session =
`VX_AGENT_SESSION` > CI-derived (`GITHUB_RUN_ID`+`GITHUB_RUN_ATTEMPT`,
GitLab `CI_PIPELINE_ID`, Buildkite `BUILDKITE_BUILD_ID`) > `'local'` (the
dev-machine default — the registry key includes workspaceId, so `'local'` is
already scoped); workspaceId/commitSha from core's `captureWorkspaceIdentity`
/ `captureGitContext` (façade export, §8.3).

### 5.2 The submitter is an agent (§10.1) — how the loop coexists with rendering

The submitter process runs two independent WS clients:

- the **submission socket** (submit + event stream → renderer), and
- an **agent socket** to `/v1/agents`, running the identical
  `runAgentLoop()` the `agent` verb runs (§8.2), with capacity = the run's
  effective concurrency (`request.concurrency` else the local default — it's
  the machine the user sized; remote agents default to `--capacity 1`).

They never interleave on one socket, so there is no framing problem. The
agent loop executes assignments via in-process scoped `run()`s with
`handleSignals: false`, a silent logger, and ONE shared `inflight` map across
its concurrent assignments (the same concurrent-run guarantees the serve's
delegated runs already rely on). The submitter's own task output reaches its
terminal the same way every other agent's does — relayed through the serve —
so rendering has exactly one source and delegated-run ordering semantics.
The extra local→serve→local hop for the submitter's own logs costs one WS
round-trip per chunk; accepted for having ONE rendering path.

Before starting the loop, the backend sets in its own process env (when
unset): `VX_REMOTE_CACHE_URL=<serve origin>`, `VX_REMOTE_CACHE_TOKEN=<token
or '-'>`, and the sentinel `VX_CLOUD_AGENT=1` — §6.2 explains why the env is
the right wiring; the sentinel makes `cloud()`'s telemetry rung decline so
per-assignment scoped runs don't spam the ingest store with 1-task
invocations (other telemetry plugins, e.g. `otel()`, are unaffected —
per-assignment traces are documented behavior, arguably useful).

### 5.3 Refusal gates (checked on the submitter, before submitting)

| Condition                                                                                               | Behavior                                                                                                                               |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| dirty worktree (`prepared.gitFilesCache.worktreeDirty`)                                                 | loud status line, **fall back to a normal local run** — uncommitted changes can't exist on agents; local is fully correct              |
| effective cache policy lacks `remoteRead && remoteWrite` (`--no-cache`, `--force`, `--cache=remote:` …) | loud fallback to local — the cache IS the artifact transport; without both axes distribution cannot propagate outputs                  |
| non-empty `forwardArgs` (`vx run test -- --grep x`)                                                     | loud fallback to local — §6.4's requested-fold rule cannot be satisfied in v1 without marking main-requested nodes requested on agents |
| any node in the graph has `exec.persistent`                                                             | loud fallback to local — a dev server on a remote agent is meaningless and would pin its scoped run open                               |
| no reachable serve                                                                                      | **hard `UserError`** (§5.1)                                                                                                            |

Fallback = the plugin returns the normal local backend for this run; the
line printed names the gate (`vx: distribution disabled: <reason> — running
locally`).

### 5.4 Zero agents

The submitter self-registers, so the true zero-agent deadlock of §4.3's
table **cannot occur** — there is always at least one agent (itself), and
dispatch starts immediately. This supersedes the §4.3 "fail loudly after
`--agent-timeout`" row, which predates the §10.1 self-registration
refinement. What remains of it:

- If ZERO **remote** agents have joined the session after `agentTimeoutMs`
  (default 5 min, `VX_CLOUD_AGENT_TIMEOUT_MS`), the scheduler emits a loud
  `run:status` warning — `0 remote agents joined session <key> after 5m —
executing on the submitter only` — repeated once in the footer. The run
  proceeds and completes correctly (degrades to a slower local run through
  the agent path); failing a green build over missing accelerators is worse
  than warning. A strictness knob is deliberately NOT built (noted §10).
- If the submitter cannot register at all (WS refused / auth / protocol
  mismatch), the submission fails immediately and loudly — that's
  infrastructure misconfiguration, not degradation.

## 6. Correctness: cache-aware assignment + hash equality — the crux

### 6.1 Central prune, agent-side truth

Two probe layers, each where it is cheap and honest:

- **Serve-side (assignment time):** stable hashes probed by `stat` against
  its own artifact dir (§4.2). Hits never dispatch — the Nx behavior. This
  is only sound because the submitted hash IS the executing key for
  stable-key tasks (below).
- **Agent-side (execution time):** every assignment runs core's normal
  cached pipeline, so unstable-key tasks (whose honest key exists only after
  their deps' outputs are on disk) short-circuit on the agent — a warm
  unstable task "executes" as a restore and reports `restored-remote`.

### 6.2 The execution mechanism — decision

| Option                                                                      | Verdict                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bare `workerExecute` (status quo)                                           | REJECTED — cache-blind: no upload, no restore, no probe. Fails the transport requirement outright.                                                                                                                                                                                                            |
| scoped `run()` with `excludeDependencies: 'all'`                            | REJECTED — **provably wrong keys** (§6.4). Dropping dep edges empties the `upstream` set that `filterUpstreamHashes` folds; every task with upstream deps derives a DIFFERENT key than any full run would.                                                                                                    |
| **scoped `run()` of the exact task id, WITH its dep closure** (recommended) | **ADOPTED** — deps are warm hits from the shared cache (each was executed + uploaded by whichever agent ran it before this task became ready), keys are exactly the full-run keys (§6.3), and hashing/probe/save/upload/`drainUploads` all ride existing core machinery with ZERO new core execution surface. |

Concretely, per assignment the agent runs, in-process:

```ts
await run({
  cwd: checkoutRoot,
  tasks: [taskId], // anchored 'pkg#task' — expandRequested handles it
  frozen: request.frozen, // same lock, same commit → same configs
  cache: request.cache, // FULL by default; remote axes required (§5.3)
  concurrency: capacity - appropriate,
  log: silent,
  handleSignals: false,
  inflight: sharedMap,
})
```

The remote layer comes from the environment, not from new plumbing: the
agent process carries `VX_REMOTE_CACHE_URL=<serve>/…` + token, and the
normal resolution (the `cloud()` cache capability, else core's env fallback)
builds the `LayeredCache` per scoped run. **The await-PUT-before-done gate
(§4.3 decision 4) falls out for free:** `run()` drains background uploads
before closing its cache, so when the scoped run resolves — which is when
the agent sends `agent:done` — the artifact is already in the store. No new
"await PUT" code exists to get wrong.

The agent forwards to the serve only the events whose node id equals the
assigned task id (`task:start/stdout/stderr/complete` → `agent:start/
stdout/stderr/done`); dep restores stay silent, exactly as they are locally.
The `done` payload is core's `OutcomeView` verbatim (hash, durations, cpu,
rss included) — the skeleton's `WireOutcome` dies (§7).

### 6.3 Hash equality — the argument

**Claim.** Under the distribution contract (same commit, clean trees, same
resolved configs — `--frozen` recommended, same values for every declared
`inputs.env` name, same toolchains for `inputs.runtime` commands, same vx
version), the agent's scoped run derives, for the assigned task AND every
task in its dep closure, keys byte-identical to the keys those tasks get in
the full run on any conforming machine.

By induction over the closure in topo order, over `computeTaskHash`'s
components:

| Key component                       | Equal because                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taskId`                            | assignment is by id                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `taskConfigHash`                    | same resolved config: identical `vx-lock.json` at the same commit under `--frozen`; live eval assumed env-pure (the contract `vx lock --check` audits)                                                                                                                                                                                                                                                                                                                            |
| `projectPackageJsonHash`            | file content at the same commit                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `workspaceFingerprint`              | root lockfile bytes at the same commit (`fingerprint.ts` folds file CONTENT, no machine paths)                                                                                                                                                                                                                                                                                                                                                                                    |
| `envValues` / runtime values        | contract (same CI image/env); divergence degrades to a miss, never staleness (§6.5)                                                                                                                                                                                                                                                                                                                                                                                               |
| `inputFiles` (rel paths + git OIDs) | paths are workspaceRoot-RELATIVE (absolute checkout location never folds); clean tree at the same commit → identical set + OIDs. For UNSTABLE tasks the inputs include upstream outputs on disk — in the agent's scoped run those bytes were restored from the artifact, i.e. are bit-identical on every machine (the cache pins ONE materialization of even a nondeterministic build), so the unstable key is a pure function of (commit, upstream artifacts) — equal everywhere |
| `upstreamHashes`                    | same configs → same frontier expansion → same dep edges → same `filterUpstreamHashes` selection over dep outcomes whose hashes are equal **by the induction hypothesis** — this line is exactly what `excludeDependencies: 'all'` breaks                                                                                                                                                                                                                                          |
| `forwardArgs`                       | empty in v1 by the §5.3 gate; folds `[]` for non-requested nodes on both sides (§6.4)                                                                                                                                                                                                                                                                                                                                                                                             |

The graph edges themselves are reproducible because `'^task'` frontier
expansion, `dependsOn` parsing, and scoped config loading are pure functions
of the configs + package manifests at the commit.

**Consequence:** the submitter's stable hashes (step 2 of §5.1, derived by
the shared `deriveStableKeys`) equal the keys executing agents save under —
the serve-side stat prune and the warm-rerun-assigns-nothing property are
sound. This is pinned forever by a guard test (§11).

### 6.4 The `excludeDependencies: 'all'` counterexample (why it's rejected)

`b` depends on `a`; `b` declares no `cache.inputs.tasks` filter (the
default: ALL upstream hashes fold). Full run: `key(b) = f(inputs_b,
[hash(a)])`. Agent scoped run with `excludeDependencies: 'all'`: the graph
has no `a` node, `upstream = []`, so `key'(b) = f(inputs_b, [])` ≠ `key(b)`.
The artifact uploads under `key'(b)`; the submitter's warm rerun (and every
developer's local run) derives `key(b)` → permanent miss; worse, a LATER
scoped run could HIT `key'(b)` while `a`'s outputs on that machine are from
a different `a` — the fold exists precisely to prevent that. Same failure
through `'*'`/`'^*'` filters. Dropping dep edges changes the key domain;
it is not an optimization, it is a different (wrong) cache.

And the fine-grained `forwardArgs` case that motivates the §5.3 gate:
`effectiveForwardArgs` folds only for `node.requested` nodes. On an agent,
the assigned task is requested and its deps are not — which matches the main
run EXCEPT when a main-requested task sits in another assignment's dep
closure (`vx run a b -- --flag` with `b` depending on `a`): main folds the
args into `a`, the agent's closure doesn't. Rather than shipping a subtly
wrong fold or new "mark these ids requested" core surface, v1 refuses
distribution with forwardArgs; revisit only on demand.

### 6.5 Residual divergence — honest table

| Risk                                                                                                                      | Effect                                                                                                                                                                                            | Verdict                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| env / toolchain drift across matrix machines (`inputs.env`, `inputs.runtime`)                                             | different key → the agent misses + re-executes + saves under ITS key; the submitter's stable prune used ITS OWN derivation, so at worst duplicated work — **never a stale hit** (keys only widen) | accepted; it's Nx's contract too. The Tier C recipe pins one image + `--frozen`                                                                                                                             |
| serve store GET fails mid-run (network blip)                                                                              | `LayeredCache` degrades to miss → the agent re-executes the dep locally; if that dep's outputs are nondeterministic, an UNSTABLE dependent derives a different key than other machines would      | accepted: correct-but-colder, only in the (degraded network × nondeterministic outputs × unstable dependent) corner                                                                                         |
| uncacheable INTERMEDIATE tasks (no `cache` config, with dependents)                                                       | execute once standalone when assigned, and AGAIN inside each dependent's closure on other agents (nothing to restore from)                                                                        | accepted + documented loudly: "make intermediates cacheable." The §4.2 dep-affinity preference and the agent's warm local cache bound the damage. Uncacheable LEAF tasks (typical tests) cost nothing extra |
| per-assignment scoped-run overhead (workspace discovery + scoped config load + git enumeration, ~100–200 ms on big repos) | pure latency, parallel-amortized across agents; the agent's local cache makes dep restores after the first assignment nearly free                                                                 | accepted for v1; measured in Increment B — a persistent per-agent prepared state is the known optimization if it matters                                                                                    |

### 6.6 Output materialization on the submitter

A local `vx run build` leaves `dist/` populated; a distributed one must too
(Nx moves artifacts back to the main job). A naive post-run warm `run()`
would RE-EXECUTE uncacheable tasks — wrong. Instead, after `{t:'result'}`
the backend does **targeted restores**: for every terminal-success,
cacheable task with declared outputs that the submitter did NOT execute
itself (agent-executed → `hash` from its `OutcomeView`; probe-pruned → the
submitted stable hash), in topo order:
`layered.get(hash, ctx)` (ingests into the local cache as a side effect —
future local runs are warm) → `cleanOutputs` → `Cache.restoreOutputs`. ~30
lines of cloud code against the public cache API; no re-hashing, no
re-execution, no new core surface beyond exporting `cleanOutputs` (§8.3).

Not replayed in v1: stored stdout of probe-pruned tasks (a local warm run
replays hits; distributed shows the one-liner only). Cosmetic; noted, not
built.

### 6.7 Footer

The scheduler composes plain `run:status` footer lines (task/cache tallies +
wall time) rather than core's meter-bar summary — `formatRunSummary` is not
public and exporting it for cosmetics isn't worth the surface. Distributed
footers are plainer in v1; noted as a cosmetic gap.

## 7. Protocol — `protocol-dist.ts` v1

`DIST_PROTOCOL_VERSION = 1` (new sentinel — the current wire has none;
versioning rule). Carried in `agent:hello` and `dist:submit`; mismatch →
refuse naming both. The family was never released, so shapes change freely
once; from now on the sentinel gates.

| Message                                            | Disposition                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `worker:hello {workerId, capacity, labels}`        | → `agent:hello { protocol, agentId, workspaceId, session, commitSha, capacity, labels? }`                                                                                                                                                                                      |
| `worker:pull`                                      | **DIES** — capacity is declared and the scheduler dispatches on completion; pull added nothing                                                                                                                                                                                 |
| `worker:start/stdout/stderr` (keyed by `taskHash`) | → `agent:start/stdout/stderr` keyed by **`taskId`**                                                                                                                                                                                                                            |
| `worker:done {taskHash, outcome: WireOutcome}`     | → `agent:done { taskId, outcome: OutcomeView }` — **`WireOutcome` DIES**; core's `OutcomeView` is the outcome currency (hash/cpu/rss/durations ride along for free)                                                                                                            |
| `worker:bye {reason}`                              | → `agent:bye`, unchanged semantics                                                                                                                                                                                                                                             |
| `task:assign {node: WireTaskNode, hash}`           | → `task:assign { taskId }` — **`WireTaskNode` DIES** on the assignment path (no commands, no absolute `projectDir` cross machines); node views ride the submission instead                                                                                                     |
| `cache:exists`                                     | **DIES** — never had a consumer; the prune is a serve-local stat                                                                                                                                                                                                               |
| `coord:drain`                                      | kept                                                                                                                                                                                                                                                                           |
| —                                                  | NEW `agent:refused { reason }` (commit/protocol mismatch), serve → agent, then close                                                                                                                                                                                           |
| —                                                  | NEW `dist:submit { protocol, session, workspaceId, commitSha, expectedAgents, agentTimeoutMs, request: RunRequest, nodes: Array<{ id, deps, view: TaskView, stableHash? }> }` on the submission WS; answered by the EXISTING `ServerMessage` stream (`event`/`result`/`error`) |

The JSON-RPC envelope adapters rename mechanically (`worker.*` → `agent.*`,
`dist.submit` added). Core's `protocol.ts`/`RunRequest` are untouched.

## 8. Code movement

### 8.1 What moves / dies

| File                                     | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli/coordinator.ts`                     | **guts move** to `src/dist/registry.ts` (sessions, GC) + `src/dist/scheduler.ts` (ready queue, prune, dispatch, reassign, event synthesis); the file and the **`vx-cloud coordinator` verb are RETIRED** — the dispatcher prints a redirect ("absorbed into `vx-cloud serve`; enable with VX_CLOUD_DISTRIBUTE"). Unreleased pre-alpha verb with the wrong topology (own port, no auth, self-prepared graph): clean removal beats a deprecation shim                                                                                                                                           |
| `coordinator-prepare.ts`                 | **DIES** — the submitter prepares via public `prepareRun` inside `src/dist/submit.ts`; `computeTaskHashForCoord` (the `upstream: []` hash) is replaced by the shared `deriveStableKeys`                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cli/worker.ts`                          | → `cli/agent.ts` — parse (`--url`, `--token`, `--capacity` default 1, `--session`, `--idle-timeout <ms>` default 10 min), startup checks (git present, CLEAN tree — a dirty agent exits 1 before poisoning keys, commit capture), then `runAgentLoop()` from `src/dist/agent-loop.ts` (hello → assignments → scoped `run()` per §6.2 → `OutcomeView` report; self-terminate on idle timeout). The **`worker` verb is REMOVED with a redirect message** (unreleased; a hidden alias would map flags that no longer exist) — deviation from dev-flows decision 6, justified by pre-alpha status |
| `src/dist/submit.ts` (new)               | `distributedBackend` (§5.1): prepare → gates → stable keys → submit → self-agent loop → render → materialize                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `cli/serve.ts`                           | +~60 lines: `/v1/agents` upgrade routing (role via `ws.data` from the upgrade path), `dist:submit` handling on the existing WS message handler, `ArtifactStore.has()`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/orchestrator/worker-exec.ts` (core) | loses its only consumer; **remove `workerExecute` from the façade + delete the file** (pre-alpha, no embedders; boundary snapshot updated)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `plugin.ts`                              | `backend()` distribute rung + `distribute` option; telemetry rung declines under `VX_CLOUD_AGENT=1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 8.2 The `vx-cloud agent` verb (thin, per the fence)

connect → hello → loop { receive `task:assign` → scoped `run()` → filtered
event forwarding → `agent:done` } → `coord:drain` or idle-timeout →
`agent:bye`. Exit 0 on clean drain **even when tasks failed** (the main job
is the single authority — §4.3); exit 1 on refusal, dirty tree, or
unexpected WS close.

### 8.3 Core façade deltas (small, additive — the seam §9 of dev-flows anticipated)

- `deriveStableKeys` + `StableKey` (exists in `orchestrator/stable-keys.ts`,
  currently internal).
- `captureWorkspaceIdentity` + `captureGitContext` (+ their types) from
  `run-context.ts` — agents and the backend need identity before/without a
  telemetry-enabled run.
- `cleanOutputs` (already on the cache module contract, not on the façade).

No core behavior change, no `CACHE_VERSION`/schema bump anywhere in this
design — key derivation, artifact bytes, and the run hot path are untouched;
distribution only changes WHERE tasks execute. Boundary-snapshot tests
updated deliberately.

## 9. Failure UX

| Failure                                                  | Behavior                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zero agents                                              | impossible in the deadlock sense (submitter self-registers, §5.4); zero REMOTE agents after `agentTimeoutMs` → loud warning in stream + footer, run completes on the submitter                                                                                                                                                                                                                           |
| submitter can't register / bad token / protocol mismatch | submission fails immediately, hard error naming the cause                                                                                                                                                                                                                                                                                                                                                |
| commit mismatch                                          | agent gets `agent:refused` naming both SHAs and exits 1 (a red matrix row = infra misconfig); the submission proceeds with matching agents                                                                                                                                                                                                                                                               |
| agent death mid-task                                     | WS close → its in-flight task ids re-queued at the front + re-dispatched; already-uploaded work re-lands as a warm hit on the next agent (§4.1). Its half-written local outputs die with its checkout                                                                                                                                                                                                    |
| serve death mid-run                                      | submitter: WS closes without a result → the run fails with a clear error, its own in-flight scoped runs finish locally, exit non-zero. Agents: finish in-flight (uploads fail → degrade to miss, swallowed), then exit 1                                                                                                                                                                                 |
| duplicate session (concurrent)                           | second `dist:submit` on an active session → `{t:'error'}` naming the session; `GITHUB_RUN_ATTEMPT` in the derived key already separates retries. Sequential submissions reuse the session's agents by design                                                                                                                                                                                             |
| submitter death mid-run                                  | its submission WS closes before result → scheduler FINISHES the graph with the remaining agents (every artifact still warms the store — §4.3's "main job death" row), reassigns the dead submitter-agent's in-flight tasks, then sends `coord:drain` (a dead main job won't submit again; idle matrix minutes are paid minutes). If no agents remain, the submission aborts and the session ages into GC |
| dirty agent tree                                         | agent refuses to start (exit 1, names the paths) — divergent keys from dirty inputs would silently split the cache                                                                                                                                                                                                                                                                                       |

## 10. Non-goals (ruthless)

- **Cross-run queueing / fairness / priorities** — one active submission per
  session; the registry is a rendezvous, not a job queue. (The
  core-cloud-split §3.4 "global scheduler" stays deferred.)
- **Agent autoscaling / managed fleets** — the CI matrix and k8s own machine
  lifecycle; vx owns task placement only.
- **Input shipping** — permanently fenced to the old CAS design
  (core-cloud-split §3.3); same-checkout is the contract, dirty trees run
  locally.
- **Multi-tenancy / per-workspace ACLs** — one bearer = whole serve,
  unchanged.
- **Persistent run history for distributed runs** — no `run()` executes the
  whole graph anywhere, so v1 records no invocation row and ingests no
  summary for a distributed run (delegated-run self-ingest is unaffected).
  Coordinator-side summary synthesis is a roadmap note, not scope.
  **[SHIPPED 2026-07-18: the server-side `DistScheduler` (the controller) now
  records the run into Postgres analytics through core's shared
  `assembleRunSummary` — a `task_runs` row per completion plus the
  `invocations` header at finish — so a distributed run appears under Runs and
  fills in live exactly like a local `cloud()` run. Per-task logs land too: the
  controller tees the agent stream it already relays into the shared
  `TaskLogBuffer`, which writes `task_logs`. See `dist-run-history-2026-07.md`.]**
- **Agent reconnect/retry** — an agent that loses its WS exits; the matrix
  restarts it or doesn't. **[SHIPPED 2026-07-18: a standalone agent reconnects
  with bounded exponential backoff on an unexpected close, using a fresh
  agentId per attempt so the serve's drop-then-reassign stays clean. Terminal
  closes never reconnect; the submitter self-agent does not reconnect. Core's
  shared `inflight` dedup collapses a re-assigned-during-reconnect task to one
  execution.]**
- **Per-task placement pinning** (`distribute: false`) — dev-flows §10.1
  already deferred it; nothing here changes that.
- **forwardArgs distribution, probe-hit stdout replay, meter-bar footer
  parity, a strictness knob for zero remote agents, a composite GitHub
  action** — each noted inline above; none built in v1.

## 11. Phased implementation

### Increment A — the whole usable feature (L)

Order of construction (each step lands with its tests; the cached scoped-run
execution path is there from day one — no cache-blind interim):

1. **Protocol v1** (`protocol-dist.ts` reshape + envelope adapters) +
   `ArtifactStore.has()`.
2. **Registry + scheduler on the serve** (`dist/registry.ts`,
   `dist/scheduler.ts`, serve wiring): sessions, hello/refuse, prune,
   dispatch (+ dep-affinity preference), reassign, relay, drain, GC.
3. **`agent-loop.ts` + `cli/agent.ts`**: scoped-run execution exactly as
   §6.2 (env-wired cache, shared inflight, filtered event forwarding,
   idle-timeout); `worker`/`coordinator` verbs → redirects; core façade
   deltas.
4. **`dist/submit.ts` + plugin rung**: gates, submission, self-registration,
   rendering, materialization, zero-remote-agent warning.

Tests:

- **Unit** — registry: `{workspaceId, session}` matching, commit-mismatch
  refusal at pairing and at late hello, duplicate-concurrent-submission
  refusal, sequential reuse, GC sweep. Scheduler: prune marks
  probe-hits (fixture artifact dir) and never dispatches them, capacity
  respected, dep-affinity preference, reassignment on close, group
  auto-complete, orphaned-submission completion + drain. Protocol: envelope
  round-trips, version mismatch refused. Gates: each §5.3 row falls back
  loudly (and unreachable-serve hard-errors).
- **The §6.3 guard (the crux, pinned forever):** a fixture with a
  cross-project dep chain + an `inputs.tasks` filter; derive every key via a
  full `prepareRun` + `deriveStableKeys`; execute a downstream task
  agent-style (scoped run with deps); assert the saved entry hash equals the
  full-run key. Plus the inverted pin: the same scoped run under
  `excludeDependencies: 'all'` derives a DIFFERENT key (documents §6.4 in
  executable form).
- **Real e2e:** one serve (temp ingest dir, token) + TWO `vx-cloud agent`
  subprocesses on separate `git clone`s of the fixture (same sha) + a
  submitting run in a third clone with `VX_CLOUD_DISTRIBUTE=2`. Assert:
  both agents registered and each executed ≥1 task (placement), events
  streamed back and rendered (submitter output contains both agents' task
  frames), aggregate exit code, artifacts present in the serve store,
  submitter's outputs materialized on disk, and — the §6.3 payoff — a WARM
  RERUN of the same submission dispatches ZERO assignments (all
  probe-pruned; agents stay idle). Second e2e: kill one agent mid-task →
  the task reassigns and the run completes.

### Increment B — validation + measurement (M)

Only what A deliberately leaves: the real-CI testbed (the §4.3.4 two-job GHA
recipe run against a deployed serve — the honest "call it shipped" blocker
from dev-flows §4.3.5), Tier C docs, and a bench-workspace measurement of
per-assignment scoped-run overhead (§6.5 last row) — a persistent per-agent
prepared state is designed ONLY if the number says so. Anything else from
§10's noted-not-built list waits for demand.

## 12. Why this is the right move

- **The correctness crux has a proof, a counterexample, and a guard test** —
  agent keys equal full-run keys by construction (§6.3), the tempting
  shortcut is shown wrong in four lines (§6.4), and the property is pinned
  executable so it can't silently rot.
- **Zero new execution machinery** — agents run core's `run()`; probe, save,
  upload, drain, restore, dedup all already exist and are already tested.
  The delta is a registry, a scheduler that stopped preparing graphs, and a
  thin loop.
- **The serve was already the right host** — auth, stable URL, artifact
  store on local disk (the prune is a stat, not a network probe), long
  lifetime. "Persistent coordinator" shrinks from a platform to ~two
  modules.
- **Every degradation is toward re-execution, never staleness** — env drift,
  network blips, dead agents, uncacheable intermediates all cost duplicated
  work at worst; no path produces a wrong hit.
- **The plain run stays sacred** — everything lives behind
  `VX_CLOUD_DISTRIBUTE` in the cloud plugin; core changes are four additive
  façade exports and one file deletion.

## 13. Open questions

- **Per-assignment overhead on very large workspaces** — Increment B
  measures; the persistent-prepare optimization is sketched only if needed.
- **Should the submitter's self-agent capacity reserve a slot for
  rendering?** Likely irrelevant (rendering is IO-trivial); revisit if the
  e2e shows starvation.
- **Session key ergonomics on providers beyond GitHub/GitLab/Buildkite** —
  the `VX_AGENT_SESSION` override is the universal escape hatch; extend the
  derivation matrix as real providers show up (dev-flows §9, unchanged).
