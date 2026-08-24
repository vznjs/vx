# Per-task executor seam + `@vzn/vx-reapi` (2026-08)

Owner decision, 2026-08-22: vx-cloud is too complex to set up and work with.
Core becomes the thing anyone can build a "vx cloud" on top of, through
plugins alone; the Bazel Remote Execution API (REAPI) is the first such
plugin, so NativeLink / BuildBuddy / Buildbarn / bazel-remote work out of the
box. vx-cloud is NOT deleted by this design — it coexists, and its
distributed-execution half is retired later on evidence.

## 1. The problem, precisely

Core already has three plugin capabilities: `cache` (where artifacts live),
`backend` (where work runs), `telemetry` (where run records go). Two are the
right grain. One is not.

`backend` delegates a **whole run**. vx-cloud implemented it by moving the
**scheduler** to its server (`DistScheduler`) — chosen so a standing agent
pool could dispatch fairly across many concurrent submitters. That one choice
forced every run-level concern to be re-implemented server-side: cache
restore, output materialisation, task logging, the run record, and
telemetry. The local `otel()` sink is blind to a distributed run; the
"distributed runs ingest no summary" gap was patched three times because it
is structural. ~19k lines and seven mandatory env vars follow from it.

REAPI shows the alternative grain: the client owns the DAG and scheduler; the
server executes **one action at a time** and does fair queuing at the action
level, with no knowledge of any client's graph. Telemetry (Bazel's BEP) is
emitted client-side and therefore sees every action, local or remote. Six
independent REAPI servers exist because the server is dumb.

## 2. Goals / non-goals

Goals:

- A plugin can contribute where ONE task's command executes, with the
  scheduler, cache, retries, timeouts, logger and telemetry unchanged above it.
- A distributed run is telemetrically indistinguishable from a local one.
- `@vzn/vx-reapi` provides remote cache + remote execution against any REAPI
  server with one endpoint + headers of configuration.
- A community "vx cloud" (same-checkout agents over any transport, their own
  store, their own analytics) is buildable on the same seams, with no core
  change.

Non-goals:

- A shared-service / sidecar abstraction across remote actions (breaks the
  one-action-one-sandbox contract that makes REAPI servers interchangeable).
- Auto-inferring inputs so non-hermetic tasks can run remotely. `--verify=inputs`
  proves declared inputs; it does not guess them. (Standing non-goal.)
- Deleting vx-cloud in this design. See §10.

## 3. The plugin contract after this design

```
VxPlugin
  cache(ctx)     → CacheLayer     where artifacts live            (existing, unchanged)
  executor(ctx)  → TaskExecutor   where ONE task's command runs   (NEW)
  telemetry(ctx) → TelemetrySink  where run/task records go       (existing, unchanged)
  backend(ctx)   → RunBackend     whole-run delegation            (DEPRECATED the day executor lands)
  setup / teardown                                                (existing)
```

| Plugin                            | cache                | executor                | telemetry   |
| --------------------------------- | -------------------- | ----------------------- | ----------- |
| `vx-reapi`                        | ✓                    | ✓                       | —           |
| `vx-otel`                         | —                    | —                       | ✓           |
| `vx-github` (summary + check run) | —                    | —                       | ✓           |
| vx-cloud today                    | native wire          | `backend`               | ✓           |
| a community cloud                 | their store          | their agents            | their DB/UI |
| declared by every workspace       | `localCachePlugin()` | `localExecutorPlugin()` | —           |

**No defaults.** Core applies no plugin on its own; `localExecutorPlugin()`
(`@vzn/vx/plugins/local-executor`) and `localCachePlugin()`
(`@vzn/vx/plugins/local-cache`) live under `src/plugins/`, import core only
via `'@vzn/vx'`, and are declared like any other — a workspace that declares
none fails before any task runs. **Lists, not winners:** every `executor` is
kept in declaration order and per task the first whose `accepts()` passes
runs it; every `cache` layer is kept and chained (lookup walks, save reaches
all, the first owns the run index; a layer wrapping the local handle
subsumes the bare local one); `telemetry` sinks are additive. `backend`
stays single-winner and, when contributed, delegates the whole run
(executors are not consulted) — this is what lets vx-cloud's dist path keep
working unchanged during coexistence.

## 4. The `executor` seam

```ts
interface TaskExecutor {
  execute(req: ExecuteRequest, signal: AbortSignal): Promise<ExecuteResult>
  /** Optional: flush/close at end of run. Errors logged, never thrown. */
  close?(): Promise<void>
}

interface ExecuteRequest {
  // identity — for same-checkout transports
  readonly taskId: string
  readonly workspaceRoot: string
  // the command — for input-shipping transports and the local default
  readonly command: string // run as `sh -c`
  readonly cwd: string // absolute; project dir
  readonly env: NodeJS.ProcessEnv
  readonly forwardArgs: readonly string[]
  readonly timeoutMs?: number
  readonly onStdout: (chunk: string) => void
  readonly onStderr: (chunk: string) => void
  /** Everything the cache key folds, WITH values — miss path of a cacheable task only. SHIPPED. */
  readonly inputs?: TaskInputs
}

// Inputs are NOT only files. The key folds nine component kinds and a
// remote executor needs each for a different reason:
interface TaskInputs {
  readonly files: readonly InputFile[] // declared files + workspaceFiles: the bytes that ship
  readonly env: ReadonlyArray<{ name: string; value: string }> // declared env, resolved: set on the worker
  readonly runtime: ReadonlyArray<{ command: string; output: string }> // toolchain expectation → REAPI platform property / assert on worker
  readonly workspaceRuntime: ReadonlyArray<{ command: string; output: string }>
  readonly upstream: ReadonlyArray<{ taskId: string; hash: string }> // dependency artifacts, by key, via the cache layer
  readonly packageJsonDigest: string // the project manifest is folded even when no glob lists it
  readonly configDigest: string // identity only
  readonly workspaceFingerprint: string // identity; the files behind it are ambient (see below)
}

interface InputFile {
  readonly path: string // workspace-relative, POSIX
  readonly digest: string // git blob OID of the WORKTREE bytes — the digest the key folds
}

// What the key does NOT mention, because it treats them as environment:
// tsconfig.json, .npmrc, root manifests, the lockfile, node_modules. A
// same-checkout agent has them; an input-shipping executor must get them
// from the worker image or an install action (§7.4). `--verify=inputs`
// exposes the gap per task.

interface ExecuteResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  /** Where the outputs are.
   *  'disk'     = in place under cwd (local default, or a remote executor that downloaded).
   *  'deferred' = referenced but not materialised (download policy 'none'/'toplevel');
   *               `materialize()` fetches.
   *  'cache'    = the executor saved the artifact to the run's remote CacheLayer under
   *               this task's key (same-checkout agents: the §6.3 induction law); core
   *               restores it through the ordinary hit path and skips its own save. */
  readonly outputs:
    | { kind: 'disk' }
    | { kind: 'deferred'; materialize(): Promise<void> }
    | { kind: 'cache' }
  readonly resourceUsage?: { cpuTimeMs: number; maxRssBytes: number }
  readonly where: 'local' | string // executor-reported label; rides telemetry
}
```

Core changes required by the seam:

- `exec/runner.ts`'s spawn becomes the default `TaskExecutor` (`localExecutor`).
  Persistent tasks (`readyWhen`), SIGINT forwarding, `liveChildren`, and
  `resourceUsage` stay in it — they are local-only concerns by the placement
  rule (§5).
- `orchestrator/task-hash.ts` exposes `describeTaskInputs`: the same
  resolution as the key, returning the structured set with values (SHIPPED
  2026-08-23). Miss path only; the hit path pays nothing.
- `execute-task.ts` calls `executor.execute` where it spawned. Probe → execute
  → save is unchanged; save of a `deferred` output set is skipped locally and
  the remote cache entry is the executor's own (it already lives in the CAS).
- `TaskOutcome` gains `where` so `otel()`/telemetry can attribute a task to a
  worker.

## 5. Placement rule

A task runs on the local executor — no flag needed — when:

1. it is persistent (`readyWhen` or foreground), or
2. anything in its dependency closure is persistent (a remote worker cannot
   reach `localhost` on the submitter), or
3. `exec.remote === false` (author-declared: touches the network, a local
   daemon, Docker, …).

`exec.remote` is `true | false | 'only'`, default `true`. `'only'` is the
inverse pin (§7.4): the task exists to produce a remote input tree and is a
no-op on the local executor. Everything else is remote-eligible when a
plugin contributes an `executor`.
The rule is decided once per task at plan time and shown in `--dry`/`--graph`.

**SHIPPED IN FULL — `'only'` landed later the same day** with the
worker→CAS→worker chaining that gives it a purpose (see §7.4). The original
note stands below as the record of the staging. `exec.remote` was
`boolean` first: rules 1–3 above are implemented (`pinnedLocalSet` in
`run.ts` walks the dependency closure), placement is decided once per task
before scheduling, and `--dry` names the placed executor per task whenever
the workspace declares more than one. `'only'` is NOT implemented and is
deliberately deferred to the plugin wave that gives it a purpose: it has
real local BEHAVIOUR (skip the task, never clean or restore its outputs
here), and shipping that with no input-shipping executor in existence would
give a user who declares it a silently skipped task. Widening the type is
additive when phase 2's plugin lands. `TaskOutcome.where` (§4) is likewise
not shipped — telemetry still attributes every task to the local host.

Patterns this implies, documented rather than abstracted away:

- **Server is a vx task, tests depend on it:** the whole cluster is local;
  the server's upstream build may still be remote with outputs downloaded.
- **Server is the test's own business** (`'pnpm start & wait-on … && playwright test'`):
  one hermetic action; remote-eligible; N shards = N boots, on N workers.
  Expensive boot → move the expensive part upstream into a cached action.
- **Server is external infra:** `exec.remote: false`, or accept non-hermetic
  remote execution via the plugin's platform/worker-pool configuration.

## 6. Core inventory: add / keep / delete

| Core item                                                                          | Verdict                                                                       |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `executor` capability + `localExecutor`                                            | **Add**                                                                       |
| `exec.remote` schema field + placement rule                                        | **Add** — SHIPPED 2026-08-23 as `boolean` (`'only'` deferred, see §5)         |
| `--download=all\|toplevel\|none` run option                                        | **Add** (phase 3; phase 1–2 behave as `all`)                                  |
| `cache` capability, `LayeredCache`, prefetch, shortcircuit, stable-keys            | **Keep** — generic second-tier machinery; REAPI plugs in                      |
| `telemetry` capability and its record types, `TaskLogBuffer`, fingerprints         | **Keep** — the analytics seam a community cloud builds on                     |
| `run-context.ts` (git/CI/host/PR scope)                                            | **Keep** — provider-neutral context every ctx receives                        |
| `events.ts` bus + `WireEvent` (logger, MCP, metrics consume it)                    | **Keep**                                                                      |
| `backend` capability, `protocol.ts`, `wire.ts`, `wire-render.ts`, `cli/backend.ts` | **Deprecate** at phase 2; **delete** when cloud's dist half retires (phase 4) |
| `eventSink` (deprecated)                                                           | **Delete** at phase 2 (cloud no longer uses it)                               |
| `devframe-surface.ts`                                                              | **Delete** if no core consumer remains (verify in the plan)                   |
| `metrics.ts`, `history`/`predict`, `vx mcp`                                        | **Keep** — local SQLite insights                                              |

## 7. `@vzn/vx-reapi`

Config: `reapi({ endpoint, instanceName?, headers?, digest?: 'sha256' | 'blake3', platform?: Record<string,string> })`.
One plugin, two capabilities.

### 7.1 Mapping

| vx                                                            | REAPI                                                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| task command, cwd, env                                        | `Command{arguments:['sh','-c',cmd], working_directory:<project dir>, environment_variables}` |
| `inputs` (declared files + workspaceFiles + upstream outputs) | `Directory` Merkle tree rooted at the workspace root                                         |
| `outputs` globs                                               | `output_paths` = the top-level dirs/files the globs imply; filter on download                |
| `exec.timeout`                                                | `Action.timeout`                                                                             |
| cache entry                                                   | `ActionResult` (outputs as a `Tree` in the CAS + `stdout_digest`)                            |
| remote cache                                                  | `ActionCache` + `ContentAddressableStorage` (same server, `Execute` simply unused)           |
| remote execution                                              | `Execute` → `Operation` stream → `WaitExecution` on disconnect                               |
| `exec.retries`, scheduler, telemetry                          | client-side, unchanged                                                                       |
| persistent tasks                                              | never remote (placement rule)                                                                |

### 7.2 Transfer model

- Every blob is content-addressed; `FindMissingBlobs` before upload. Upload
  is proportional to the **diff**, never to the number of affected tasks: 200
  changed files upload 200 blobs whether 3 or 300 tasks consume them. The
  same file in 50 input trees is one blob.
- Upstream outputs are referenced by `Tree` digest; they were uploaded by the
  worker that produced them and never transit the submitter. A 50-task chain
  runs worker→CAS→worker.
- Digests: SHA-256 (default) or BLAKE3 where the server advertises it.
  Git-blob-OID shortcutting does not transfer (different hash). Per-file
  digests are cached in the plugin's own SQLite table keyed by
  `(path, size, mtime_ns)` — Bazel's digest cache. First run on a fresh
  checkout hashes declared inputs once.
- The first run against an EMPTY CAS uploads the declared source inputs in
  full. Documented, not hidden.

### 7.3 Remote cache (phase 1 — no core change)

`cache(ctx)` returns a `CacheLayer` that stores today's artifact tar as one
CAS blob and an `ActionResult` under a synthetic action digest derived from
the vx cache key (the Gradle/sccache convention for AC reuse). This ships a
working remote cache on any REAPI server through the existing `LayeredCache`
seam and retires the gRPC-on-Bun risk on real traffic before any core change.

Phase 3 unifies the shapes: the local cache becomes CAS + AC
(`cas-backend.ts`/`digest.ts` were written anticipating this), so a
remotely-executed task's `Tree` and a cached entry are the same thing and
nothing is re-tarred.

### 7.4 `node_modules`

REAPI has no per-worker setup hook by design (workers are stateless). The
install step is an **explicit vx task** (decision: explicit over magical):

```ts
// root vx.config.ts
install: {
  exec: { command: 'pnpm install --frozen-lockfile', remote: 'only' },   // see below
  cache: { inputs: { files: ['package.json', 'pnpm-lock.yaml', 'packages/*/package.json'] },
           outputs: ['node_modules/**', 'packages/*/node_modules/**'] },
}
build: { dependsOn: ['//#install', '^build'], … }
```

- The action is cached in the AC, so it runs **once per lockfile change,
  ever**, across all workers and developers — "before computing, not every
  run".
- It runs **on a worker**, so platform binaries (esbuild, swc, sharp) are
  built for the worker's platform. Shipping a laptop's `node_modules` would be
  wrong across platforms; this is why "install as action" beats "upload".
- `exec.remote: 'only'`: the task exists only
  to produce a remote input tree; locally it is a no-op and `node_modules`
  is never cleaned or restored on the developer's disk.
- **pnpm slicing** (plugin-side optimisation, no behaviour change): pnpm's
  lockfile lists each importer's transitive closure, and
  `packages/foo/node_modules/*` are symlinks into `.pnpm/<pkg>@<ver>`. A
  task's input references only its package's slice of the install output —
  a new `Directory` over existing blobs, zero upload, typically 5–20% of the
  store.
- Remaining cost: materialising the slice's hard-links per action (~1–3 s for
  tens of thousands of files on NativeLink's filesystem store; lazily on a
  FUSE worker). Documented as the price of hermetic remote execution.

### 7.5 Hermeticity

A task reading an undeclared file fails on a worker with "no such file" —
loud. The silent class is optional-file fallbacks (a missing `tsconfig` →
defaults). `--verify=inputs` (sandbox-proven input completeness) is the gate
the docs recommend before marking a task remote-eligible; a future
`vx verify --remote` could run it over the remote-eligible set.

## 8. Analytics

Unchanged by construction: the scheduler is local, so every task outcome —
including ones executed on a worker — reaches the bus, every `telemetry`
sink, `otel()`, `vx-github`, and vx-cloud's own telemetry rung. `TaskOutcome.where`
attributes the worker. REAPI has no analytics concept and needs none of
this; a community cloud builds its analytics on exactly this seam.

## 9. Phases

Each phase is its own implementation plan; phase 1 is written first and
nothing in it depends on a later phase.

1. **Remote cache via REAPI** — `vx-reapi` `cache` capability only. Zero core
   change. **SHIPPED 2026-08-23.** `ReapiClient` (Capabilities, CAS,
   ActionCache, ByteStream) + `ReapiRemoteCache` filling core's
   `RemoteCacheLayer` seam, composed through `LayeredCache` by the `reapi()`
   plugin; declines with no endpoint. Round-trip verified against a live
   bazel-remote, including a 1 MB artifact spanning 8 ByteStream messages.
   The spike this phase existed to de-risk is §14.
2. **`executor` seam** — core: `TaskExecutor`, `localExecutor`, `task-hash`
   returns inputs, placement rule + `exec.remote`, `TaskOutcome.where`;
   `backend`/`eventSink` deprecated. Plugin: `Execute`, Merkle tree builder,
   digest cache, `install` docs, pnpm slicing. Outputs always downloaded.
3. **Download policy + CAS-shaped local cache** — `--download`, `deferred`
   outputs, local cache as CAS + AC; `isOutputsCurrent` gains the per-output
   content hash it has wanted.
4. **Port vx-cloud's dist to `executor`; delete whole-run delegation.**
   Cloud's executor puts ONE assignment on the server's per-task queue; an
   agent runs it exactly as today (scoped `vx run` with the dep closure,
   artifact saved to the native cache under the full-run key by induction)
   and reports exit code + stdout; the executor returns `outputs: {kind:'cache'}`
   and the submitter restores through its ordinary hit path. This deletes
   `DistScheduler`, `dist-recorder`, the run submission/session plumbing and
   the `backend` rung; the server keeps the agent registry, heartbeats, and a
   per-task queue with max-min fairness across submitters (the REAPI-server
   shape), with LPT ordering applied to the queue instead of a run scheduler.
   Telemetry blindness disappears because the scheduler never left. Then
   delete core's `backend` + protocol/wire, and salvage `github-summary`/
   `github-check` into `@vzn/vx-github`. If the port is not worth doing, the
   fallback is deleting cloud's dist half outright; the analytics half (OTLP
   receiver + Postgres + dashboard) remains a telemetry plugin either way.

## 10. Coexistence with vx-cloud

During phases 1–3 vx-cloud is untouched and keeps compiling against every
core change (it is part of the gate). Its dist path works through `backend`;
its telemetry rung sees REAPI-executed runs in full — the dashboard shows
them with no cloud server involvement in execution. Costs of coexistence:
~19k lines + the Postgres/S3 CI job stay in the gate; ~500 lines of
delegation stay in core; cloud's own dist runs stay locally
telemetry-blind (structural). These are the evidence for phase 4.

## 11. Risks and mandated spikes

| Risk                                              | Mitigation                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| gRPC/HTTP-2 client on Bun                         | **REALIZED — see §14. The spike found a hard blocker; phase 1 is not buildable as designed.**              |
| No live stdout from REAPI by default              | Use `stdout_stream_name` over ByteStream where the server supports it; else log on completion (documented) |
| Output globs → `output_paths`                     | Top-level-dir mapping + client-side filter; a glob that escapes the project dir is refused at plan time    |
| Non-hermetic tasks run remotely                   | Placement rule + `--verify=inputs` as the documented gate; failures are loud                               |
| Digest cost on fresh checkouts                    | mtime/size digest cache; measured before/after on the bench workspace                                      |
| Two cache keys (xxh3 local, action digest remote) | Accepted in phases 1–2; unified in phase 3                                                                 |

## 12. Testing

- Seam: a fake `TaskExecutor` in tests proves scheduler/cache/telemetry/logger
  are executor-agnostic — a run with every task executed by the fake produces
  byte-identical telemetry records to the local run (the §8 claim, pinned).
- Placement: `--dry` shows `local`/`remote` per task; the three rules each
  get a differential test.
- Plugin: a REAPI server in CI (bazel-remote is a single static binary; NativeLink
  has an official image). Round-trip a cache entry; execute an action with an
  upstream `Tree` input; verify `FindMissingBlobs` uploads exactly the diff on a
  second run (assert the exact blob set, not "fewer").
- Hermeticity: a task with an undeclared input fails remotely and passes
  locally — the control that proves the worker sandbox is real.
- `install`: the action digest is stable across two checkouts of the same
  lockfile and changes on a lockfile edit.

## 13. Decisions recorded

- Scheduler never leaves the `vx run` process. (Bazel grain.)
- `executor` is per task; `backend` is deprecated, not removed, until phase 4.
- Install is an explicit task with `remote: 'only'`; the plugin contributes
  only slicing.
- Continuous tasks and their dependents are local by rule, never by flag.
- No shared-service abstraction across remote actions.
- vx-cloud coexists; its dist half is ported to `executor` (or retired) in
  phase 4, its analytics half is a telemetry plugin.

## 14. Spike result (2026-08-23): gRPC works on Bun; the chunk limit is PEER-dependent

The phase-1 spike §9/§11 mandated ran against a real `bazel-remote`
(`buchgr/bazel-remote-cache`, gRPC on a container port). **Outcome: the risk
is retired. `@grpc/grpc-js` works on Bun with no new dependency, no custom
transport, no proxy and no external binary — provided each ByteStream message
stays under a size the PEER's flow-control behaviour determines. This package
ships 128 KB (owner decision), measured safe against bazel-remote.**

> **Correction (same day).** The first version of this section concluded
> "phase 1 is not shippable as designed" and listed four unpalatable options.
> That conclusion was WRONG in its consequence and is corrected here rather
> than quietly dropped. The underlying Bun defect is real and reproduces
> exactly as described; what was wrong was the inference that it blocked
> phase 1. It does not, because every chunked upload can stay under the
> threshold — which is standard practice anyway.

### The defect, characterised precisely

**Bun's `node:http2` client hangs when a request carries MORE THAN ONE
message and any single message exceeds a threshold set by the PEER's
flow-control behaviour.** A lone message of any size is fine (the stream ends
immediately and Bun flushes it), which is why the first probes looked
inconsistent.

Measured boundary against bazel-remote — the variable is the **per-message
size**, not the total and not the message count:

| chunk  | total  | messages | Bun                              |
| ------ | ------ | -------- | -------------------------------- |
| 100 B  | 200 B  | 2        | works                            |
| 64 KB  | 512 KB | 8        | works                            |
| 64 KB  | 1 MB   | 16       | works                            |
| 64 KB  | 12 MB  | 192      | **works — 136 ms, 88 MB/s**      |
| 128 KB | 512 KB | 4        | hangs                            |
| 128 KB | 1 MB   | 8        | hangs                            |
| 512 KB | 1 MB   | 2        | hangs                            |
| 3 MB   | 3 MB   | 1        | works (single-message exception) |

On Bun **1.4.0** the same search put the boundary at 220 928 bytes works /
221 056 hangs, and the hang is PERMANENT — verified over a 120-second budget,
so it is not the transient ~28 s stall of the still-open Bun #39796.

> **Correction (2026-08-24).** That "boundary" is a RACE PROBABILITY, not a
> line: 128 KB chunks — comfortably inside the measured-safe region — passed
> hundreds of local and CI runs and then wedged ONCE on CI, on the identical
> Bun build (`34cbb9a40`). A binary search over a timing race produces a
> crisp-looking threshold that is really the point where the failure
> probability crosses the sample size. Only ≤ 65 535 (the RFC default
> initial window) has never been observed hanging anywhere. The client now
> DOWNGRADES adaptively: a `DEADLINE_EXCEEDED` on a multi-message write
> retries once at `SAFE_CHUNK_BYTES`, warned — the 128 KB default stays the
> fast path, and the rare stall costs one deadline instead of the task.

Ruled out along the way, each by an executed probe rather than reasoning:
**not** grpc-js (a hand-rolled gRPC framing over raw `node:http2` hangs
identically); **not** the backpressure handling (a version with no `drain`
pump hangs the same); **not** multiple `write()` calls (concatenating every
frame into ONE `write()` hangs too); **not** `Uint8Array.subarray` byteOffset
handling (copying each chunk changes nothing); **not** the server (Node 24
succeeds against the same container at every chunk size); **not** the Bun
version — 1.3.14 and 1.4.0 both exhibit it, at different thresholds.

### Upstream: mostly fixed already, and the mechanism is named

- **#26915** (closed 2026-03-01) — "client ignores `initialWindowSize` and
  never sends `WINDOW_UPDATE` — streams stall at 65 535 bytes".
- **#30342** (closed 2026-07-24) — the same class from the SEND side, reported
  through `@grpc/grpc-js`: a request body over 65 535 bytes hangs when "the
  peer sends a connection-level `WINDOW_UPDATE` followed by a `SETTINGS` frame
  that increases `SETTINGS_INITIAL_WINDOW_SIZE`". Maintainer's root cause:
  `handleSettingsFrame()` gated the per-stream window update on the
  CONNECTION-level `remoteWindowSize`, so the per-stream update was skipped and
  queued DATA hung forever. **Fixed by #31584** (merged 2026-06-18) — record
  the previous `initialWindowSize`, compute the delta, apply it to every stream
  per RFC 7540 §6.9.2.

That fix ships in 1.4.0, which is exactly why the ceiling ROSE (~64 KB →
~216 KB) instead of the hang disappearing. What remains is a residual stall in
the same area. (Separately, **#39796** is OPEN: a ~28 s inbound-frame stall on
1.4.0 that 1.3.14 does not have. Different symptom — ours never recovers.)

### The limit is a property of the PEER, not a number

Proven by holding the client shape constant and changing only the server. The
identical "4 MB in 256 KB writes" pattern:

| peer                                            | result         |
| ----------------------------------------------- | -------------- |
| bazel-remote (Go gRPC, BDP window growth)       | **hangs**      |
| `node:http2` server, `initialWindowSize` 64 KB  | completes 4 MB |
| `node:http2` server, `initialWindowSize` 256 KB | completes 4 MB |

Go's gRPC server grows its window dynamically (BDP estimation: `WINDOW_UPDATE`
then a `SETTINGS` raise) — the exact sequence #30342 describes. A Node http2
server does not, and Bun is fine against it.

**So there is no server-independent safe size above 65 535** — the RFC default
initial window, which every peer must honour with no `WINDOW_UPDATE` at all.
128 KB is MEASURED safe against bazel-remote and is what ships; it is
UNVERIFIED against NativeLink (Rust/tonic), BuildBuddy and Buildbarn. The
`reapi({ chunkBytes })` option exists so a deployment that hits this can drop
to 65 535 without waiting for a release.

### What works on Bun today

- `@grpc/proto-loader` parses the full REAPI proto set in **28 ms** and
  constructs `ActionCache`, `ContentAddressableStorage`, `Capabilities` and
  `Execution` clients.
- **Unary calls** — `GetCapabilities`, `FindMissingBlobs`, `BatchUpdateBlobs`,
  `BatchReadBlobs`, `UpdateActionResult`, `GetActionResult`, round-tripped
  with bytes verified identical.
- **Server-streaming** — `ByteStream.Read`, 2 MB in 32 chunks, bytes identical.
- **Client-streaming** — `ByteStream.Write` at 64 KB chunks: 12 MB at 88 MB/s.
- A cache MISS surfaces as gRPC code **5 NOT_FOUND** — the clean signal the
  degrade-to-miss contract needs.
- An oversized unary call is **refused cleanly**, not truncated:
  `BatchUpdateBlobs` with 12 MB → code 8, `received message larger than max
(12582997 vs. 4194304)`.

So phase 1 builds as designed. The chunk size is the one constraint: it lives
in the ByteStream writer with a comment pointing here, is overridable per
deployment via `reapi({ chunkBytes })`, and carries a test that fails if
someone raises the default — because exceeding the limit does not error, it
HANGS.

### Two false passes worth recording

1. "2 MB ByteStream write succeeded" was **wrong** — that run had already
   uploaded the identical blob via `BatchUpdateBlobs`, so the server
   short-circuited an already-present blob. Re-tested with a blob the server
   had never seen, it hung. _Assert the precondition, not just the outcome._
2. Port 9092 was already bound by an unrelated local service, so the first
   container "started" and the probe would have talked to something else. The
   spike moved to 19092 and asserted the container was actually up.

### A third finding, load-bearing for phase 1

bazel-remote **rewrites `stdout_raw` into a CAS blob** and returns
`stdout_digest` instead. Verified it genuinely stores the blob (precondition:
absent from CAS; after: present and byte-identical) rather than returning a
dangling reference. A portable client must therefore accept **either** form on
read. vx's cached entry carries stdout, so this is directly in the path.
