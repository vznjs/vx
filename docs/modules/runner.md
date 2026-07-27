# `src/exec/runner.ts` — child process invocation + rusage capture

## Purpose

Spawn a shell command, stream stdout/stderr live, capture full text,
and surface CPU + peak RSS from `Bun.spawn().resourceUsage()`. Also
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
  peakRssBytes?: number // maxRSS * 1024 (Bun normalizes KB; we → bytes)
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
export function streamToString(
  stream: ReadableStream<Uint8Array> | number | undefined,
  onChunk?: (s: string) => void,
): Promise<string>
export function resourceUsageToCpuRss(
  usage: ReturnType<ReturnType<typeof Bun.spawn>['resourceUsage']>,
): { cpuMs?: number; peakRssBytes?: number }
```

## Spawning rules

- **Shell:** `Bun.spawn(['sh', '-c', command], ...)`. POSIX-shell only;
  Windows is unsupported (no `cmd.exe` branch).
- **stdio:** `stdin: 'ignore'` (no interactive prompts);
  `stdout: 'pipe'`, `stderr: 'pipe'`.
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
- `Bun.spawn` itself throwing → `exitCode = 127`, stderr augmented
  with `[vx] failed to spawn: <message>`.

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

Measured through the real CLI on a task writing 150 MB with
`--output-logs none`: peak RSS 294 → 81 MiB, and flat in task volume
(40 MB → 150 MB moved it 78 → 81, where it used to move 127 → 274).
In the view modes that PRINT output the logger keeps its own copy, so
the peak there is unchanged — that term is deliberately unbounded.

## Resource usage

`resourceUsageToCpuRss(proc.resourceUsage())` converts Bun's shape
into our schema:

- `cpuTime.total` is a microseconds bigint → `cpuMs = Number(...) / 1000`.
- `maxRSS` is kilobytes on Linux/macOS → `peakRssBytes = maxRSS * 1024`.

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
passes. The timer is cleared the moment ready fires, so a healthy
server is never killed late. No default — opting into a readiness
signal is explicit, and so is bounding it.

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
  populates, SIGTERMs everything in it on SIGINT/SIGTERM, and exits
  `signalExitCode(signal)`. The runner only maintains the registry.
  No process-group setup — only direct children are signalled, so a
  task that double-forks can still leave grandchildren behind.
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
