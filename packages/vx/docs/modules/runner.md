# `src/exec/runner.ts` — child process invocation + rusage capture

## Purpose

Spawn a shell command, stream stdout/stderr live, capture a bounded
copy of the text, and surface CPU + peak RSS from
`Bun.spawn().resourceUsage()`. Also
hosts the `runPersistent` variant for long-running tasks that don't
exit before the rest of the graph finishes.

## Public surface

```ts
export interface RunResult {
  exitCode: number
  durationMs: number
  stdout: string // retained text, or '' when `capture.stdout` is false
  stderr: string // retained text, or '' when `capture.stderr` is false
  cpuMs?: number // user + system, from Bun.spawn().resourceUsage()
  peakRssBytes?: number // maxRSS (bytes), only when it rose above vx's own RSS high-water mark
}

// Which streams are retained onto the result. Both default to true.
export interface CaptureConfig {
  stdout?: boolean
  stderr?: boolean
}

export interface RunOptions {
  command: string // single shell string
  cwd: string // absolute working dir
  env: NodeJS.ProcessEnv
  forwardArgs?: readonly string[] // appended shell-quoted to `command`
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  capture?: CaptureConfig // omitted → both retained
  liveChildren?: Set<ReturnType<typeof Bun.spawn>> // run-scoped registry; child added on spawn, removed on exit
}

export function runCommand(opts: RunOptions): Promise<RunResult>

// POSIX "terminated by signal N" → exit 128+N (SIGINT → 130, SIGTERM → 143).
export function signalExitCode(signal: NodeJS.Signals): number

// `capture` is a runCommand concept — a persistent task returns no RunResult.
export interface PersistentOptions extends Omit<RunOptions, 'forwardArgs' | 'capture'> {
  readyWhen?: string // string regex; matched against streamed output
}

export interface PersistentSpawn {
  child: ReturnType<typeof Bun.spawn>
  ready: Promise<void> // resolves once "ready"; rejects if exit before ready
  readyMs: () => number // ms from spawn to ready (or now)
}

export function runPersistent(opts: PersistentOptions): PersistentSpawn

export function shellQuote(arg: string): string
export function signalExitCode(signal: string): number // 128 + signo; 130 fallback
export class PersistentReadyError extends Error // reason: 'timeout' | 'exited' | 'spawn'; exitCode?: the child's own
export function streamToString(
  stream: ReadableStream<Uint8Array> | number | undefined,
  onChunk?: (s: string) => void,
): Promise<string>
export function resourceUsageToCpuRss(
  usage: ReturnType<ReturnType<typeof Bun.spawn>['resourceUsage']>,
): { cpuMs?: number; peakRssBytes?: number }

// The inverse of signalExitCode: 137 → 'SIGKILL', and undefined below
// 129 or above the signal range. What `failedLabel` reads to write
// `failed (exit 137, 128 + SIGKILL)`.
export function exitSignal(code: number): string | undefined

// The bare word a shell would have run, when the command is a plain
// `word args…` — what shell-verdict.ts names in a 127 frame line.
export function execWord(command: string): string | undefined
```

## Spawning rules

- **Shell:** `Bun.spawn([executablePath('sh'), '-c', command], { argv0: 'sh', ... })`.
  POSIX-shell only; Windows is unsupported (no `cmd.exe` branch). The
  shell is resolved ONCE per process on vx's own PATH
  (`util/which.ts`), never the task's: the task's PATH leads with its
  project's `node_modules/.bin`, and Bun resolving the bare `sh`
  against it let a dependency's `sh` bin parse every command in the
  project (`tests/task-shell.test.ts`). It also walked that PATH with a
  stat per entry on every spawn. The task's PATH still decides what
  the command resolves, inside the shell; `argv0` keeps `$0` the `sh`
  it always was.
- **stdio:** `stdin: 'ignore'` (no interactive prompts; a task reading
  stdin sees EOF, never a hang); `stdout: 'pipe'`, `stderr: 'pipe'`.
  `runPersistent` alone spawns with `stdin: 'pipe'` and never writes
  it: a dev server that exits on stdin EOF (esbuild `--watch`) stays up
  while vx lives, and sees EOF when vx exits (execution.md § Output
  capture and rendering).
- **forwardArgs** are appended to `command` after a single space, each
  quoted via `shellQuote(arg)` (i.e. `'...'`-quoted when not safe).
- **Encoding:** UTF-8 via `TextDecoder({ stream: true })`. Non-UTF8
  bytes are corrupted.

The promise from `runCommand` always resolves (never rejects) with a
`RunResult`:

- Normal exit → `exitCode` is the child's exit code.
- Signal-killed → `exitCode = signalExitCode(signalCode)` — the POSIX
  128 + signo convention (SIGTERM → 143, SIGKILL → 137), falling back
  to 130 for signal names missing from `os.constants.signals`. The
  sandboxed runner (`sandbox-runtime.ts`) uses the same helper.
- Timed out (`exec.timeout`) → `armTimeout` SIGTERMs the task's group
  and SIGKILLs it after the kill grace. Once the leader has exited,
  `settle()` waits the rest of that grace for the GROUP and SIGKILLs
  whoever is left: the escalation used to be cleared with the shell's
  exit, so a backgrounded process that ignored SIGTERM ran on under init
  after vx exited (2026-09-24, `tests/task-tree-kill.test.ts` › "a
  timeout reaps a grandchild that ignores SIGTERM"). Both runners
  settle before the drain.
- `Bun.spawn` itself throwing → `exitCode = 127`, and the reason goes
  through `onStderr` (the task's frame) as well as onto `stderr`: a
  missing `sh` says `vx runs each task with sh -c: failed to spawn 'sh'
(working dir: <cwd>). Install a POSIX sh and re-run.`, anything else
  `[vx] failed to spawn task: <message>`. The orchestrator retains no
  stderr, so a reason that only sat on the result reached nobody: a box
  without `sh` showed "failed (exit 127)" under a bare `$ <command>`
  (2026-09-16).

### After the shell exits

`runCommand` gates on the child's exit, not on EOF: a process the task
backgrounded holds the pipes open, and a reader that waited for EOF
hung the run. `drainOrAbort` gives the readers `POST_EXIT_DRAIN_MS`
(250 ms) to reach EOF, then aborts them and resolves true; the caller
then sends `POST_EXIT_CUT_LINE` through `onStderr` and appends it to the
result's `stderr`, so a cut is never silent (nx#35302 reproduced on vx,
2026-09-24). A timeout aborts the readers at once, with its own line.
The sandboxed runner does the same; on Linux bwrap's PID namespace
kills the leftover with the shell, so there the bound is unreachable.

### Stream capture

Both streams are RETAINED onto the result by default — that is the
primitive's contract, and a field that silently lies is worse than one
that costs. A caller that will not read a stream opts down with
`capture`. Opting down drops the retained copy ONLY: the stream is
still fully drained (so the child never blocks on a full pipe) and
every chunk still reaches `onStdout` / `onStderr`.

The orchestrator opts down hard, because retaining a stream costs its
full byte size in heap for the task's whole life:

- `stderr` is **never** retained. Nothing reads `RunResult.stderr` — a
  failing task's stderr reaches the user through the live callback, and
  the cache has never stored stderr (v17 artifact format).
- `stdout` is retained only when the task **will write a cache entry**,
  since `cache.save`'s `entry.stdout` is its one consumer.
- What is retained is **bounded**: the first `CAPTURE_HEAD_CHARS` and
  the last `CAPTURE_TAIL_CHARS` (8 MiB each), with the dropped middle
  counted and named where it was (`droppedOutputLine`). The live
  stream is whole — every byte reaches the terminal as the task writes
  it — so the bound is on what the cache entry stores and a hit
  replays. Unbounded, a task printing 200 MB cost vx 620 MB of RSS on
  the miss and on every hit, and its stdout sat whole in `cache.db`
  (2026-09-16). `tests/capture-cap.test.ts` pins the head, the tail,
  the line, the live stream, and the replay.

Measured through the real CLI on a task writing 150 MB with
`--output-logs none`: peak RSS 294 → 81 MiB, and flat in task volume
(40 MB → 150 MB moved it 78 → 81, where it used to move 127 → 274).
In the view modes that PRINT output the logger keeps its own copy, so
the peak there is unchanged — that term is deliberately unbounded.

## Resource usage

`resourceUsageToCpuRss(proc.resourceUsage(), ownRssHighWater())` converts
Bun's shape into our schema:

- `cpuTime.total` is a microseconds bigint → `cpuMs = Number(...) / 1000`.
- `maxRSS` is bytes on every platform (Bun normalizes the kernel's
  `ru_maxrss`; typed and measured) → `peakRssBytes = maxRSS`. It was
  multiplied by 1024 on Linux until 2026-09-12, which made every Linux
  peak 1024× too big; `tests/runner.test.ts` now reads a known
  allocation back within a bounded factor, so a unit slip cannot pass a
  pure-function pin again.
- A peak at or under this process's own RSS high-water mark is not
  reported. Linux folds the forking parent's mark into a child's
  `ru_maxrss` at exec (a forked child starts with its parent's pages and
  `exec_mmap` keeps the old mm's peak), so a task lighter than vx reads
  vx's footprint: `true` read 44 MB through vx while its shell's `VmHWM`
  was 1.9 MB, and 300 MB allocated in the parent made `true` read
  328 MB (2026-09-12). `ownRssHighWater()` reads `VmHWM` from
  `/proc/self/status` after the child exits (the mark is monotonic, so
  it covers the task's span; elsewhere the current RSS is the bound in
  hand), and `peakRssBytes` is set only more than `RSS_FLOOR_SLACK_BYTES`
  (4 MiB) above it — unknown, bounded by vx's own footprint, otherwise. The
  slack is there because a light child reads ON the floor by construction
  and the kernel's per-thread RSS counters lag by pages between syncs: an
  exact comparison reported 376 MB for `true` on one CI run in twelve
  (2026-09-16). `cpuMs` is the child's own either way.

Returns `{}` (no fields) when `resourceUsage()` is unavailable; the
orchestrator persists NULLs in the `runs` table for that task.

## `runPersistent` — long-running tasks

Spawns the child but returns _immediately_ with a `PersistentSpawn`
descriptor. The `ready` promise:

- Resolves on the first stdout/stderr output that matches the
  compiled `readyWhen` regex.
- Resolves immediately on successful spawn when `readyWhen` is
  undefined.
- Rejects if the child exits before either condition is met (with a
  message identifying the exit code and noting whether `readyWhen`
  ever matched).

The pattern matcher buffers across chunk boundaries and tests the
whole pending fragment — complete lines plus the trailing partial
line — so neither a match split across two reads nor a prompt-style
marker without a trailing newline is missed. Complete lines that
didn't match are discarded after each test to bound memory.

A never-matching `readyWhen` on a child that keeps running would hang
the run forever — bound the wait with `exec.timeout` (passed to
`runPersistent` as `timeoutMs`): when set, a timer SIGTERMs the child
and rejects `ready` with a clear timeout message once the window
passes. A healthy server is never killed late: the timer is cleared
the moment ready fires, and its body re-checks readiness before it
signals — two guards that mask each other, held together by one row
(item 636). No default — opting into a readiness signal is explicit,
and so is bounding it.
The SIGTERM escalates to SIGKILL after the kill grace, as the run
timeout's does: a never-ready server is not in the persistent
registry, so nothing else would kill one that traps TERM.

Stream readers run for the child's lifetime; the caller owns the
`child` handle and is responsible for SIGTERMing it. The orchestrator
does this via its `persistentRegistry` at end-of-run.

A persistent task's output reaches the caller ONLY through the live
`onStdout` / `onStderr` callbacks — the spawn retains nothing. The
logger keeps the one bounded tail (registered at `taskStart`, so it
covers the pre-ready window too), which is what surfaces pre-ready
output on a fail-before-ready outcome.

## What this does NOT do

- **Doesn't time out unless asked.** One-shot commands run unbounded
  by default; pass `timeoutMs` (from `exec.timeout`) to SIGTERM the
  child after a deadline. A timed-out result is flagged `timedOut` so
  the orchestrator classifies it `failed` (not an `aborted` shutdown).
- **Doesn't sandbox.** The child has full process privileges. A
  bwrap sandbox was tried and reverted (Ubuntu 24 AppArmor breaks it
  in CI; design-doc/sandbox.md was removed).
- **Doesn't install signal handlers.** Signal shutdown is the
  orchestrator's job: it owns the `liveChildren` set this module
  populates, forwards SIGINT/SIGTERM to everything in it, and exits
  `signalExitCode(signal)`. The runner only maintains the registry.
  Every child is spawned `detached` — its own session and process
  group — and every kill goes through `killTree` (`kill-tree.ts`),
  which signals the group, so what a task forked dies with it (item
  236). A daemon that calls `setsid` itself still escapes — the
  residual every non-cgroup runner shares; a sandbox's pid namespace
  takes even that.
- **Doesn't strip ANSI.** Color sequences pass through verbatim,
  enabling color-preserving cache-hit replays.
- **No Windows support.** `sh -c` only.

## Tests

`tests/runner.test.ts` covers:

- Success path returns exit 0 + captured stdout + rusage fields.
- Failure returns non-zero + captured stderr.
- Streaming callbacks fire per chunk.
- Spawn failure (`/bin/sh` missing scenarios) surfaces as exit 127.
- Signal-killed children map to 128 + signo (`SIGKILL` → 137,
  `SIGTERM` → 143) plus `signalExitCode` unit coverage.
- `shellQuote` covers the safe-char and unsafe-char paths.
- `runPersistent`: marker without trailing newline, marker split
  across chunks, newline-terminated marker, reject-on-exit-before-
  ready. Ready-on-spawn + orchestrator wiring are covered by the
  persistent e2e suite (`tests/persistent.test.ts`).

## Replacing this module

- **Container execution** — replace the `Bun.spawn` call with a
  Docker / podman / containerd invocation. Keep the `RunResult` shape.
  Inputs / outputs need volume mounts.
- **Remote execution** — RPC to a build farm. Same contract; latency
  becomes the dominant cost.
- **Per-step timeouts** — easy addition: add `timeoutMs?` to
  `RunOptions`; schedule `child.kill()` then race against `exited`.
- **Different shell** — replace `['sh', '-c', cmd]` with `['bash', '-c',
cmd]` or a parsed argv. Cache keys would shift if the shell
  semantics differ (you'd want to fold the choice into the key).

Preserve the `RunResult` shape — the rest of the codebase depends on
`exitCode`, `durationMs`, `stdout`, `stderr`, `cpuMs`, `peakRssBytes`
being populated consistently.
