# Execution flows, scenario by scenario

Companion to [`execution.md`](./execution.md) (prose lifecycle) and
[`caching.md`](./caching.md) (key derivation). Each section is one
end-to-end scenario as a diagram, with the source files that own each
step. Diagrams are Mermaid — GitHub renders them inline.

## 1. Cold run — cache miss → exec → save

The path a task takes the first time it runs (or after any input
changed). Owners: `orchestrator/execute-task.ts` (sequence),
`cache/inputs.ts` + `cache/git-inputs.ts` (enumeration),
`cache/key-fold.ts` (key), `cache/cache.ts` (save),
`exec/runner.ts` (spawn).

```mermaid
sequenceDiagram
    participant S as scheduler
    participant X as execute-task
    participant I as cache/inputs + git-inputs
    participant C as CacheLayer
    participant R as exec/runner

    S->>X: execute(node, upstream)
    X->>I: resolveFiles(inputs.files)
    Note over I: git ls-files + git status (workspace-root snapshot,<br/>partitioned per project) + Bun.Glob match,<br/>nested projects + declared outputs excluded
    X->>X: hashTaskConfig + hashProjectPackageJson<br/>+ filterUpstreamHashes + env values
    X->>C: key(...) → 16-hex xxh3 (the per-component<br/>input fingerprint is captured on a miss: describeTaskInputs)
    X->>C: get(hash)
    C-->>X: null (miss)
    X->>I: cleanOutputs(outputs.files)
    Note over I: declared outputs wiped so the tree ends<br/>bit-identical to what gets cached
    X->>R: executor.execute(req) — the local executor calls runCommand
    R-->>X: exitCode, cpuMs, peakRssBytes (streams live via logger)
    alt exitCode == 0 and writes enabled
        X->>C: save({hash, outputs, stdout, inputComponents})<br/>(deferred to the save lane, dependents wait on it)
        Note over C: pack tar.zst (stdout + outputs/*) →<br/>tmp file → one SQLite txn<br/>(rename into place + entries + output_files + entry_inputs)<br/>(+ background remote PUT when layered)
        X->>I: markOutputsChanged(written rel paths)
        Note over I: the project's git snapshot notes the changed<br/>paths — a downstream task re-spawns git only<br/>when its input globs can actually match them
    else exitCode != 0
        Note over X: nothing cached — failure streams live,<br/>dependents get skipped by the scheduler
    end
    X-->>S: TaskOutcome
```

## 2. Warm run — local cache hit

Owners: `cache/cache.ts:get`, `orchestrator/hit-restore.ts` (the up-to-date check and the restore), `cache/output-index.ts:isOutputsCurrent`, `cache/archive.ts:extractArtifactStream`.

```mermaid
sequenceDiagram
    participant X as execute-task
    participant H as hit-restore
    participant C as Cache (local)
    participant T as cache/archive

    X->>C: get(hash)
    C->>C: SELECT entries row<br/>(hash noted in touched, accessed_at bumped at flush)
    C-->>X: CacheEntry {outputFiles, source: 'local'}
    X->>H: restoreHit
    H->>H: output set unchanged? directory-mtime<br/>short-circuit, else walk the output globs
    H->>C: isOutputsCurrent? stat each output_files row<br/>(size + mode + millisecond mtime,<br/>inode + ctime stamp)
    alt every output already current
        Note over H: skip extraction entirely —<br/>the warm-warm path costs N stats, zero writes
    else any output stale/missing
        H->>H: wipe declared outputs (cleanOutputs)
        H->>C: restoreOutputs(hash, projectDir, workspaceRoot)
        C->>T: extractArtifactStream(tar stream → outputs/*)
        Note over T: path-traversal + symlink-clobber guards<br/>modes and millisecond mtimes applied from the<br/>.vx-meta.json sidecar (tar headers carry whole<br/>seconds) so the next run's stat-check passes
        H->>C: recordOutputStamps (inode + ctime)
    end
    H->>H: replay cached stdout through logger
    H-->>X: status 'cache-hit', exit 0
```

## 3. Remote hit — download → ingest → restore

Owner: `cache/layered-cache.ts`. Requires a remote layer — a plugin's
`cache` capability or an injected `RunOptions.remoteCache` client
implementing `RemoteCacheLayer`.

```mermaid
sequenceDiagram
    participant X as execute-task
    participant L as LayeredCache
    participant LC as Cache (local)
    participant RC as RemoteCacheLayer (plugin wire client)

    X->>L: get(hash, {taskId, command})
    L->>LC: get(hash)
    LC-->>L: null (local miss)
    L->>RC: get(hash) — e.g. REAPI GetActionResult + CAS read
    RC-->>L: tar.zst bytes + durationMs
    L->>LC: ingest(hash, body, {taskId, command, durationMs})
    Note over LC: same writeArtifactAndIndex path save() uses —<br/>bytes validated, then atomic rename + SQLite row.<br/>The local and remote layers carry identical bytes.
    L-->>X: CacheEntry {source: 'remote'}
    X->>X: restore as in flow 2 — status 'cache-hit-remote'
```

On any remote error (timeout, non-404 failure, corrupt body) the
layered cache reports through `onRemoteError` and the task degrades
to a miss — remote problems never fail a run.

The write side is the mirror image: `LayeredCache.save` writes the
local artifact synchronously, then uploads the same bytes verbatim
(`RemoteCacheLayer.put`) as a **fire-and-forget background task**
— the task's outcome never waits on upload latency; `run()` drains
all in-flight uploads before closing the cache. Errors route to
`onRemoteError`.

In practice most remote hits never reach the lazy path above: the
**prefetch** pass (flow 3b) has already ingested them by the time
`execute-task` probes.

## 3b. Run pipeline — classify, prefetch, two-tier schedule

Owners: `orchestrator/run.ts` (wiring),
`orchestrator/stable-keys.ts` (the shared stability gate),
`orchestrator/remote-prefetch.ts`,
`orchestrator/local-shortcircuit.ts`, `graph/scheduler.ts`.

```mermaid
flowchart TD
    A[prepareRun done<br/>graph + cache ready] --> B{remote layer<br/>configured?}
    B -->|yes| P[startRemotePrefetch<br/>derive STABLE keys upfront]
    P --> P2[background pool: remote GETs<br/>overlap execution, ≤1 per key,<br/>hits ingest into local]
    B -->|no, local reads on,<br/>≥1 task| L[startLocalShortCircuit<br/>derive STABLE keys upfront]
    L --> L2[probe local: one batched cache.getMany,<br/>per-task cache.get as fallback<br/>→ preProbed map hits + misses]
    L2 --> L3[confirmed hits → restoreTier set]
    P2 --> S
    L3 --> S[runGraph — two ready queues]
    B -->|neither| S
    S --> Q1[execReady: dep-gated,<br/>misses + unstable tasks,<br/>NORMAL priority]
    S --> Q2[restoreReady: ready IMMEDIATELY,<br/>LOW priority backfill only]
    Q1 --> W[worker slots<br/>drain execReady FIRST]
    Q2 --> W
    W --> X[executeTask reuses preProbed —<br/>no second cache.get]
```

The stability gate is shared: a task whose inputs an upstream may write,
or whose outputs meet another same-project task's (M-5), has a
preliminary key and is never probed early. The upstreams counted
are transitive (a producer reached through a no-output intermediate
still counts): tasks declaring outputs, uncached tasks that may write
into their project or elsewhere in the workspace
(`undeclaredWriteReach`), cached tasks that may rewrite their own
inputs in place when this key does not fold theirs, and tasks that may
write a file the workspace fingerprint folds. Such a task stays
dep-gated with the always-correct lazy read-through. Restore-tier
tasks also bypass the failed-dep→skip check (their key is
dep-success-independent). Any error in classification degrades to the
plain schedule.

## 4. Failure propagation through the graph

Owner: `graph/scheduler.ts`. The scheduler distinguishes _transitive
dependents_ (skipped) from _independent siblings_ (keep running) —
Turbo's middle `--continue` setting.

```mermaid
flowchart TD
    A[lib#build ✓] --> B[app#build ✗ exit 1]
    A --> C[docs#build ✓ keeps running]
    B --> D[app#test → skipped]
    D --> E[app#e2e → skipped]
    C --> F[docs#publish ✓ keeps running]

    style B fill:#7f1d1d,color:#fff
    style D fill:#525252,color:#fff
    style E fill:#525252,color:#fff
```

Skipped outcomes carry exit code 1 and `durationMs: 0`; nothing is
spawned for them. The run's `ok` is false; the summary lists the
failed task IDs, then the skipped ones grouped under the failure that
blocked them.

## 5. `vx watch` — debounce + reentrancy

Owners: `cli/watch.ts`, `cli/watch-set.ts` (what is watched),
`cli/watch-filter.ts` (the path filter), `cli/watch-judge.ts` (which
settled paths are changes), `cli/watch-fs.ts` (watchers,
and the stat poller where they fail). One recursive `fs.watch` per project dir plus a
non-recursive watch of the workspace root, which fires for the
workspace fingerprint files (lockfiles), `vx.workspace.*`, the root
`package.json` and root files a plugin claims. When any task declares
`cache.inputs.workspaceFiles`, one recursive root watcher replaces them
all. Path filter drops the segments `node_modules`, `.git` and `.vx`,
the suffixes `.tsbuildinfo` and a trailing `~`, the run's resolved
cache dir (which `.vx` covers only until `cacheDir` relocates it), the
watch probe file, and declared outputs plus the directories holding
them (unless a task reads the path as an input). Git-ignored paths
(one `git check-ignore` per judgement) start no cycle, except an edit
under a project with an uncached task.

```mermaid
stateDiagram-v2
    [*] --> InitialRun
    InitialRun --> Idle: run() completes
    Idle --> Debouncing: fs event (filtered)
    Debouncing --> Debouncing: more events<br/>(150 ms timer resets)
    Debouncing --> Running: timer fires, a path changed → run()
    Debouncing --> Idle: timer fires, nothing changed
    Running --> Running: fs event → added to changes.pending
    Running --> Idle: done, changes.pending empty
    Running --> Running: done, changes.pending non-empty<br/>(one debounce window, then one more cycle)
    Idle --> [*]: SIGINT / SIGTERM / SIGHUP (watchers closed)
```

The `running` flag is the reentrancy guard: events landing mid-cycle
wait in `changes.pending`, are judged together one debounce window after
the cycle ends, and collapse into at most one follow-up run, never a
queue.

## 6. Persistent task lifecycle

Owner: `exec/runner.ts:runPersistent` + the orchestrator's
`persistentRegistry`. Persistent tasks (`exec.persistent`) gate
downstream work on readiness, then live until the rest of the graph
finishes. Then, in the CLI foreground (or held by `vx watch`), a
requested or surfaced persistent task is kept alive past the summary
(`orchestrator/persistent.ts`); the rest get SIGTERM, then SIGKILL of
the process group after a 2 s grace. `cache + persistent` is rejected
at load time.

```mermaid
stateDiagram-v2
    [*] --> Spawned: Bun.spawn
    Spawned --> Ready: no readyWhen (immediate)
    Spawned --> Watching: readyWhen regex set
    Watching --> Ready: stdout/stderr line matches
    Watching --> Failed: child exits before match
    Watching --> Failed: readiness timeout → SIGTERM,<br/>SIGKILL after the grace
    Ready --> Running: outcome 'success',<br/>downstream unblocks,<br/>child owned by persistentRegistry
    Running --> Kept: graph done, requested or surfaced,<br/>CLI foreground → alive past the summary
    Running --> Terminated: graph done, otherwise → SIGTERM,<br/>SIGKILL of the group after 2 s
    Failed --> [*]: outcome 'failed' (the child's exit code, else 1)
    Kept --> [*]
    Terminated --> [*]
```

## 7. Sandboxed task — violation → failure

Owner: `exec/sandbox-runtime.ts` (SRT wrapper). Activation is
per-task (`exec.sandbox`), no workspace inheritance. Baseline policy:
read and write nothing, deny-read = workspace root; core adds
`node_modules` and the workspace packages linked there (never a link to
the task's own project or above it; for a task that declares `cache`,
only the packages its key folds a task of —
`orchestrator/keyed-projects.ts`), and the task's own `allow` grants add
the rest. Reporting is scoped to the project and the withheld packages.

```mermaid
flowchart TD
    A[task has sandbox config] --> B[lazy SRT init<br/>once per run]
    B --> C[exec inside sandbox]
    C --> D{platform}
    D -->|macOS| E[seatbelt denies; the unified log<br/>records each violation]
    D -->|Linux| F[bwrap structural deny;<br/>an strace pass records each denied call]
    E --> G{violations inside the project<br/>or a withheld package?}
    F --> G
    G -->|yes| H[force exit code 1 +<br/>violation lines in the frame]
    G -->|no| I[normal outcome]
    H --> J[not cached - the gate is<br/>effectiveExitCode == 0]
```

## 8. `vx cache prune` — TTL + LRU

Owner: `cli/cache.ts` + `cache/cache.ts:prune`. Both bounds can
combine; eviction is one SQL transaction (CASCADE clears
`output_files`) after parallel artifact unlinks. The same transaction
drops phantom rows (no artifact on disk) unused for an hour, and
artifacts with no row are reaped after it.

```mermaid
flowchart TD
    A[vx cache prune] --> P[flush deferred accessed_at bumps,<br/>find phantom rows]
    P --> B{--older-than?}
    B -->|yes| C[SELECT entries WHERE<br/>accessed_at < now - ttl → victims]
    B -->|no| D
    C --> D{--max-size?}
    D -->|yes| E[walk entries by accessed_at ASC,<br/>add victims until total ≤ cap]
    D -->|no| F
    E --> F[parallel rm of victim .tar.zst files,<br/>then single-transaction DELETE<br/>of victims + stale phantom rows]
    F --> O[reap orphan artifacts]
    O --> G[report freed bytes]
```

Every `get` notes its hash, and the `accessed_at` bumps land in one
batched UPDATE at prune, stats or close, so LRU reflects real use. A
`vx run --dry` plan probes with `has`, which does not bump it — planning
is read-only. (Prune's own rehearsal flag is `--dry-run`.)

## 9. `--dry` / `--graph` — the plan path

Owner: `orchestrator/plan.ts` + `cli/plan-format.ts`. Shares
`prepareRun` with the real path, probes the cache for predicted
hits with the byte-free `has`, spawns no task, and writes nothing —
not even the `accessed_at` bump a real `get` makes. It does run
`cache.inputs.runtime` / `workspaceRuntime` probe commands: a key
needs their answers.

```mermaid
flowchart LR
    A[prepareRun<br/>discover → load → graph] --> B[per node:<br/>same key derivation<br/>as a real run]
    B --> C[local probe: cache.has<br/>remote probe: has existence check<br/>no download, no ingest, no accessed_at bump]
    C --> D{format}
    D -->|--dry| E[human table:<br/>task, hash, predicted hit/miss]
    D -->|--dry=json| F[machine JSON]
    D -->|--graph| G[Graphviz DOT]
```

Because the plan path and `execute-task` share the same key
derivation helpers, a predicted hit is exactly what the real run
would see (same process, same env, same tree). Against a remote
layer, planning uses a lightweight existence probe — a predicted
`hit-remote` moves no artifact bytes.
