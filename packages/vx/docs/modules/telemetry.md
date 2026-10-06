# `src/orchestrator/telemetry.ts` — canonical telemetry export contract

## Purpose

THE versioned, serializable contract every telemetry consumer speaks
(`TELEMETRY_SCHEMA_VERSION = 3`). Exporters (otel, a custom sink) receive
these records instead of re-deriving facts from the rendering-oriented
`WireEvent` stream — `cacheSource` is derived once, git/CI/host context
is pre-folded, bigint wallclock spans are decimal strings.

## Public surface

- `TelemetryRecord` — per-event union: `run.start` / `task.start` /
  `task.log` / `task.sample` / `task.end` / `run.end`.
- `RunSummaryRecord` — one per run: `RunContextRecord` + totals +
  per-task `TaskTelemetry[]`. What every telemetry sink receives at
  end of run. `abortedCount` (v3, item 851) counts the tasks a
  shutdown signal or an embedder's abort killed; they are not in the
  task list, which holds real runs only, so without it a stopped run
  read as a failure with nothing failed.
- `assembleRunSummary(run, tasks, timing)` — builds the `RunSummaryRecord`
  from the context and the `TaskTelemetry[]`, the per-task tallies
  derived from `tasks`, so a distributed run and a local one produce
  the same summary.
- `deriveCacheSource(status)` — the `CacheSource`: `'local'` / `'remote'`
  for the two hits, `'miss'` for `success` / `failed`, `'none'` for
  `skipped` / `aborted`; never null.
- `taskTelemetryOf(outcome)` — the one projection of a `TaskOutcome` into
  `TaskTelemetry`, used by the streaming `task.end` record and the
  summary's `tasks[]` alike, so the two cannot drift (item 660).
- `createTelemetrySource({ sinks, run, warn?, owners? })` → a
  `TelemetrySource` — projects the bus once and fans out to sinks. `run`
  is the `RunContextRecord` stamped on `run.start`; `owners` names a
  nameless sink by its plugin.
- `TelemetrySink` — what a `telemetry` plugin returns: an optional
  `name`, a `wants` list of record kinds (the source checks it BEFORE
  projecting, so a sink pays nothing for kinds it declines), and
  `onRecord` / `onRunSummary` / `flush`. Every one is crash-isolated and
  `flush` is deadline-bounded. A warning names the sink by its `name`,
  else by its plugin's (`org/p`, or `org/p #2` for the second of a
  list), else by its place in the source's list (`#2`; item 1027).
- `TelemetryContext` — what the hook is handed: `workspaceRoot`,
  `cacheDir` (a STRING, not a Cache handle — a sink cannot reach the
  cache) and `warn`.
- `TelemetrySource` — the live projection: a bus `subscriber`,
  `emitSummary` and `flush`.
- `CacheSource` — `'miss' | 'local' | 'remote' | 'none'`, the cache axis
  every record carries.
- `TASK_STATUSES`, `isPassStatus(status)`, `isCacheHit(status)` — the
  task axis and the two predicates every surface shares.
- `TELEMETRY_SCHEMA_VERSION` — bumped when a record's shape changes, so a
  receiver can refuse what it cannot read.

## Records

What a sink receives, field by field (`TELEMETRY_SCHEMA_VERSION` 3;
held to the source by `telemetry-doc.test.ts`). An optional field is
additive: a consumer treats it as absent when a producer predates it.

```ts
interface RunContextRecord {
  runId: string // ULID shared by every record of one run
  vxVersion: string
  command: string // the command line; what follows `--` counted, never quoted
  requestedTasks: readonly string[]
  cachePolicy: string // e.g. 'lR,lW,rR,rW'
  concurrency: number
  flow: 'focused' | 'broad' | null
  workspaceId: string // from the normalized git remote (v2)
  workspaceName: string
  commitSha: string | null
  branch: string | null
  defaultBranch: string | null // a trunk run: branch === defaultBranch (v2)
  dirty: boolean | null
  ci: boolean
  ciProvider: string | null
  host: string | null
  os: string
  arch: string
  tags: Readonly<Record<string, string>> // `--tag k=v`
}

interface TaskTelemetry {
  taskId: string
  project: string
  task: string
  status: TaskStatus
  cacheSource: CacheSource
  exitCode: number
  durationMs: number
  hash?: string
  cpuMs?: number
  peakRssBytes?: number
  where?: string // an executor's placement; absent when run here
  outputs?: 'deferred' // the outputs stayed remote (`--download=none`)
  attempts?: number // more than one: the task retried
  blockedBy?: string // on a skipped task, the failure at the root of it
  timedOut?: true // on a failed task, vx's own timeout killed it
  sandboxViolations?: number
  notReady?: 'timeout' | 'exited' | 'spawn' // a persistent task never ready
  failedAttempts?: readonly FailedAttempt[] // a retried task's attempts that failed, in order
  restored?: boolean // on a hit: outputs restored (true) or already up to date (false)
  wallclockStartNs?: string // bigint ns from the run's start, as a decimal string
  wallclockEndNs?: string
}

interface RunSummaryRecord {
  v: number
  run: RunContextRecord
  startedAt: number
  endedAt: number
  totalDurationMs: number
  taskCount: number
  failedCount: number
  abortedCount: number // stopped by a signal or an abort, not in `tasks` (v3)
  hitCount: number
  hitLocalCount: number // hits by the layer that answered, up-to-date ones included
  hitRemoteCount: number
  upToDateCount: number // hits by what they did to the disk; the three sum to hitCount
  restoredLocalCount: number
  restoredRemoteCount: number
  exitOk: boolean
  tasks: readonly TaskTelemetry[]
  stages?: readonly RunStage[] // VX_TIMING's stages; those before the run lock end before startedAt
}

interface FailedAttempt {
  endedAt: number // epoch ms
  exitCode: number
  timedOut?: true
}

interface RunStage {
  name: string // a stage mark: startup, load configs, classify + probe, run graph, …
  startedAt: number // epoch ms, with a fraction
  endedAt: number
}
```

Each streaming record carries `v` and `kind`, and:

| `kind`        | Fields                                                             |
| ------------- | ------------------------------------------------------------------ |
| `run.start`   | `run`, `total`, `ts`, `startedAt`                                  |
| `task.start`  | `runId`, `taskId`, `project`, `task`, `command`, `dependsOn`, `ts` |
| `task.log`    | `runId`, `taskId`, `stream`, `chunk`, `ts` (opt-in)                |
| `task.sample` | `runId`, `taskId`, `ts`, `cpuMs`, `rssBytes` (opt-in)              |
| `task.end`    | `runId`, `ts`, every `TaskTelemetry` field                         |
| `run.end`     | `runId`, `ts`                                                      |

## Invariants

- **Observe-only by construction**: sinks receive plain-data records and
  a read-only context. A record is one object every sink receives, and
  it is not frozen, so a sink must not change it — no bus, no Cache, no path back into scheduling.
- **Crash isolation**: a throwing sink is disabled for the run, never
  propagates, and so is an `async` hook that rejects; it is said once,
  however many rejections follow (`telemetry-async-hooks.test.ts`).
- `task.log` is opt-in via `TelemetrySink.wants` (default excludes it).
- `task.sample` is opt-in the same way. Only when a sink wants it does the
  source offer `track(taskId, pid)`, which run.ts hands each task's
  executor as `ExecuteRequest.onSpawn`: one timer for the run samples each
  tracked task's live process tree every second (`sampleTrees`,
  `exec/proc-sample.ts`) and stops when nothing is tracked or the run
  ends. `cpuMs` is the tree's CPU so far (a descendant that exited leaves
  the sum), `rssBytes` its resident memory now. No sink wanting it: no
  timer, no read (`proc-sample.unsafe.test.ts`).
- Version bumps are additive-or-bump: a record whose shape changes bumps
  `TELEMETRY_SCHEMA_VERSION`, an integer, which a receiver may check to
  refuse what it cannot read; no first-party sink checks it.
