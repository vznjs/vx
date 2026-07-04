# vx as a CI platform — competitive positioning + the standing shared-pool scheduler

> **Status:** proposal (2026-07-04)
> **Builds on / inherits (not re-litigated):** `distributed-execution-2026-07.md` (session registry, same-checkout correctness law §6, `deriveStableKeys`, artifact-store transport, `SUBMITTER_LABEL`); `universal-agents-2026-07.md` (§A pool model, §D#7 the fence this design removes, §E Phase-1 ambient); one-connection cloud + trust scopes; provider-neutral core. This design does **not** touch the correctness law, wire hash equality (§6.3), or trust scoping — it changes _which agents a submission may use_ and _how many submissions a session may run at once_, never _how a task's key is derived_.

---

## Deliverable 1 — Competitive positioning: the road to best-CI

### The wedge (decision, stated up front)

**vx is the portable execution + cache + pool LAYER you run _inside_ any CI provider, and byte-identically on your laptop. It is not a CI platform.**

The thing that is unique and defensible is: `vx run ci` produces the _same task graph, same content-addressed cache keys, same distributed placement_ whether it runs on a dev laptop, in GitHub Actions, in GitLab CI, in Buildkite, or across a self-hosted agent pool — and the second run anywhere is instant because the cache is content-addressed and shared. GHA cannot offer this (its cache is coarse, key-managed-by-you, no task graph, no local parity); Nx Cloud offers the cache but locks distribution to its hosted SaaS. vx is the only one that is **provider-neutral, self-hostable, and identical local↔CI.**

Three invariants make that wedge work and must stay sacred: **shell is the API** (commands are strings — this is _exactly_ what makes a task portable across every provider; a JS-function task or an executor-plugin protocol would destroy the "runs anywhere" promise), **one command per task**, and **provider-neutral core** (core names no provider; everything cloud is a plugin).

### vs Nx Cloud / Nx Agents / Turborepo Remote Cache

Already shipped and competitive (grounded in code): content-addressed local+remote cache (`cache/`, `LayeredCache`, Turbo `/v8` wire in `RemoteCache`); trust-scoped, per-PR-isolated artifacts (`artifact-store.ts` bucket/tier, server-derived from token); `--affected` (`workspace/affected.ts`); DTE with the same-checkout correctness law (`dist/`); dashboard + analytics (`metrics.ts`: `compareRuns`, `getRunTrends`, `getBottlenecks`, `getHitRateSplit`); cache-miss explainability — the moat (`whyDidThisRerun`, `cacheKeyDiff` over `entry_inputs`); MCP; staged-DAG + critical-path viz.

What Nx Cloud has that vx still lacks, ranked by value:

1. **Standing shared agent pool + cross-run multiplexing** — Nx's agents are a long-lived pool many runs share. vx is submission-scoped (`SessionState.active: ActiveSubmission | null`, one at a time). **Highest value; this is Deliverable 2.**
2. **Per-task logs + artifacts surfaced in the dashboard** — Nx lets you click a failed task and read its terminal output in the browser. vx's cache artifact _contains_ stdout, but `IngestStore` persists only run summaries; the dashboard has no per-task log surface. Real gap for "best CI."
3. **Flaky-test detection _with action_** — vx already _detects_ (`getFlakiestTasks` in `metrics.ts`) but has **no retry mechanism at all**: `execute-task.ts`/`scheduler.ts` run a task once. Nx auto-retries flaky tasks. The retry is the gap.
4. **PR/commit summary + checks** — Nx posts PR comments with results and the affected graph. vx already _generates_ the markdown (`run-report.ts`, `--report=markdown`) but has zero VCS glue.
5. **Duration-aware distributed placement** — Nx Agents order longest-historical-duration-first for better makespan. vx dispatches ready-order + dep-affinity (`DistScheduler.dispatch`) and has the history (`metrics.ts`) but doesn't use it for ordering.
6. **Access control / orgs / RBAC** — Nx Cloud has multi-tenant orgs. vx has one bearer + server-derived trust tiers (enough for fork-PR isolation, not for multi-tenant).

### vs GitHub Actions / GitLab CI

GHA's value is **triggers** (push/PR/cron/webhooks), **hosted runner fleets** (compute + billing), **a secrets store**, **the marketplace** (10k+ actions), **a workflow DSL**, and deep GitHub permissions integration. Each of those is a multi-year, capital-intensive _platform_ business (hosted runners = a cloud provider; marketplace = an ecosystem; secrets = a security product). Rebuilding any of them means fighting incumbents on their turf while abandoning the one thing vx is uniquely good at. **vx should be invoked _by_ GHA/GitLab, not replace them.**

**Adopt from the GHA experience (the good UX, without becoming a platform):**

- Great per-task logs + live status in the dashboard (the "expand a step, watch it stream" feel) → item 2 above.
- Run summaries / PR annotations → the markdown already exists (`run-report.ts`); add an _optional, cloud-side_ emitter that writes `$GITHUB_STEP_SUMMARY` and posts a PR check — glue, never core.
- Retries → item 3.
- Sharding one long task across agents (`shards: n` → sibling assignments with `VX_SHARD_INDEX/TOTAL`) — already scoped as a convention in `universal-agents §D#8`.

**Must NOT do:** own triggers/webhooks/cron; host runners or manage compute fleets (vx emits capacity signals, `/v1/agents`; k8s/CI owns machines); a secrets store; a YAML workflow DSL or marketplace (shell-is-the-API + TS-config-composition already _are_ our composition layer — a DSL would duplicate the provider and break portability); a hosted SaaS/billing platform.

### The ranked "road to best-CI"

| #   | Item                                                             | Tag                         | One-line why (grounded)                                                                                     |
| --- | ---------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | **Standing-pool multi-run fair scheduler**                       | **ship-now (this session)** | Unblocks concurrent runs on one pool — the "scales for big" keystone; `registry.active` single → set.       |
| 2   | Per-task logs/artifacts in the dashboard                         | next                        | Cache artifact already holds stdout; `IngestStore` only stores summaries — no log surface.                  |
| 3   | PR/commit summary + checks (cloud-side glue)                     | next                        | `run-report.ts` already emits markdown; needs a `$GITHUB_STEP_SUMMARY`/PR-check emitter in cloud, not core. |
| 4   | Task-level retries (`retries` config + `--retry`)                | next                        | `scheduler.ts`/`execute-task.ts` run a task exactly once; no retry primitive exists.                        |
| 5   | Flaky detection → surface + optional auto-retry                  | next (detect shipped)       | `getFlakiestTasks` exists; wire it to the dashboard + `retries` on flagged tasks.                           |
| 6   | Duration-aware dispatch ordering                                 | next                        | `DistScheduler.ready` is FIFO-ish; `metrics.ts` has p50 durations to sort longest-first.                    |
| 7   | Intra-task sharding (`shards: n`)                                | next (separate design)      | Splits a 20-min task; the task stays the unit — a config convention, per `§D#8`.                            |
| 8   | Run comparison / trends / bottlenecks / hit-split                | **shipped (polish)**        | `compareRuns`/`getRunTrends`/`getBottlenecks`/`getHitRateSplit` in `metrics.ts` + dashboard.                |
| 9   | Cache-miss explainability (why-rerun + input diff)               | **shipped (the moat)**      | `whyDidThisRerun` + `cacheKeyDiff` over `entry_inputs`.                                                     |
| 10  | Triggers / hosted runners / secrets / workflow DSL / marketplace | **non-goal (permanent)**    | The CI platform's job; replicating it abandons the portable-layer wedge.                                    |
| 11  | Managed autoscaler / fleet controller                            | **non-goal**                | vx emits queue-depth+capacity (`/v1/agents`); k8s/CI owns machine lifecycle.                                |
| 12  | Multi-tenancy / RBAC / orgs                                      | **non-goal (for now)**      | One bearer + server-derived trust tiers cover fork-PR isolation.                                            |
| 13  | Input shipping (distribute a dirty tree)                         | **non-goal (permanent)**    | Same-checkout contract; dirty trees run locally.                                                            |

---

## Deliverable 2 — The #7 standing shared-pool multi-run fair scheduler

### What we're solving

Today `AgentRegistry` allows **one active submission per `{workspaceId, session}`** (`beginSubmission` returns `{error: 'already has an active submission'}` on a second concurrent submit; sequential submissions reuse agents). This blocks the standing shared pool: two concurrent `vx run`s against the same pool — parallel CI jobs at the same commit, or two teammates — can't coexist. The evolution is a **session that holds multiple concurrent submissions, fairly multiplexed across shared agents.** It is correctness-critical because agents are now shared at slot granularity across submissions.

### 1. The commit-routing model (decision + defense)

**Decision: agents are matched to submissions by `commitSha`; commit is a pure _dispatch-eligibility filter_, never a refusal. A submission dispatches only to commit-eligible agents; a submission with no _remote_ commit-eligible agent runs entirely on its own self-agent (= submitter-local), exactly like today's zero-remote-agents path. Re-checkout per assignment is a permanent v1 non-goal.**

Why this and not per-assignment re-checkout: re-checkout (`git fetch && git checkout <sha>` on each assignment) adds seconds of latency per task, reintroduces dirty-state hazards the same-checkout law was designed to eliminate, and needs agent-side coordination we don't have. An agent is at **exactly one commit for its lifetime** (its checkout), so it never mixes commits in its local cache — the correctness law §6.3 holds unchanged per task, and there is no `CACHE_VERSION` concern.

What a standing pool **can** do in v1: serve any number of concurrent submissions **that share its agents' commit**. The highest-value real cases are all single-shared-commit — parallel CI jobs at one commit, a merge-queue base, a team pinned to `main`. What it **cannot** do in v1: help a submission whose commit no agent holds (a teammate on a feature branch finds zero eligible remote agents → runs local, with a loud "0 commit-matching remote agents" warning). That is the honest boundary, and it degrades toward local execution, never toward a wrong hit.

**Self-agent ownership (the one subtlety that makes sharing feel right).** The submitter self-registers a self-agent (`SUBMITTER_LABEL`) at its own commit. Without a guard, a same-commit submission B could conscript teammate A's laptop for B's 500-task run, starving A's own quick run. Rule: **a `SUBMITTER_LABEL` agent is eligible only for the submission that owns it.** Encoded by a new optional `ownerSubmissionId` on `agent:hello`; a self-agent is eligible for submission `S` iff `commitSha` matches **and** (`!SUBMITTER_LABEL` **or** `ownerSubmissionId === S.submissionId`). Net: your machine does your work; genuinely shared remote agents do everyone's work, fairly.

### 2. The registry / scheduler refactor

**Eligibility (the single definition used everywhere).**

```
eligible(agent, sub) :=
  agent.commitSha === sub.commitSha
  && (!agent.labels.includes(SUBMITTER_LABEL) || agent.ownerSubmissionId === sub.submissionId)
remote-eligible(agent, sub) := eligible(agent, sub) && !agent.labels.includes(SUBMITTER_LABEL)
```

**Data-model change (`dist/registry.ts`).**

- `RegisteredAgent.inFlight: Set<string>` → **`Map<string /*submissionId*/, Set<string /*taskId*/>>`**. Capacity is a physical property of the machine, so the check becomes `inFlightTotal(agent) < agent.capacity` (`inFlightTotal` = Σ set sizes). This is what lets one agent hold slots for two submissions at once and lets `drop` hand back the _right_ tasks to the _right_ submission.
- `RegisteredAgent.ownerSubmissionId?: string` (additive).
- `SessionState.active: ActiveSubmission | null` → **`Map<string /*submissionId*/, ActiveSubmission>`** plus a `rotation: number` for fair ordering.

**`ActiveSubmission` interface gains the "dispatchable" trio** (implemented by `DistScheduler`), keeping join/leave/message/readyDepth:

```ts
readonly submissionId: string
readonly commitSha: string
nextReady(): string | undefined              // peek this.ready[0]
affinityAgentId(taskId: string): string | undefined   // dep-affinity choice
assign(taskId: string, agent: RegisteredAgent): void  // splice ready, mark agent.inFlight[subId], send task:assign
```

**The fair-share dispatcher (the heart).** Fold it into the registry as a private method `dispatchSession(state)` — no new class needed; it iterates `state.active`:

```
dispatchSession(state):
  subs = [...state.active.values()]
  if subs.empty: return
  start = state.rotation++ % subs.length          // rotate so no submission is perpetually first
  order = subs[start:] ++ subs[:start]
  loop:
    progressed = false
    for sub in order:                              // ONE assignment per submission per pass
      taskId = sub.nextReady(); if none: continue
      agent  = pickAgent(state, sub, taskId); if none: continue
      sub.assign(taskId, agent)                    // increments inFlightTotal(agent)
      progressed = true
    if not progressed: break

pickAgent(state, sub, taskId):
  affinity = sub.affinityAgentId(taskId); first = undefined
  for a in state.agents.values():
    if not eligible(a, sub): continue
    if inFlightTotal(a) >= a.capacity: continue
    if a.agentId === affinity: return a            // dep-affinity wins
    first ??= a
  return first
```

**Fairness policy = max-min fair share:** each active submission gets at most one assignment per pass, and the starting submission rotates each `dispatchSession`. With 2 free slots and A(500 ready)/B(3 ready), pass 1 gives A one slot and B one slot — B is never starved. Work-conserving: when B runs out of ready tasks, remaining slots flow to A. (Deferred: _weighted_/priority shares — plain equal-share already solves the stated anti-starvation goal.)

**Trigger centralization.** `onAgentJoin/onAgentLeave/onAgentMessage` become **pure bookkeeping** (set `remoteJoined`, re-queue on leave, complete on done — no direct dispatch). The registry drives the fair loop exactly where state changes: end of `hello()`, end of `drop()`, end of `dispatch()` (message routing). `DistScheduler.start()` triggers it via the binding (`this.binding.requestDispatch()` → `dispatchSession`). `DistScheduler.dispatch()` (the private method at `scheduler.ts:290`) collapses to `this.binding?.requestDispatch()`.

**Routing changes (registry).**

- `hello()` (`registry.ts:114`): **delete the commit-refusal block (lines 130–137)** — commit is never a refusal now. Add agent, call `onAgentJoin` on every _commit-matching_ active sub (bookkeeping), then `dispatchSession(state)`. Protocol mismatch still refuses.
- `drop()` (`registry.ts:158`): for each `[subId, tasks]` in `agent.inFlight`, `state.active.get(subId)?.onAgentLeave(agent, [...tasks])`; then `dispatchSession(state)`. This is exactly "reassign only _that submission's_ tasks."
- `dispatch(agent, msg)` (`registry.ts:171`): route by `msg.submissionId` → `state.active.get(subId)?.onAgentMessage(agent, msg)`; then `dispatchSession(state)`.
- `beginSubmission()` (`registry.ts:196`): **remove the one-active error and the mismatched-agent drop (lines 202–213).** Guard only against a duplicate `submissionId` (a client bug; ULID → practically impossible). Insert into `state.active`. Return a binding: `agents()` = eligible agents for this sub, `requestDispatch()` = `dispatchSession(state)`, `drainIfLast()` (below), `end()` = remove from `state.active` **and delete its `subId` key from every session agent's `inFlight`** (prevents a leaked stale set after an aborted submission).
- `availableCapacity(ws, session, commit?)` (`registry.ts:275`): when `commit` is given, count `remoteAgents/remoteCapacity` over agents with `commitSha === commit && !SUBMITTER_LABEL`; `ready` = Σ `readyDepth()` over active subs.

**Scheduler changes (`dist/scheduler.ts`).** Add `submissionId` (from the submit message). Access in-flight through the per-submission slot: `agent.inFlight.get(this.submissionId)` (create on first assign; delete on done at `:197`). `attach()` sets `remoteJoined` from `binding.agents().some(a => !a.labels.includes(SUBMITTER_LABEL))`. `drainAgents()` (`:363`) routes through `binding.drainIfLast()` — **drain the session's agents only when this is the last active submission** (see §4). Everything else — the store prune, `onReady` cascade, group roll-up, `checkFinish` tallies, front-of-queue reassignment — is untouched.

### 3. Correctness + safety preserved

- **Per-task key equality (§6.3) untouched.** Each assignment is still a scoped `run([taskId])` with its dep closure on the owning agent; nothing about key derivation changes. Two same-commit submissions that both need `pkg#build` derive the _same_ key and share the _same_ artifact — dedup is a feature, not a hazard (the agent's `inflightRuns` map even collapses concurrent identical scoped runs).
- **No cross-commit contamination.** An agent holds exactly one commit and is eligible only for same-commit submissions, so its local cache never mixes commits. No `CACHE_VERSION`/`SCHEMA` bump.
- **Trust scopes untouched.** Each `dist:submit` still builds its own principal-scoped `scopedStore` in `serve.ts:952` from `ws.data.principal`; the prune stays per-submission-scoped.
- **Reassign-on-death is now per-submission** (the `drop` loop over `agent.inFlight` entries) — a shared agent's death reassigns A's tasks to A and B's tasks to B, leaving other agents' work alone.

### 4. Backwards / fail-safe

- **Self-registration preserved → no deadlock.** The self-agent is always eligible for its own submission (same commit, owner), so there is always ≥1 eligible agent; zero-_remote_-eligible still warns and completes on the self-agent = submitter-local.
- **`DIST_PROTOCOL_VERSION` 1 → 2** (the wire _does_ change: `task:assign`, `agent:start/stdout/stderr/done`, and `dist:submit` gain `submissionId`; `agent:hello` gains optional `ownerSubmissionId`). An old agent (`protocol:1`) hitting a new serve is cleanly `agent:refused` (names both versions); an old serve rejects a `protocol:2` submission. Old↔new is a clean refusal, never a silent mis-route.
- **Single-submission is a strict special case.** With one active submission, `dispatchSession` degenerates to the exact old greedy loop (assign `ready[0]`, affinity-preferred agent, until no free slot) → **byte-identical dispatch order and outcomes.** The only behavior change is intentional: a commit-_mismatched_ agent is now _ineligible_ rather than refused-and-dropped at pairing (a misconfigured CI matrix still surfaces loudly as "0 commit-matching remote agents"). Call this out; update the one pairing-refusal test.
- **Drain safety.** Normal finish never drains (agents persist for sequential reuse — unchanged). Submitter-death/abort drains **only if last active** (`drainIfLast`), so A's crash can never kill B's agents. Standing agents (`--idle-timeout 0`) are unaffected by normal finishes.

### 5. Concrete Phase-1 slice (implement this session)

The slice **is** "N concurrent commit-matched submissions per session, fair round-robin." Deferred (do **not** build): per-assignment re-checkout, cross-session pooling, submission-queue _persistence_, autoscaling, weighted/priority fairness, a dedicated `ephemeral` drain flag, duration-aware ordering.

**Files + symbols:**

1. `protocol-dist.ts` — `DIST_PROTOCOL_VERSION = 2`; add `submissionId` to `task:assign` (`DistServerMessage`), to `agent:start/stdout/stderr/done` (`DistClientMessage`), and to `DistSubmitMessage`; add optional `ownerSubmissionId?` to `AgentHello`; update the envelope adapters (`distServerMessageToEnvelope`, `distClientMessageToEnvelope`, `distSubmitToEnvelope`, and their inverses).
2. `dist/registry.ts` — `RegisteredAgent.inFlight` → `Map<string,Set<string>>`, add `ownerSubmissionId?`; `SessionState.active` → `Map` + `rotation`; extend `ActiveSubmission` (submissionId, nextReady, affinityAgentId, assign); rewrite `hello`/`drop`/`dispatch`/`beginSubmission`; add private `dispatchSession` + `pickAgent` + `inFlightTotal` + `eligible` helpers; `availableCapacity(ws, session, commit?)`; binding gains `requestDispatch()` + `drainIfLast()`.
3. `dist/scheduler.ts` — `submissionId` field; implement `nextReady`/`affinityAgentId`/`assign`; `dispatch()` → `binding.requestDispatch()`; slot-scoped inFlight; `drainAgents` → `binding.drainIfLast()`.
4. `dist/submit.ts` — generate `submissionId = Bun.randomUUIDv7()` before opening sockets; put it in `dist:submit` and pass `ownerSubmissionId` to the self-agent `runAgentLoop`; in **ambient** mode capture `captureGitContext` before `probeCapacity` and pass `&commit=<sha>` so a feature-branch dev with a `main`-pinned pool degrades to local _without_ submitting.
5. `dist/agent-loop.ts` — thread `submissionId` from `task:assign` through `executeAssigned(submissionId, taskId)` and into `agent:start/stdout/stderr/done`; add `ownerSubmissionId?` option → hello.
6. `cli/serve.ts` — the `dist:submit` handler (`:935`) no longer special-cases the concurrent-submission error (only a duplicate-`submissionId` guard remains); `handleAgentSocket` hello already forwards `msg` (carries `ownerSubmissionId`); `/v1/agents` GET (`:484`) reads optional `?commit=` and forwards to `availableCapacity`.

**Tests:**

- `dist-registry.test.ts` — update `fakeAgent`/manipulation to `Map` inFlight; add: two concurrent submissions in one session both accepted (no error); mismatched-commit agent stays registered but ineligible (replaces the drop-at-pairing assertion); `drop` of a shared agent hands each submission back only its own in-flight ids; commit-filtered `availableCapacity`.
- `dist-scheduler.test.ts` — port the `submission()` stub to the extended interface; keep the single-submission dispatch/prune/reassign assertions (must stay green byte-for-byte).
- **new `dist-multirun.test.ts`** — the three adversarial cases: (a) two submissions at the same commit sharing two 1-capacity agents interleave fairly (assert each agent alternates between submissions, both reach `ok`); (b) a submission at a commit no _remote_ agent holds gets zero eligible remote agents and completes on its self-agent only (warning emitted); (c) a shared agent dies mid-multiplex and only _its owner-submissions'_ in-flight tasks re-queue, the other agent's tasks untouched, both runs complete.
- `wire-dist.test.ts` — `submissionId`/`ownerSubmissionId` envelope round-trips; `DIST_PROTOCOL_VERSION === 2`.
- `agents-e2e.test.ts` — add: one serve + 2 pure agents (same commit) + **two concurrent** submitting clones with the same session; assert both runs succeed, tasks placed across agents for both, and no "already has an active submission" error.

**Verify:** real serve + 2 `vx-cloud agent` on same-commit clones + two concurrent `vx run` clones sharing a session → both complete, placement spans both agents for both runs, and killing one agent mid-run reassigns only that submission's tasks.

### Over-engineering to avoid (explicit)

Do not build in Phase 1: per-assignment re-checkout; a persisted submission queue; a separate `PoolDispatcher` class (a private `dispatchSession` method is enough); weighted/priority fairness; an `ephemeral` drain flag (the last-active guard suffices); duration-aware ordering; any autoscaler. Each is a distinct later increment on the _same_ registry + `runAgentLoop`.

### Why this is the right move

- **It removes exactly one fence** (`active: single → Map`) and the eligibility filter that follows; `runAgentLoop`, the correctness law, and the artifact transport are untouched.
- **Single-submission stays byte-identical** — the fair loop degenerates to today's greedy dispatch, so CI and solo pay nothing.
- **Every degradation is toward local execution, never a wrong hit** — no commit match → self-agent only; old peer → clean protocol refusal.
- **Fairness is provably non-starving** (max-min share, rotated) with ~40 lines of dispatcher, no new component.
- **The plain `vx run` is still sacred** — all of this lives behind a configured pool in `@vzn/vx-cloud`; core is unchanged.
