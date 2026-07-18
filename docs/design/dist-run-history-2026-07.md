# Distributed runs in Runs — the controller records like a local run

Status: design → build (2026-07-18)

## Problem

A local `cloud()` run lands in the dashboard's **Runs** history because
core's single-process `run()` emits telemetry → the `cloud()` sink builds a
`RunSummaryRecord` → `POST /v1/ingest` (+ per-task `POST /v1/ingest/task`
for live fill-in). A **distributed** run (`VX_CLOUD_DISTRIBUTE`) has no such
single `run()`: the submitter dispatches, and each agent runs its own scoped
slice. So nobody emits a whole-run summary, and the run never appears under
Runs. (Documented known-limit.)

## Insight (owner)

A distributed run **does** have a controller — the server-side
`DistScheduler`. It already:

- collects **every** task's `OutcomeView` (`this.outcomes`; it must, to know
  when the submission is finished),
- has the full submit context (`DistSubmitMessage`: `workspaceId`,
  `commitSha`, `branch`, `defaultBranch`, `session`, and the `RunRequest` —
  command, requested tasks, cache policy, concurrency, flow, tags), and every
  node's `TaskView` (project + task split),
- knows exactly when the run ends (`checkFinish()`), and lives **on the
  server, next to the Postgres analytics store**.

So the controller is the authoritative, server-local place to record the
run — and it can do it **live** (per task), exactly like a local run.

## Design

Record from the `DistScheduler`, reusing the existing analytics ingest paths.
Two hooks, both already single choke points:

- `complete(taskId, outcome, …)` → `recorder.taskDone(...)` → `Analytics.ingestTask`
  (a `task_runs` row the moment each task finishes — live fill-in).
- `checkFinish()` → `recorder.runFinished(summary)` → `Analytics.ingest`
  (the `invocations` header + the end-of-run backstop that backfills any
  dropped incremental row — same idempotent `ON CONFLICT` as the local path).

### Recorder seam

`DistSchedulerArgs.recorder?: DistRunRecorder` (optional, like `store`/`send`/
`durationHints` — keeps the scheduler unit-testable and decoupled from
`Analytics`). Interface:

```ts
interface DistRunRecorder {
  taskDone(rec: TaskIngestRecord): void // fire-and-forget, never throws
  runFinished(summary: RunSummaryRecord): void
}
```

The concrete recorder (built in `dispatch.ts` at scheduler creation) closes
over `analytics` + the submitter's `principal` (orgId + tokenWorkspaceId) and
calls `ingestTask`/`ingest` with `{ orgId, tokenWorkspaceId, … }` — the SAME
tenant routing a `POST /v1/ingest` uses. Errors are swallowed + warned:
recording is observe-only and must never fail a run (the local sink's rule).

### Run context (submitter → controller)

The invocation header needs the _invoking machine's_ context (os, arch, host,
ci, ciProvider, vxVersion, dirty, workspaceName) — for a distributed run that
is the **submitter** (the CI runner), exactly as a local run's header uses the
invoking machine. The submitter captures it with core's existing helpers
(`captureGitContext` for dirty, `detectCi`, `captureHostContext`,
`captureWorkspaceIdentity`, `VERSION`) and sends it **additively** on
`DistSubmitMessage.context?` — **no `DIST_PROTOCOL` bump** (the
branch/defaultBranch precedent; an older submitter omits it → the controller
records null context, still a valid row).

`detectCi` + `captureHostContext` are widened onto the core façade
(`src/index.ts`, export-only) so the cloud submitter can call them.

### Per-task timeline (the one real subtlety)

Each agent's `OutcomeView.wallclock*Ns` is relative to **that agent's own**
scoped `run()` start — **not** a shared clock, so the offsets from different
agents are not comparable. The controller is the only shared clock, and it
already observes `agent:start` (→ `task:start`) and `agent:done` (→
`task:complete`). So the controller stamps each task:

- `startedAtByTask[id]` = controller time at `agent:start` (or dispatch, for a
  task that completes without a start — a prune hit),
- `endedAtByTask[id]` = controller time at `agent:done` / synthesis.

These are encoded as **run-relative** wallclock ns
(`(stamp - startedAtMs) * 1e6`) so `insertTaskRun`'s existing derivation
(`started_at = runStartedAt + wallclockStartNs/1e6`, `runStartedAt =
startedAtMs`) yields a coherent shared epoch-ms timeline — the flamegraph
works with no analytics change. Prune/cache-hit/skip tasks get ~0-duration
stamps at their completion moment.

### Shared summary builder (unified with the local path)

The `RunSummaryRecord` is assembled through ONE canonical core builder,
`assembleRunSummary(run, tasks, { startedAt, endedAt, totalDurationMs, exitOk })`
(exported from `src/orchestrator/telemetry.ts` on the `@vzn/vx` façade). It
computes the per-task tallies (taskCount / failedCount / hitLocal|Remote|Count /
hitCount) from `tasks` and takes the run-level facts (`totalDurationMs` wall
time, `exitOk` the overall verdict) as inputs. Both `run()` (local) and the
distributed controller build their `TaskTelemetry[]` (each `cacheSource` via the
single `deriveCacheSource(status)` mapping) and call it — so a distributed run
and a local run produce byte-identical summaries and land in the same
`Analytics.ingest`. The ONLY distributed-specific code is the OutcomeView →
TaskTelemetry projection (a subset — agents don't report verify/outputFp/attempts
over the dist wire), the controller-clock wallclock timeline, and the submitter
run-context header; everything from `TaskTelemetry[]` onward is the shared path.

### Field mapping (OutcomeView + submit → RunSummaryRecord)

- `run.runId` = `submissionId` (client-minted ULID, unique per submission).
- `run.command` = `request.command` (fallback `vx run <tasks…>`).
- `run.requestedTasks` = `request.tasks`; `cachePolicy` = format(`request.cache`);
  `concurrency` = `request.concurrency ?? 0`; `flow` = `request.flow ?? 'broad'`;
  `tags` = `request.tags ?? {}`.
- `run.commitSha/branch/defaultBranch` = submit fields.
- `run.os/arch/host/ci/ciProvider/vxVersion/dirty/workspaceName` = submit `context`.
- `run.workspaceId` = submit `workspaceId` (the client id; the controller then
  routes it to the server workspace via `routeWorkspace`, same as ingest).
- per task (`TaskTelemetry`): `taskId/project/task` from `node.view`;
  `status/exitCode/durationMs/hash/cpuMs/peakRssBytes` from `OutcomeView`;
  `cacheSource` = `cache-hit`→`local`, `cache-hit-remote`→`remote`, else
  undefined; `wallclock*Ns` = the controller-stamped run-relative ns.
- summary tallies (`taskCount/failedCount/hitCount/hitLocalCount/
hitRemoteCount/exitOk/startedAt/endedAt/totalDurationMs`) computed from the
  outcomes (the same counting `checkFinish` already does).

### Idempotency & safety

- run_id = submissionId; task key `(started_at, run_id, project, task)` — the
  incremental `taskDone` and the end-of-run `runFinished` derive it identically
  (controller-stamped started_at is stable within the run), so the header
  backstop's `ON CONFLICT DO NOTHING` dedups any task already ingested live.
- Recording is fully best-effort: a throw in `taskDone`/`runFinished` is caught
  and never touches scheduling. A scheduler built with no `recorder` (unit
  tests) is byte-identical to today.
- Tenant boundary: routing uses the submitter's principal only — a distributed
  run records under the submitting token's org/workspace, never another's.

## Non-goals

- Per-task **log** capture on the distributed path (agents don't stream their
  captured tails to the controller today; the run + task rows land, logs are a
  later increment — same phasing the local path used).
- A live "running" row before completion (Runs shows the run once its first
  task_run lands; a pre-start placeholder is out of scope).

## Test

Extend the real 2-agent e2e (`agents-e2e` / a new `dist-ingest` suite on the
platform helper: ephemeral pg + fake S3 + the real registry/scheduler): submit
a small graph across two agents, then assert `Analytics.listInvocations(ws)`
returns the run with the right tallies and `task_runs` rows exist with correct
`cacheSource`, and that a re-derived header ingest is idempotent (no dup rows).

## Docs

Remove the "No run history for a distributed run" known-limit from
`cloud/dashboard.md` + `cloud/distributed-ci.md`; note distributed runs now
appear under Runs and fill in live. Decision-log entry.
