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
  stdout: string // full captured text
  stderr: string
  cpuMs?: number // user + system, from Bun.spawn().resourceUsage()
  peakRssBytes?: number // maxRSS * 1024 (Bun normalizes KB; we → bytes)
}

export interface RunOptions {
  command: string // single shell string
  cwd: string // absolute working dir
  env: NodeJS.ProcessEnv
  forwardArgs?: readonly string[] // appended shell-quoted to `command`
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export function runCommand(opts: RunOptions): Promise<RunResult>

export interface PersistentOptions extends Omit<RunOptions, 'forwardArgs'> {
  readyWhen?: string // string regex; matched against streamed output
}

export interface PersistentSpawn {
  child: ReturnType<typeof Bun.spawn>
  ready: Promise<void> // resolves once "ready"; rejects if exit before ready
  bufferedStdout: () => string // captured stdout up to current moment
  bufferedStderr: () => string
  readyMs: () => number // ms from spawn to ready (or now)
}

export function runPersistent(opts: PersistentOptions): PersistentSpawn

export function shellQuote(arg: string): string
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
- Signal-killed → `exitCode = 130` if no exit code was reported; else
  the OS's "signal as exit code" convention.
- `Bun.spawn` itself throwing → `exitCode = 127`, stderr augmented
  with `[vx] failed to spawn: <message>`.

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

Caveat: a never-matching `readyWhen` on a child that keeps running
means `ready` never settles — the awaiting run hangs until the child
exits on its own. There is no readiness timeout yet.

Stream readers run for the child's lifetime; the caller owns the
`child` handle and is responsible for SIGTERMing it. The orchestrator
does this via its `persistentRegistry` at end-of-run.

`bufferedStdout()` / `bufferedStderr()` return everything captured so
far — useful for surfacing pre-ready output on a fail-before-ready
outcome.

## What this does NOT do

- **Doesn't time out.** A hung command hangs forever. Could add
  `timeoutMs` if the use case appears.
- **Doesn't sandbox.** The child has full process privileges. A
  bwrap sandbox was tried and reverted (Ubuntu 24 AppArmor breaks it
  in CI; design-doc/sandbox.md was removed).
- **Doesn't propagate signals to the child group.** If `vx` is
  SIGINTed, Bun's default child-process behavior applies; no
  process-group setup.
- **Doesn't strip ANSI.** Color sequences pass through verbatim,
  enabling color-preserving cache-hit replays.
- **No Windows support.** `sh -c` only.

## Tests

`tests/runner.test.ts` covers:

- Success path returns exit 0 + captured stdout + rusage fields.
- Failure returns non-zero + captured stderr.
- Streaming callbacks fire per chunk.
- Spawn failure (`/bin/sh` missing scenarios) surfaces as exit 127.
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
