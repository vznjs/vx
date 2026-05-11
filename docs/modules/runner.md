# `runner.ts` — child process invocation

## Purpose

Spawn a shell command and return a `RunResult`. Stream stdout/stderr
via callbacks while accumulating them for later capture.

## Public surface

```ts
export interface RunResult {
  exitCode: number
  durationMs: number
  stdout: string // full captured text
  stderr: string // full captured text
}

export interface RunOptions {
  command: string // single shell string
  cwd: string // absolute working dir
  env: NodeJS.ProcessEnv // exact env for child
  onStdout?: (chunk: string) => void // streamed live; not awaited
  onStderr?: (chunk: string) => void
}

export function runCommand(opts: RunOptions): Promise<RunResult>
```

## Spawning rules

- `child_process.spawn(command, { shell: true })` — the OS shell
  evaluates the command string. Linux/Mac → `/bin/sh`; Windows →
  `cmd.exe`.
- `stdio: ['ignore', 'pipe', 'pipe']` — stdin is closed (no
  interactive prompts), stdout/stderr piped to us.
- Encoding is `utf8`. Non-UTF8 binary output will be corrupted.

The promise always resolves (never rejects) with a `RunResult`:

- Normal exit → `exitCode` is the child's exit code.
- Signal-killed → `exitCode = 130` if no code was reported (otherwise
  the OS's "signal as exit code" convention).
- `spawn()` itself failing → `exitCode = 127`, `stderr` augmented with
  `[vzn] failed to spawn: <error>`. Rare; only happens if the shell
  binary is missing.

## Live streaming + capture

For each `data` event from the child's stdout/stderr stream:

1. The chunk is appended to the running `stdout` / `stderr` string.
2. If `onStdout` / `onStderr` is provided, it's called with the chunk
   synchronously.

The orchestrator uses the callbacks for live display (prefixed with
task id, step index in multi-step) while keeping the accumulated
string for cache replay.

## What this does NOT do

- Doesn't time out. A command that hangs hangs forever. Could add a
  `timeoutMs` option but it's not wired up.
- Doesn't forward signals — if `vzn` is `SIGINT`ed, the child gets
  whatever Node propagates by default. Cleaning up children on parent
  termination is currently not handled explicitly.
- Doesn't decode TTY escape sequences or strip ANSI codes. They flow
  through to the caller verbatim — useful for color-preserving
  replays.
- Doesn't sandbox. The child has all of Node's permissions (FS access
  outside the project, network, etc.). Tasks are trusted code.

## Tests

`runner.test.ts` covers:

- Successful command returns exit 0 + captured stdout.
- Failing command returns non-zero + captured stderr.
- Streaming callbacks fire.
- Command-not-found surfaces as a non-zero exit code (typically 127
  via the shell).

## Replacing this module

Possible directions:

- **Container execution** — spawn into Docker/podman/buildkit instead
  of the host. Keep the `RunResult` shape; rewrite the spawn to invoke
  the container runtime. Inputs/outputs need volume mounts.
- **Remote execution** — RPC to a build farm. Same contract; latency
  becomes a concern.
- **Sandboxed shell** — wrap the command in `bwrap` / `nsjail`. Useful
  for hostile workloads (you're not running those in a build system,
  but theoretically).
- **Per-step timeouts** — easy addition; add `timeoutMs?` to
  `RunOptions`, schedule `proc.kill()`.

In all cases, **preserve the `RunResult` shape** — the rest of the
codebase depends on `exitCode`, `durationMs`, `stdout`, `stderr` being
populated identically.
