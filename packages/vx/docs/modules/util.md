# `src/util/` — shared helpers

## `src/exec/runner.ts` — child process invocation + rusage capture

### Purpose

Spawn a shell command, stream stdout/stderr live, capture a bounded
copy of the text, and surface CPU + peak RSS from
`Bun.spawn().resourceUsage()`. Also
hosts the `runPersistent` variant for long-running tasks that don't
exit before the rest of the graph finishes.

### Public surface

```ts
export interface RunResult {
  exitCode: number
  durationMs: number
  stdout: string // retained text, or '' when `capture.stdout` is false
  stderr: string // retained text, or '' when `capture.stderr` is false
  signal?: string | number // the signal that killed the child (Bun's signalCode: its name, or its number when it has none)
  timedOut?: boolean // vx's own `timeoutMs` timer fired: a real `failed`, not an `aborted` shutdown
  killedAfterGrace?: true // the timeout's SIGKILL past the grace took the child or a process it left
  cpuMs?: number // user + system, from Bun.spawn().resourceUsage()
  peakRssBytes?: number // maxRSS (bytes) when it rose above vx's own RSS high-water mark; on Linux else the tree's peak `watchTree` saw, if a look landed
  spawnFailed?: true // Bun.spawn threw: the 127 is vx's, no shell ran
  leftRunning?: true // a leftover held a pipe past the drain bound or stayed in the group: not saved
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
  timeoutMs?: number // SIGTERM the child when it elapses; result flagged `timedOut`
  liveChildren?: Set<ReturnType<typeof Bun.spawn>> // run-scoped registry; child added on spawn, removed on exit
  signal?: AbortSignal // the run's stop; a child that joins liveChildren after it is stopped here
  onSpawn?: (pid: number) => void // told the child's pid once spawned (telemetry samples its tree)
  terminal?: boolean // inherit vx's stdin, stdout and stderr (exec.interactive on a TTY)
}

export function runCommand(opts: RunOptions): Promise<RunResult>

// `capture` is a runCommand concept — a persistent task returns no RunResult.
export interface PersistentOptions extends Omit<RunOptions, 'forwardArgs' | 'capture'> {
  readyWhen?: string // string regex; matched against streamed output
  timeoutMs?: number // bounds the readiness wait
  onReady?: () => void // at ready: after the text up to the ready line's end, before the rest
  signalChannel?: boolean // fd 3 carries SIGINT/SIGTERM (a Linux sandboxed command, item 752)
}

export interface PersistentSpawn {
  child: ReturnType<typeof Bun.spawn> | undefined // undefined when the spawn itself failed (`ready` rejects)
  ready: Promise<void> // resolves once "ready"; rejects if exit before ready, or on a readiness timeout once the group is gone (one SIGTERM, grace, SIGKILL)
  readyMs: () => number // ms from spawn to ready, to the readiness timeout giving up, or to now
  gaveUp: () => boolean // the readiness timeout gave up: no readiness wait to report
}

export function runPersistent(opts: PersistentOptions): PersistentSpawn
// Put back the terminal modes of every task still holding it (a second signal exits without waiting for them).
export function restoreTerminalModes(): void

export function shellQuote(arg: string): string
export function withForwardArgs(command: string, args: readonly string[] | undefined): string
// POSIX "terminated by signal N" → exit 128+N (SIGINT → 130, SIGTERM → 143).
export function signalExitCode(signal: string | number): number // 128 + signo (Bun gives a bare number for an unnamed signal); 130 fallback for an unknown name
// The signal a run's stop sends a task, from its abort reason (SIGINT,
// else SIGTERM — a hang-up forwards SIGTERM, as `forwardedSignal`): a
// task stopped before its spawn exits as if it had killed it.
export function stopSignal(reason: unknown): 'SIGINT' | 'SIGTERM'
export class PersistentReadyError extends Error // reason: 'timeout' | 'exited' | 'spawn'; exitCode?: the child's own
export function streamToString(
  stream: ReadableStream<Uint8Array> | number | undefined,
  onChunk?: (s: string) => void,
  signal?: AbortSignal,
  retain?: boolean, // default true; false drains the stream and feeds onChunk, keeps no copy
): Promise<string>
export function resourceUsageToCpuRss(
  usage: ReturnType<ReturnType<typeof Bun.spawn>['resourceUsage']>,
  floorBytes?: number | ((peak: number) => number), // ownRssHighWater(), or a function of the peak: a peak at or under it is inherited, not reported
): { cpuMs?: number; peakRssBytes?: number }

// The inverse of signalExitCode: 137 → 'SIGKILL', and undefined below
// 129 or above the signal range. What `failedLabel` reads to write
// `failed (exit 137, 128 + SIGKILL)`.
export function exitSignal(code: number): string | undefined

// The bare word a shell would have run, when the command is a plain
// `word args…` — what shell-verdict.ts names in a 127 frame line. Read
// as the shell reads it: quotes group and are removed (`"./my tool.sh"`).
export function execWord(command: string): string | undefined
export function execWrap(command: string): string // `exec <command>` when execWord finds a word

export function armTimeout(proc, timeoutMs): { timedOut(): boolean; sigkilled(): boolean; settle(): Promise<void> }
export const POST_EXIT_CUT_LINE: string
// The two output callbacks merged a line at a time: a chunk on one stream
// waits while the other's line is open, at most OPEN_LINE_WAIT_MS (50) and
// OPEN_LINE_HOLD_CHARS (64 KiB), then goes as written (no newline added); `end()`
// lets it go at the exit. `own(text)` breaks the line before vx's note only
// when the output ends mid-line.
export const OPEN_LINE_WAIT_MS = 50
export const OPEN_LINE_HOLD_CHARS: number
export function lineEnds(onStdout?, onStderr?): { onStdout?; onStderr?; own(text: string): string; end(): void }
export function drainOrAbort(streams: Promise<unknown>, ac: AbortController): Promise<boolean>
export function spawnFailureText(err: unknown, cwd: string, what?: string, command?: string, env?: NodeJS.ProcessEnv): string // E2BIG with `command`: its size and the 128 KiB limit, or the environment's size and largest entry when that is the cause
export function sandboxArgTooLongText(bytes: number): string // the E2BIG line for a sandboxed task's wrap
export const SANDBOXED_TASK = 'sandboxed task' // `what` for runSandboxed, whose `command` is the wrap: the hint says the wrap counts
export const CAPTURE_HEAD_CHARS = 8 * 1024 * 1024
export const CAPTURE_TAIL_CHARS = 8 * 1024 * 1024
export function droppedOutputLine(dropped: number, headChars?: number, tailChars?: number): string
export function maskCaptured(text: string, secrets: SecretMask): string // the pieces a cut left masked too
export function isDroppedOutputChunk(chunk: CapturedChunk): boolean // the dropped line object a capture's chunks() returned; a task's look-alike text is not
export interface CapturedChunk {
  text: string
  err: boolean // stderr
}
// The head-and-tail bound over chunks of either stream, in arrival order.
export class BoundedCapture {
  constructor(headChars?: number, tailChars?: number) // default CAPTURE_HEAD_CHARS / CAPTURE_TAIL_CHARS
  push(text: string, err?: boolean): void
  rebound(headChars: number, tailChars: number, through?: (c: CapturedChunk[]) => CapturedChunk[]): BoundedCapture // tighter bounds; counts what this one already dropped; through maps the kept text first, each side apart only past a drop
  chunks(): CapturedChunk[] // the dropped middle named on stdout
  text(): string
}
export function ownRssHighWater(): number
export const RSS_FLOOR_SLACK_BYTES = 4 * 1024 * 1024
export function peakRssBytes(maxRSS: number): number // bytes, whatever unit the runtime reported

// A task's stdout and stderr: real pipes on Linux, Bun's 'pipe' elsewhere
// or for a terminal task. `sandbox/runtime.ts` spawns through it too.
export class TaskPipes {
  constructor(terminal?: boolean)
  readonly stdio: readonly [number | 'pipe', number | 'pipe'] // descriptors 1 and 2 for Bun.spawn
  spawned(): void // close vx's write ends once the spawn returned or threw
  streams(child): [stdout, stderr] // what streamToString reads
  close(): void // close the read ends once both streams ended or were cancelled
  closeStdin(): void // a persistent task's held stdin: once the child exited AND its output ended
}

// src/util/raw-utf8.ts: task output as text, each byte that is not UTF-8
// kept as a lone surrogate U+DC80+byte, and written back as that byte.
export function decodeRaw(bytes: Uint8Array): string
export class RawUtf8Decoder {
  decode(chunk?: Uint8Array, opts?: { stream?: boolean }): string // stream: an incomplete tail sequence is held for the next chunk
}
export function rawBytes(text: string): string | Uint8Array // itself when well-formed, else its bytes
export function rawEncode(text: string): Uint8Array
```

Cost of `lineEnds` (2026-10-29, runCommand A/B, interleaved, min of 11,
before arm a worktree of main 296536e17): a 9 MB flood on both streams
with partial lines 337 ms wall against 371 before, CPU 416 against 363
(medians 455 and 432); 100 MB on stdout
alone 653 against 710; 20 000 short lines interleaved by a shell 121
against 126. Alone, about 10 ns more per chunk, and 70 ns per line one
stream holds behind the other's open line.

The hold never delays what a user waits on past the bound: a prompt with
no newline on the stream whose line is open goes at once (it is that
line); one on the other stream goes within `OPEN_LINE_WAIT_MS`, its timer
held to its start; at the exit, `end` lets everything go; and an
`exec.interactive` task on a TTY has no pipes, so nothing passes here.

### Spawning rules

- **Shell:** `Bun.spawn([executablePath('sh'), '-c', command], { argv0: 'sh', ... })`.
  POSIX-shell only; native Windows is unsupported (no `cmd.exe` branch),
  and Windows runs the Linux build under WSL. The
  shell is resolved ONCE per process on vx's own PATH
  (`util/which.ts`), never the task's: the task's PATH leads with its
  project's `node_modules/.bin`, and Bun resolving the bare `sh`
  against it let a dependency's `sh` bin parse every command in the
  project (`tests/task-shell.test.ts`). It also walked that PATH with a
  stat per entry on every spawn. The task's PATH still decides what
  the command resolves, inside the shell; `argv0` keeps `$0` the `sh`
  it always was.
- **Thread:** on Linux, a `runCommand` child is spawned on a thread of
  its own (`spawn-off.ts`). Bun's spawn holds its thread until the child
  has exec'd, ~0.6 ms a task, and on a cold run that thread is the
  scheduler's. The pipes are vx's own descriptors (`TaskPipes`), which
  every thread shares, so they are made and read on the scheduler's
  thread as before; only the spawn and the wait for its exit move. A
  terminal handed over and Bun's own pipes (macOS) keep the spawn here,
  as do `runPersistent` and the sandbox's spawn.
- **Spare shell:** on Linux, a task's shell is started before the task
  is asked for (`warm-shell.ts`), so the slot that frees does not wait
  for sh to exec: 200 `sleep 0.02` took 4.4 ms each past their sleep
  spawned fresh, 2.7 ms on a spare. Two spares wait at most, each on
  its own pipes, with no directory or env of a task, blocked reading
  descriptor 3. The task's script, written when one is taken, closes
  that descriptor, `cd -P`s to the task's directory (127 when it is gone,
  reported as a spawn that threw), drops the `OLDPWD` that `cd` set,
  exports the task's env and runs the command through `eval`, so its
  lines number from 1 as under `sh -c` (a "not found" reads
  `sh: 1: eval: x: not found`: only an exec drops the builtin's name).
  The task still has a shell of its own, so its CPU and memory read as
  before, and a spare holds no run open. An env name sh cannot export or
  sets itself at start (`IFS`, `OPTIND`, `PPID`, `PWD`, and bash's
  `SHLVL`, `SHELLOPTS`, `BASHOPTS`, `UID`, `EUID`), a script over
  60 KiB, or a terminal spawns fresh.
- **`exec`:** a plain `word args…` command runs as `exec word args…`, so
  the program replaces the shell. A shell builtin keeps the shell (each
  one bash's `compgen -b` lists, bash-only `pushd` among them), and so
  does a bash reserved word that may open one line (`[[`, `time`):
  macOS's `sh` is bash, and `exec [[ -f x ]]` there was
  `exec: [[: not found`, exit 127 (B-56).
- **stdio:** `stdin: 'ignore'` (no interactive prompts; a task reading
  stdin sees EOF, never a hang); stdout and stderr are pipes
  (`TaskPipes`). Bun's `'pipe'` is a socketpair, and Linux opens
  `/dev/stdout` through `/proc/self/fd/1`, which a socket refuses
  (ENXIO): `echo x > /dev/stdout` and `cmd | tee /dev/stderr` failed
  in every task (X-113). On Linux vx makes two `pipe2` pairs through
  `bun:ffi` (libc bound at the first spawn, not at load), hands the
  child the write ends and reads its own ends with
  `Bun.file(fd).stream()`; vx's ends are non-blocking and 256 KiB
  (`F_SETPIPE_SZ`; at the default 64 KiB a 200 MB stdout drained 13%
  slower than through the socketpair). A read end is closed only after
  its stream ends: Bun dups it at the first pull, and a number closed
  before then was reused by the next spawn's pipe, whose output the
  stream then read. macOS opens `/dev/fd/N` as a dup, which a socket
  allows, so it keeps Bun's `'pipe'`, as does a libc that will not
  load or a pipe the descriptor limit refuses (Bun's socketpair then
  fails the spawn with the reason). Cost: 0.9 ms once per process,
  13 µs a spawn; `runCommand` of `/usr/bin/env` min / median 1.458 /
  2.060 ms against 1.458 / 2.056 before (1,000 interleaved runs).
  `runPersistent` alone hands its child a stdin pipe vx holds and never
  writes (on Linux a `pipe2` pipe too: `cat /dev/stdin` on the socketpair
  failed with ENXIO instead of blocking): a dev server that exits on stdin EOF (esbuild `--watch`) stays up
  while vx lives, and sees EOF when vx exits. Its write end closes once the
  child has exited and its output has ended, never on the output alone: a
  server that sent its output to a log (`exec >log 2>&1`) ended its streams
  at once, read EOF and exited (execution.md § Output
  capture and rendering). `terminal: true` (an `exec.interactive` task
  on a TTY) spawns either with `'inherit'` on all three: no stream, no
  capture, no callbacks. The terminal's modes are read with `stty -g`
  before that spawn and set back when the child exits, if it changed
  them: a task killed in raw mode left the terminal raw, and Bun
  restores them at exit only when vx's stdout is the terminal.
- **forwardArgs** are appended to `command` after a single space, each
  quoted via `shellQuote(arg)` (i.e. `'...'`-quoted when not safe; a
  `#` is safe past a word's first character), by
  `withForwardArgs` — before a `#` comment still open at the command's
  end (the earliest, when comment-only lines follow a commented
  line), so no comment can swallow them, and before a trailing
  unescaped `;` or `&`, so they do not run as a command; one scan reads quotes,
  comments and heredoc bodies together, as sh does. The sandbox wrapper and the
  persistent path build the line the same way.
- **Encoding:** UTF-8 via `RawUtf8Decoder` (`src/util/raw-utf8.ts`), a
  sequence split across reads held for the next. A byte that is not
  UTF-8 is kept as a lone surrogate U+DC80+byte, which the terminal
  writer (`ui/live-region.ts`) and the stored log (`cache/archive.ts`,
  `entry_stdout`) turn back into the byte (`rawBytes` / `rawEncode`), so
  the terminal and a hit's replay get the bytes the task wrote, not
  U+FFFD (`tests/raw-output-bytes.test.ts`); a whole buffer decodes with
  `decodeRaw`. Valid UTF-8 costs one
  native decode, as before.

The promise from `runCommand` always resolves (never rejects) with a
`RunResult`:

- Normal exit → `exitCode` is the child's exit code.
- Signal-killed → `exitCode = signalExitCode(signalCode)` — the POSIX
  128 + signo convention (SIGTERM → 143, SIGKILL → 137), falling back
  to 130 for signal names missing from `os.constants.signals`. The
  sandboxed runner (`sandbox/runtime.ts`) uses the same helper.
- Timed out (`exec.timeout`) → `armTimeout` SIGTERMs the task's group
  and SIGKILLs it after the kill grace. Once the leader has exited,
  `settle()` waits the rest of that grace for the GROUP and SIGKILLs
  whoever is left: the escalation used to be cleared with the shell's
  exit, so a backgrounded process that ignored SIGTERM ran on under init
  after vx exited (2026-09-24, `tests/task-tree-kill.test.ts` › "a
  timeout reaps a grandchild that ignores SIGTERM"). Both runners
  settle before the drain. `sigkilled()` says that SIGKILL took anyone,
  and the result's `killedAfterGrace` carries it to the timeout line.
- `Bun.spawn` itself throwing → `exitCode = 127`, and the reason goes
  through `onStderr` (the task's frame) as well as onto `stderr`: a
  missing `sh` says `[vx] vx runs each task with sh -c: failed to spawn
'sh' (working dir: <cwd>). Install a POSIX sh and re-run.`, anything else
  `[vx] failed to spawn task: <message>`, with the way out for an
  `E2BIG` (the 128 KiB argument limit, a sandbox's wrap counted, or,
  when the command is under it or smaller than the environment, the
  environment's size and its largest entry's name) or an
  `EMFILE`; `runPersistent`'s `spawn` rejection carries the same reason.
  The orchestrator retains no
  stderr, so a reason that only sat on the result reached nobody: a box
  without `sh` showed "failed (exit 127)" under a bare `$ <command>`
  (2026-09-16).

#### After the shell exits

`runCommand` gates on the child's exit, not on EOF: a process the task
backgrounded holds the pipes open, and a reader that waited for EOF
hung the run. `drainOrAbort` gives the readers `POST_EXIT_DRAIN_MS`
(250 ms) to reach EOF, then aborts them and resolves true; the caller
then sends `POST_EXIT_CUT_LINE` through `onStderr` and appends it to the
result's `stderr` (after a newline only when the output ended mid-line,
`lineEnds`), so a cut is never silent (nx#35302 reproduced on vx,
2026-09-24). A timeout aborts the readers at once, with its own line.
The sandboxed runner does the same; on Linux bwrap's PID namespace
kills the leftover with the shell, so there the bound is unreachable.
An `inputs.runtime` probe is bounded by the same constant (`util/`,
since `cache/` cannot import `exec/`), then its group is killed.

#### Stream capture

Both streams are RETAINED onto the result by default — that is the
primitive's contract, and a field that silently lies is worse than one
that costs. A caller that will not read a stream opts down with
`capture`. Opting down drops the retained copy ONLY: the stream is
still fully drained (so the child never blocks on a full pipe) and
every chunk still reaches `onStdout` / `onStderr`.

The orchestrator opts down hard, because retaining a stream costs its
full byte size in heap for the task's whole life:

- Neither stream is retained by the runner. The entry's output is kept
  by `execute-task.ts` from the live callbacks, both streams in arrival
  order in one `BoundedCapture`: entry-sized when the task **will write
  a cache entry**, else 8 KiB head and 56 KiB tail, kept only for a
  failure's `failedOutput` (what `vx last` and `runFailures` read).
- What is retained is **bounded**: the first `CAPTURE_HEAD_CHARS` and
  the last `CAPTURE_TAIL_CHARS` (8 Mi UTF-16 units each: 8 MiB of
  ASCII), with the dropped middle counted in UTF-8 bytes and named where
  it was (`droppedOutputLine`). The live
  stream is whole — every byte reaches the terminal as the task writes
  it — so the bound is on what the cache entry stores and a hit
  replays. Unbounded, a task printing 200 MB cost vx 620 MB of RSS on
  the miss and on every hit, and its stdout sat whole in `cache.db`
  (2026-09-16). `tests/capture-cap.test.ts` pins the head, the tail,
  the line, the live stream, and the replay. A secret the cut split
  left a piece on each side that the whole-value mask missed, stored
  and replayed: `maskCaptured` masks the pieces too, as `maskedOutputLog`
  does for a worker's raw capture (`taskArtifacts().save`), which knows
  the dropped line by the object, never its text: a task's chunk that
  read like it was stored unmasked. A bound never falls
  between a surrogate pair's halves (the bounds count UTF-16 units, and
  a halved emoji read U+FFFD in the replay, B-58).

Measured through the real CLI on a task writing 150 MB with
`--output-logs none`: peak RSS 294 → 81 MiB, and flat in task volume
(40 MB → 150 MB moved it 78 → 81, where it used to move 127 → 274).
In the view modes that PRINT output the logger keeps its own copy, so
the peak there is unchanged — that term is deliberately unbounded.

### Resource usage

`resourceUsageToCpuRss(proc.resourceUsage(), ownRssHighWater())` converts
Bun's shape into our schema:

- `cpuTime.total` is a microseconds bigint → `cpuMs = Number(...) / 1000`.
- `maxRSS` is bytes on Bun ≥ 1.4 (Bun normalizes the kernel's
  `ru_maxrss`); a reading under 1 MiB is taken as kilobytes (1.3.11
  passes them raw) and multiplied (`peakRssBytes`). It was
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
  (4 MiB) above it — unknown, bounded by vx's own footprint, otherwise.
  The read is skipped when the last one already decides: a peak within
  the slack of an older mark is within it of the current one. The
  slack is there because a light child reads ON the floor by construction
  and the kernel's per-thread RSS counters lag by pages between syncs: an
  exact comparison reported 376 MB for `true` on one CI run in twelve
  (2026-09-16). `cpuMs` is the child's own either way.

Returns `{}` (no fields) when `resourceUsage()` is unavailable; the
orchestrator persists NULLs in the `runs` table for that task.

### `runPersistent` — long-running tasks

Spawns the child but returns _immediately_ with a `PersistentSpawn`
descriptor. The `ready` promise:

- Resolves on the first stdout/stderr output that matches the
  compiled `readyWhen` regex.
- Resolves immediately on successful spawn when `readyWhen` is
  undefined.
- Rejects if the child exits before either condition is met (with a
  message identifying the exit code and noting whether `readyWhen`
  ever matched).

The pattern matcher buffers across chunk boundaries and tests each
line of the pending fragment on its own — complete lines without
their break (`\n` or `\r`), then the trailing partial line — with
terminal escapes (CSI, OSC, charset picks, two-byte) removed from the tested text
only; the streamed bytes keep them. So `^`/`$` anchor per line, a
colourised banner matches its plain text, and neither a match split
across two reads nor a prompt-style marker without a trailing newline
is missed. Complete lines that didn't match are discarded after each
test, and output with no break at all keeps only its last 64 KiB, to
bound memory.

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

`onReady` marks where the since-ready stream begins: the chunk that
holds the ready line is split after that line's break (a CRLF's `\n`
too; a prompt-style marker splits at the chunk's end), the first part
forwarded, `onReady` called, then the rest. Handed over whole, the
lines after the ready line in the same write read as pre-ready, the
frame a ready server's row never prints: Vite's `Network:` line after
`readyWhen: 'Local:'` was never shown. With no `readyWhen` it fires at
spawn, before any output.

### What an unsandboxed task costs (Linux, 2026-10-02)

Min / median of 400 interleaved runs of one external command
(`/usr/bin/env`), in process:

| part                                                                    | cost           |
| ----------------------------------------------------------------------- | -------------- |
| the process itself, spawned directly, both pipes read                   | 0.87 / 1.11 ms |
| the `sh -c` layer: the guard line, then `exec`                          | +0.8 ms        |
| the rest of `runCommand` (timeout arm, drain, rusage, `VmHWM` at 12 µs) | +0.1 ms        |

In a 300-task run (`vx run --concurrency 1`, `true`) the graph costs
1.7 ms a task, 1.4–1.5 of it in `runCommand`. The shell is the one
cut that would show, and it is the kill guard's: the child lists its
own group before it runs anything, and vx writing the line after the
spawn returned left a `kill -9`'s orphan in 4 of 40 runs under load
(B-9). The rest is below what an A/B resolves.

### What this does NOT do

- **Doesn't time out unless asked.** One-shot commands run unbounded
  by default; pass `timeoutMs` (from `exec.timeout`) to SIGTERM the
  child after a deadline. A timed-out result is flagged `timedOut` so
  the orchestrator classifies it `failed` (not an `aborted` shutdown),
  and its exit is never 0: a child that traps the TERM and exits 0
  reports 143, so an executor built on the runner (a DTE worker) never
  reads a timeout as a pass (sandboxed runs too).
- **Doesn't sandbox.** `runCommand` spawns with full process
  privileges; a task's `exec.sandbox` runs through
  `sandbox/runtime.ts` (`@anthropic-ai/sandbox-runtime`) instead.
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
- **No native Windows.** `sh -c` only; Windows means WSL.
- **The shell is `taskShell()`** (`util/which.ts`): `dash` on macOS when
  vx's PATH has it, else `sh` on vx's own PATH. macOS's `/bin/sh` is a stub
  that execs bash; a sandboxed macOS task asks the runtime for the same
  shell (`wrapForTask`).

### Tests

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
- `tests/spawn-off.test.ts`: on Linux `runCommand` calls no `Bun.spawn`
  on its own thread and still reads the exit, both streams and the CPU;
  a spawn that throws keeps its code; a child spawned off the thread
  reports its signal and is killed on request.
- `tests/warm-shell.test.ts`: a task on a spare spawns no shell; it sees
  the env, directory (a linked one by its physical path), descriptors,
  `$0`, line numbers and shell-set names (under dash and bash) a fresh
  shell gives; a task whose directory is gone fails as a spawn that threw.
- Pipes (X-113): `runCommand` and `runPersistent` open `/dev/stdout` and
  `/dev/stderr` by path, the first task's output ends at its exit, and
  every descriptor a task took (plain, cut, spawn-failed, persistent)
  is closed after it.

### Replacing this module

- **Container execution** — replace the `Bun.spawn` call with a
  Docker / podman / containerd invocation. Keep the `RunResult` shape.
  Inputs / outputs need volume mounts.
- **Remote execution** — RPC to a build farm. Same contract; latency
  becomes the dominant cost.
- **Different shell** — replace `['sh', '-c', cmd]` with `['bash', '-c',
cmd]` or a parsed argv. Cache keys would shift if the shell
  semantics differ (you'd want to fold the choice into the key).

Preserve the `RunResult` shape — the rest of the codebase depends on
`exitCode`, `durationMs`, `stdout`, `stderr`, `cpuMs`, `peakRssBytes`
being populated consistently.

## `src/util/dependency-spec.ts` — Turbo/Nx micro-syntax parser

### Purpose

Parse one entry from `dependsOn` or `inputs.tasks` into a small
discriminated union. Pure — no FS, no project lookups. Caller-side
modules (`graph/task-graph.ts`, `graph/folds.ts`) decide
which kinds make semantic sense in their context.

### Public surface

```ts
export type DependencySpec =
  | { kind: 'self'; task: string; negated: boolean }
  | { kind: 'deps'; task: string; negated: boolean }
  | { kind: 'cross'; project: string; task: string; negated: boolean }
  | { kind: 'wildcardSelf'; negated: boolean } // '*'
  | { kind: 'wildcardDeps'; negated: boolean } // '^*'

export class DependencySpecError extends Error {
  constructor(field: 'dependsOn' | 'inputs.tasks', raw: string, message: string) // message: `invalid <field> "<raw>": <message>`
}

export function parseDependencySpec(
  raw: string,
  field: 'dependsOn' | 'inputs.tasks',
): DependencySpec

// A task name holding `*` is a PATTERN over task names (`build.*`, `check.*`):
export function isTaskPattern(task: string): boolean
export function compileTaskPattern(pattern: string): RegExp // `*` is any characters; anchored
```

### Grammar

| Form       | Result                                             |
| ---------- | -------------------------------------------------- |
| `name`     | `{ kind: 'self', task: name, negated: false }`     |
| `^name`    | `{ kind: 'deps', task: name, negated: false }`     |
| `pkg#task` | `{ kind: 'cross', project, task, negated: false }` |
| `*`        | `{ kind: 'wildcardSelf', negated: false }`         |
| `^*`       | `{ kind: 'wildcardDeps', negated: false }`         |
| `!<form>`  | Same kind as `<form>`, with `negated: true`        |

Errors:

- `''` (empty) → `empty spec`
- `'!'` (no body) → `negation with no body`
- `'^'` (no task) → `"^" with no task name`
- `'^pkg#task'` → `"^" cannot combine with "pkg#task" — pick one`
- `'#task'` / `'pkg#'` → `pkg#task requires a non-empty project AND task`

### Caller-side semantics

`graph/task-graph.ts` rejects the BARE wildcards (`*`, `^*`) and
negation in `dependsOn` — those are filter-only — and a pattern in
the `pkg#task` form. A partial pattern in the `self` and `deps` forms
(`build.*`, `^build.*`) is legal there: it names a namespace of tasks
to add (Nx 19.5 parity), every other same-project task matching it,
or the matching tasks of each dependency; zero matches is legal, since
a preset-spread pattern need not match in every project. The parser
does not know any of this; it parses, and `isTaskPattern` /
`compileTaskPattern` are what the consumers match with.

`graph/folds.ts` accepts every form because that's the filter
context. Last-write-wins ordering is applied there, not here.

The parser lives in `util`, not `graph`, because
`workspace/config-schema.ts` parses each `inputs.tasks` entry at load
(`vx lock` included) and the workspace module cannot import the graph.
An error names the field it parses: `invalid inputs.tasks "^": …`.

### Tests

`tests/task-graph.test.ts`, `tests/wildcard-depends.test.ts` (the
partial patterns and the three refusals) and `tests/orchestrator.test.ts`
cover the behaviors in their respective consumer contexts. The parser
itself is tested via the consumer tests (every grammar form is
exercised through `dependsOn` or `inputs.tasks` use cases).

## `src/util/paths.ts` — POSIX-path normalisation

### Purpose

Normalize path separators to forward slashes so a path in a cache key
has one spelling. Every platform vx runs on (Linux, macOS, Windows
through WSL) already separates with `/`, so `toPosix` returns its input
there. Used wherever a path participates in a cache key (input file
paths, output file paths, etc.).

### Public surface

```ts
export function toPosix(p: string): string
export function relPosix(from: string, to: string): string
// `.vx/.gitignore`'s text: vx's machine-local state stays out of git
export const DOT_VX_GITIGNORE = '/cache\n/tmp\n'
// `.vx/.gitattributes`'s text: GitHub collapses the machine lock in a diff
export const DOT_VX_GITATTRIBUTES = 'projects.lock.json linguist-generated=true\n'
export function normalizeGlob(glob: string): string
export function normalizeBunGlob(glob: string): string
export function staticPrefix(glob: string): string
export function grantPrefix(glob: string): string
export function wholeSubtreePrefixes(globs: readonly string[]): string[] | null
export function outputDirPrefixes(globs: readonly string[]): string[] | null
export function asTrees(patterns: readonly string[]): string[]
// An output list's positive globs and what its `!` entries take back, and
// the matcher that honours both: a `!` glob compiled as-is is Bun.Glob's own
// negation, true of every other path (A-44).
export function splitNegations(globs: readonly string[]): { positive: string[]; negative: string[] }
export function outputMatcher(globs: readonly string[]): (rel: string) => boolean
// What no output glob selects in `scope`: the project root's `.git`, `.vx`
// and `vx.lock.json` (the workspace's: every project's `vx.lock.json`), and
// a `node_modules` unless a glob names it or, in a project, it is under
// the literal directory of a glob that matches it (`.output/**`)
export function outputExcluded(
  globs: readonly string[],
  scope: 'project' | 'workspace',
): (rel: string) => boolean
// What a restore may write: a declared output, not `outputExcluded`
// (the save side's set)
export function restorableOutput(
  globs: readonly string[],
  scope?: 'project' | 'workspace',
): (rel: string) => boolean
// The directory a `<dir>/**` glob is rooted at, which the glob does not
// match: its empty root is saved and made as an empty output directory
export function treeRoot(pattern: string): string | undefined
// What a restore may make as an empty directory: `restorableOutput`'s, or a `treeRoot`
export function restorableOutputDir(
  globs: readonly string[],
  scope?: 'project' | 'workspace',
): (rel: string) => boolean
export function isLiteralPattern(glob: string): boolean
export function stripTrailingSlash(p: string): string
export function taskGlob(pattern: string): Bun.Glob
export function anyTaskGlob(patterns: readonly string[]): (rel: string) => boolean
// A path inside an install (`node_modules/` at any depth): untracked, it is
// never an input; tracked, it is a source like any other (X-4).
export function isInstalledPath(rel: string): boolean
// A brace whose alternatives hold `/` expanded (Bun.Glob's scan skips one):
// workspace discovery and the output scan (A-10).
export function slashBraceExpansions(pattern: string): string[]
// Every brace group of two or more alternatives, or a range, expanded: where a gitignored
// input a brace names can be (`ignoredReach`)
export function braceAlternatives(pattern: string): string[]
// A brace range's names as Bun.Glob (1.4.4) reads them (`1..3`, `01..03`, `a..c`, `1..10..3`), or null
export function braceRange(body: string): string[] | null
export const BRACE_RANGE_LIMIT: number // 1024 — the most names a range may name
// How many globs braceAlternatives would return, counted without expanding, capped at cap + 1:
// a task glob's product past BRACE_RANGE_LIMIT is refused at load
export function braceExpansionCount(pattern: string, cap: number): number
export const GLOB_WILDCARDS: RegExp // /[*?{}]/ — a task glob's wildcards
// A path as a task glob names it alone, in a spelling the config check accepts: `[*]`, `[?]`,
// `\[`, `\{`, `\\`, a leading `\!`, a space at either end `[ ]` (a sandbox fix's key entry)
export function taskGlobOf(rel: string): string
export const BUN_GLOB_WILDCARDS: RegExp // /[*?[\]{}]/ — Bun.Glob's own
// An extglob group, which vx's matchers do not read: refused in member and task globs (A-62).
export const EXTGLOB: RegExp // /[!@+*?]\(/
// C0/C1 controls and DEL as `\xNN`, for a file name vx prints (L-31).
export function printable(s: string): string
// Whether `s` holds a char `printable` escapes: a project or task name may not.
export function hasControl(s: string): boolean
// Whether vx may write or delete at `real`, where a link landed: under `realBase`, not in its own `.git`.
export function writableUnder(real: string, realBase: string): boolean
```

**Two alphabets.** A TASK glob (`inputs.files`, `outputs.files`,
`workspaceFiles`) is a standard glob (2026-10-18): `[ab]` is a class and
`app/\[id\]/**` the route directory. `GLOB_WILDCARDS` is `Bun.Glob`'s set
plus the backslash: an escaped pattern is matched, never compared as a
string, and `literalPath` reads one that names a single path
(`app/\[id\]` → `app/[id]`) for `asTrees`, `wholeSubtreePrefixes` and the
overlap refusal; `staticPrefix` unescapes its head. The globs vx does not
own keep `Bun.Glob`'s grammar: package-manager member globs
(`normalizeBunGlob`, `BUN_GLOB_WILDCARDS`), `--filter` path globs, and a
sandbox grant's prefix (`grantPrefix`), which must stop where the scan
that expands the grant sees a wildcard.

- `toPosix(p)` — replaces every `path.sep` with `/`.
- `relPosix(from, to)` — `path.relative(from, to)` then `toPosix`.
- `normalizeGlob(g)` — the spellings a reader accepts but a matcher turns
  into nothing: a leading `./`, an inner `/./`, a doubled `//`, a trailing
  `/` on a pattern (→ `/**`), a trailing `/.` (read as `/`); after an optional `!`. The one rule behind
  the input/output resolver (`asTrees`), the watch loop's output
  containers, the subtree short-circuit and the schema's "names the
  directory itself" refusal (2026-09-10). An escape stays as written.
- `normalizeBunGlob(g)` — the same spellings for a glob in `Bun.Glob`'s
  own alphabet (the workspace member globs, a sandbox grant): `\[`
  stays escaped, since there it is what keeps a bracket from opening a
  class.
- `staticPrefix(g)` — the wildcard-free head of a glob, whole components
  only; a brace set counts as a wildcard, and a literal's trailing slash
  is dropped (the prefix is a directory either way). Normalizes the
  spelling FIRST — sharing the function was not enough to make its
  callers agree, because the sandbox joins the prefix onto a directory
  and `path.join` folds `./`, `//` and `/./` on the way while the
  deferral gate compares the strings raw (item 441). Shared by the
  deferral gate, the restore tier, the stable-key reach and the watch
  loop's output container.
- `grantPrefix(g)` — `staticPrefix` in `Bun.Glob`'s alphabet, for a
  sandbox write grant: the sandbox baseline's directory, and the
  directory the empty-grant warning names.
- `wholeSubtreePrefixes(globs)` — the `<dir>/**` directories a task's
  outputs cover whole, or `null`; normalizes first.
- `outputDirPrefixes(globs)` — the directories whose snapshot covers every
  path the globs can match: a whole subtree or literal as itself, any other
  glob as the tree under its static prefix, a root-anchored one
  (`**/dist/**`) as the whole project `''`; `null` when one leaves the
  project. Behind the warm hit's directory proof.
- `asTrees(patterns)` — a literal entry is the file OR its whole tree, so
  every literal compiles to itself plus `<path>/**`. It lives here, not
  beside the resolver, because it is not only the resolver's rule: it
  decides what a clean DELETES, so `graph`'s overlapping-output refusal
  has to read the same one, and `graph` may not import `cache` (item
  442). Re-exported by `cache/index.ts`, which is still its contract for
  the resolver.
- `isLiteralPattern(g)` — true when a task pattern carries no wildcard,
  so it names exactly one path and may be compared as a STRING; anything
  holding `*`, `?`, a class, a brace alternation or an escape must be
  MATCHED instead. The character set is the whole content, and it lives
  here for the reason `asTrees` does: four places asked this question and
  `graph/task-graph.ts` asked it without `{}`, so `dist/{a,b}.txt`
  counted as a literal and the overlapping-output refusal compared it to
  `dist/a.txt` as two unequal strings — the two tasks were accepted and
  then deleted each other's outputs, green, every run (item 495).
- `literalPath(g)` — the one path a task glob names, an escaped one
  included, or null for a pattern.
- `taskGlob(p)` — compile a task glob for `Bun.Glob`, memoised. Its
  `match` is a RegExp of the same verdict when the pattern has no brace,
  class, escape, empty or dot segment: a JS test, not a native call.
  Every `!` in `p` is the character (a matcher never gets an entry's
  negation; `{x,!a}` matched every path), and a negated class never
  takes a `/` (`gen[!.]*` took `gen/notes.txt`, which a clean deleted).
- `scannable(p)` — `p` as a scan must read it: each `\]`, `\}` and `\\`
  outside a class spelled as a one-character class (`[]]`, `[}]`,
  `[\\]`), since `Bun.Glob`'s scan reads those escapes, in a segment
  with no wildcard, as the backslash and the character (an output
  `dist/\]b` saved nothing); each `!` outside a class escaped, since the
  scan reads one that starts a name as a negation (`out/*/!a` saved every
  other file, `out/!*` none). `taskGlob` scans with it; a sandbox
  grant's scan uses it too.
- `anyTaskGlob(ps)` — whether a path matches any of the task globs: one
  RegExp per 1000 alternatives when each has one (Bun's RegExp slows
  sharply past about 2000). An input file is tested once per side
  (positives, excludes), not once per glob. The `**/` globs share one
  leading `(?:.*/)?`: each with its own was retried at every slash, and
  1000 of them took 24 s over 200,000 paths.

### Why

A key folds paths, so a path must have one spelling: a walk that
yielded `src\index.ts` where another yielded `src/index.ts` would key
the same task twice. vx runs only where the separator is `/` (native
Windows is not supported; use WSL), so the conversion is a fast-path
no-op today, and costs nothing to keep.

### Tests

`tests/util-paths.test.ts` (each helper, incl. the spellings
`staticPrefix` folds), `tests/dot-slash-globs.test.ts`
(the spellings `normalizeGlob` folds, end to end), `tests/output-dirs.test.ts`
(`outputDirPrefixes` behind the directory proof) and
`tests/watch-rules.test.ts` (`staticPrefix` behind the output
container), `tests/task-glob-brackets.test.ts` (a class, and an escaped
route directory through inputs, outputs, `workspaceFiles`, `--affected`
and the additive hit); transitively through `tests/cache.test.ts` (cache-key
determinism) and `tests/inputs.test.ts` (glob result shapes).

## `src/util/hash.ts` — xxHash3 helpers

### Purpose

Thin wrappers over `Bun.hash.xxHash3` shared by every cache-key
derivation site (`Cache.key`, `task-hash.ts`, lockfile claims,
config-load cache busting). xxHash3 has no streaming hasher API in
Bun, so multi-part keys chain digests via the seed parameter. Bun reads
only the low 32 bits of that seed, so `xxh3` XORs the seed back into the
digest (feed-forward): a chain carries 64 bits of state, and a seed of
`0n` returns Bun's digest unchanged (item 682).

### Public surface

```ts
export function xxh3(input: string | Uint8Array, seed?: bigint): bigint
export function xxh3hex(input: string | Uint8Array, seed?: bigint): string // 16-hex, zero-padded
export function keysSorted<T>(v: T): T // itself when every object's keys are sorted, else a sorted copy
```

`keysSorted` is what a task config's key hashes (`task-hash.ts`) and what
`vx lock` writes, so the order a file or a plugin spells keys in moves no
key, and a config read from the lock costs a check, not a copy.

### Invariants

- 16-hex output width matches Turbo's xxh64 key width; changing the
  algorithm or width is a `CACHE_VERSION` bump.
- A chained step depends on all 64 bits of its seed. A bare
  `Bun.hash.xxHash3(part, seed)` chain does not; nothing folds that way
  (the lockfile parsers pass the global digest as data).

### Tests

`tests/util-hash.test.ts`: the published XXH3_64bits vectors for `""`
and `"abc"`, the default seed of exactly `0n` (`Cache.key` seeds its
chain from it), determinism, the barrel re-export being the same
function, and the fixed 16-char rendering. Pinned again by every
cache-key stability test. `tests/hash-chain.test.ts`: Bun's 32-bit seed
read (pinned, so an upgrade that changes it is a decision), a
birthday-found pair of states sharing a low half kept apart after a
common tail, and 2^17 `Cache.key` calls over one env value with no two
keys equal; both collision rows are red without the feed-forward.
`tests/task-hash.test.ts`: a config keys alike whatever its key order.

## `src/util/memo-parts.ts` — what a memo's answer depends on

### Purpose

The one way a memo declares its token. `Depends<T>` names every field of
the memo's input: a part of the token, `unread(why)`, or
`onlyAbsent(why)` (the memo cannot answer while it is set). A field added
to the input is a type error at the memo until the declaration says which.
Used by the run key, graph, dependents count, fold probe and config bundle
memos.

### Public surface

```ts
export interface Unread {
  readonly unread: string
}
export interface OnlyAbsent {
  readonly onlyAbsent: string
}
export const unread: (why: string) => Unread
export const onlyAbsent: (why: string) => OnlyAbsent
// The field's part of the token; undefined when the memo cannot vouch for this value.
export type Part<V, T, C> = (value: V, of: T, ctx: C) => string | undefined
export type Depends<T, C = void> = {
  readonly [K in keyof T]-?: Part<ValueOf<T, K>, T, C> | Unread | OnlyAbsent
}
export interface MemoParts<T, C = void> {
  push(of: T, ctx: C, out: string[]): boolean // false: the memo cannot answer
  token(head: string, of: T, ctx: C): string | undefined // xxh3 of head and parts, `\0`-joined
  without(keys: readonly (keyof T & string)[]): MemoParts<T, C> // parts another token names
}
export function memoParts<T, C = void>(depends: Depends<T, C>): MemoParts<T, C>
```

### Invariants

- Parts are pushed in declaration order; an unread field adds nothing.
- `without` keeps every `onlyAbsent` check.

### Tests

`tests/memo-parts.test.ts`: order, unread and only-absent fields, a part
that cannot vouch, `without`, and a missing field as a type error.

## `src/util/ulid.ts` — run-id generator

### Purpose

Stamp every `vx run` invocation with a sortable, collision-resistant
id (`run_id`) that's shared across every task in that invocation.
It keys the `invocations` header row (`run_id`) and every `runs` row
of that invocation, so queries group by run and id order is time
order.

### Public surface

```ts
export function ulid(): string
```

A thin wrapper over `Bun.randomUUIDv7()`: a 36-character UUIDv7 in the
standard hex-with-hyphens form (RFC 9562) — a 48-bit millisecond
timestamp leads, then a 12-bit counter (random start each
millisecond) and 62 random bits. The function
keeps its old name; the value has not been a Crockford-base32 ULID
since the hand-rolled generator gave way to Bun's built-in, which
covers the same guarantees with zero custom code.

### Properties

- **Lexicographically sortable** by time (millisecond resolution):
  later ids sort after earlier ones.
- **Collision-resistant** under parallelism — 62 random bits
  is plenty for the "two `vx run` invocations within the same ms"
  case.
- **No dependencies, no custom code.**

### Why not `crypto.randomUUID()`

A v4 UUID isn't lexicographically sortable, so grouping `runs` table
rows by time-window or "the latest run" would require a separate
timestamp column AND join. A v7 UUID does both jobs in one column.

### Tests

`tests/ulid.test.ts`:

- 36 characters, the UUIDv7 shape.
- Many rapid generations are all unique.
- Later ids sort after earlier ones.

## `src/util/errors.ts` — clean error reporting

### Purpose

Distinguish user-input failures (config errors, missing refs, malformed
flags) from internal bugs (assertion failures, unexpected nulls).
Surfaces user errors as plain messages without a stack trace; internal
errors keep the stack so we can debug them.

### Public surface

```ts
export class UserError extends Error {
  readonly code: string // VX_E_…, default VX_E_REFUSED
  parts?: RefusalParts // the terminal form, when a verb renders it as a notice
  constructor(message: string, code?: string)
}
export interface RefusalParts {
  readonly tone?: 'info' // nothing is wrong, just nothing to show yet; default error
  readonly headline: string
  readonly what?: readonly string[]
  readonly why?: string
  readonly fix?: string
}
export function refusal(parts: RefusalParts, opts?: { code?; message? }): UserError // message defaults to the parts joined
export function isUserError(err: unknown): err is UserError // by name, across a copy boundary (below)
export function errorCode(err: unknown): string // the stable code of anything bin.ts catches
export function thrownMessage(err: unknown): string // what any thrown value says; never throws
export function wantsJson(argv: readonly string[]): boolean // --format json, --format=json, --dry=json, before `--`
export function errorDocument(code: string, message: string): string // `{"ok":false,"error":{code,message}}` + newline

// The environment's refusals, reported like a UserError — one line naming the path, never a stack:
export function isPermissionError(err: unknown): err is NodeJS.ErrnoException // EACCES, EPERM, EROFS
export const PERMISSION_HINT: string
export function isDiskFull(err: unknown): err is NodeJS.ErrnoException // ENOSPC, EDQUOT
export const DISK_FULL_HINT: string
export function isFsRefusal(err: unknown): err is NodeJS.ErrnoException // either of the two, or ENAMETOOLONG (an output past PATH_MAX)
export function fsRefusalHint(err: NodeJS.ErrnoException): string
export function isOutOfFds(err: unknown): err is NodeJS.ErrnoException // EMFILE, ENFILE
export const OUT_OF_FDS_HINT: string // "raise the limit (ulimit -n 4096)"
export function isTmpdirRefusal(err: unknown): err is NodeJS.ErrnoException // a path under os.tmpdir() missing, a file, or unwritable
export const TMPDIR_HINT: string // "point TMPDIR at a writable directory"

export function isExecutableMissing(err: unknown): boolean // Bun's ENOENT for a spawn that could not run at all
export function gitSpawnRefusal(cwd: string): UserError // the one refusal for a git that is not on PATH, VX_E_NO_GIT
export function notAWorkTree(cwd: string, stderr?: string): UserError // the one refusal for a directory git does not track, VX_E_NO_GIT
export function gitFailure(cwd: string, args: string, exitCode: number, stderr: string): UserError // a git that failed in cwd: notAWorkTree, else VX_E_GIT

// src/util/config-frame.ts: a config refusal at its `line:col`, with the source under it; undefined when it names no field
export function configErrorFrame(message: string, cwd: string): string | undefined
export function configRefusal(message: string, cwd: string): ConfigRefusal | undefined // { where, problem, allowed?, fix?, via?, frame }: the same, in a notice's parts
```

`UserError` instances have `.name === 'UserError'`. `bin.ts` prints
anything `isUserError` admits as `refusalNotice(verb, err.message, err.parts)`,
the verb read off the message's `vx X:` prefix or argv; a file-system refusal
(`isFsRefusal`) as its message plus `fsRefusalHint`; a process out of
file descriptors (`isOutOfFds`) as its message plus `OUT_OF_FDS_HINT`;
anything else with
its stack. Every one sets exit code 1 — nothing is re-thrown. When the
argv asks for JSON (`wantsJson`), `bin.ts` also prints `errorDocument`
on stdout with `errorCode`: a UserError's own code (`VX_E_CONFIG` for a
codeless one that opens with its config file, which a config's own
throw becomes: `<kind> config <file> threw: …`), `VX_E_FDS`, `VX_E_FS`, or `VX_E_INTERNAL`. The codes are listed in `cli.md` § Error codes.
`isTmpdirRefusal` is not `bin.ts`'s: the sandbox runtime and the run
lock ask it and add `TMPDIR_HINT` to their own message, because a
minimal image's sandboxed task once said only "EACCES … mkdtemp"
(2026-09-16).

### Convention

Throw `UserError` whenever the cause is user input or environment
state the user can fix without code changes:

- Malformed `vx.config.ts` (validated in `project-loader.ts`).
- Missing workspace root (`findWorkspaceRoot`).
- Bad git ref for `--affected` (`workspace/affected.ts`).
- Cycle in the task graph (`graph/task-graph.ts`).
- Duplicate package names, one of them with a vx config (`workspace.ts`).
- Bad CLI flags (in `cli/run.ts`).

Throw plain `Error` (or let TypeError / RangeError propagate) for
internal bugs — those should show a full stack so we can find them.

### Tests

`tests/errors.test.ts` — verifies the `name` field, basic shape.
`tests/refusal-notice.test.ts` — how a message splits into a notice's parts.
Real coverage comes from every module's "bad input" tests.

### `isUserError(err)`

`instanceof UserError`, plus the same class arriving from **another copy of
core**. A compiled `vx` binary carries core inside it while a workspace
plugin imports `@vzn/vx` from `node_modules`, so a plugin's `UserError` is a
different class object and `instanceof` is false across the boundary — a
plugin verb's refusal printed with a stack, and a REAPI refusal would have
read as an "internal error" (reproduced through the real binary,
2026-09-03). `bin.ts`, the scheduler and the plugins consult this
helper; it is on the façade so a plugin can classify the same way. The
**name** `UserError` is the contract that survives the copy boundary: a
plugin may throw its own class named `UserError` without importing core's.

`thrownMessage(err)` is what a line naming a plugin's failure quotes. A
plugin may throw anything: `String(err)` read `[object Object]` for an
error-like `{ message }`, `undefined` for a bare `throw`, and threw itself
on an object with no prototype. It takes a string `message` when there is
one, else says `threw <value>` (`tests/plugin-thrown-values.test.ts`).

`isExecutableMissing(err)` is Bun's `ENOENT` for a spawn that could not
run at all, and `gitSpawnRefusal(cwd)` the one `UserError` for a git that
is not on PATH — the input enumeration and `--affected` say it (item 241): install git, not "git init".

`configErrorFrame(message, cwd)` (`src/util/config-frame.ts`) is how
`bin.ts` and `vx lock` print a config refusal: from the message the schema writes
(`<file>: tasks.<name>.<path> …`, a setting's `<file>: \`run.schedule\` …`,
`<file>: task name "<name>" …`, or `<file> has unknown field …`) it
finds the field's key in the file, each path segment inside the object
literal of the one before (a field the object leaves out, `outputs is
required`, is placed at that object's key; an element, `plugins[1]`, at
the element; a refused key a message quotes, `define: "A=B" …`, at that
key), and returns the message with the file at `line:col`(relative to`cwd`
unless that climbs out) and the lines up to it with a caret; undefined
when it cannot place the field, and the message prints as it was. The
loader's syntax error (`Project config <file>:<line>:<col>: …`, Bun's
position) is framed at that position, and a config's own throw
(`Project config <file> threw: … (at <file>:<line>:<col>)`) at the line
its stack names in the config, a cause's `(at …)` made relative too.
An import nothing provides (`<kind> config <file>: cannot find '<pkg>'`)
is framed at its specifier, a default export that is no object at
its `export default`, and an import of a name its module lacks at that
name in the import that names it, in the config or a file it imports.
A value the walk cannot see into (`test: testTask`, a `...lib()`spread) is followed to where that name is declared: in the config, or in
the file it imports it from (relative or a workspace package; not one
under`node_modules`), past re-exports, four files deep. That file is
framed, and `configRefusal`names the config as`via`; `vx lock` says one
such refusal once, with every config it reaches (`used by …`).
`configRefusal`keeps a field refusal it cannot frame at its file,
relative, with its fix and an empty`frame`.

## `src/util/timing.ts` — `VX_DEBUG_TIMING` stage table

### Purpose

Answer "where did the warm run go?" without a profiler. With
`VX_DEBUG_TIMING` set to anything but the empty string, `mark(label)` records
the end of each stage — `prepareRun`'s eight, then `run()`'s, the
first of which is marked as `prepareRun` returns and holds the graph,
key and schedule hooks, so a plugin's cost is its own row — and
`span(label)` accumulates the repeated per-task operations: the probe,
the restore, the miss and the save, each split into its steps. The
labels are listed below. `timingLines()` gives the table, which the run prints to stderr as a `ui.trace`
at the end of the run, and at the end of a `--dry` run — a dry run is
how the prepare stages get profiled on a real repo with no install to
run against.
`vx watch` calls `restartTimings()` as each cycle starts, so a cycle's
table holds its own stages alone, timed from its start rather than
across the idle wait before it (`tests/watch-timing.test.ts`).
`prepareRun` calls `beginRun()` first: a process's first run keeps
its stages from this module's load, and a later one (an embedder's
second `run()`) restarts the table the same way.

The stage marks are kept whether or not the table prints, and
`stageTimes()` hands them to the run's telemetry summary as wall
windows in epoch ms (`StageTime`: `name`, `startedAt`, `endedAt`),
anchored to `Date.now()` read when the table starts, the clock task
times use (`performance.timeOrigin` drifted 34 ms from it on macOS), which
vx-otel draws as child spans of the run
(`tests/telemetry-trace-facts.test.ts`).

A span's total is WALL summed per call, and the calls run under the
scheduler's concurrency, so a span that overlaps other work reads far
larger than the work it names — a span over a handful of `lstat`s once
read 124 µs a task. The table says so in its own footer now (items 254
and 407 both chased that number before measuring it in isolation);
compare spans to each other, and isolate a suspect one before acting.

### Marks and spans (current)

Marks, in the order a run ends them (`tests/module-shape-drift.test.ts`
pins this list to `prepare.ts` and `run.ts`, and the spans to every
`span(` call under `src/`):

- `startup`
- `workspace config`
- `discover projects`
- `package graph`
- `open cache`
- `load configs`
- `build graph`
- `git enumeration`
- `plugin stages`
- `classify + probe`
- `schedule`
- `run graph`
- `record history`
- `output dir snapshots`
- `close`
- `plan`

`plan` is a dry run's only: `planRun` ends it after `build graph`, and it
holds every task's hash, the cache lookups and the history p50s —
`--dry`'s whole answer, booked under `close` until item 601. It is listed
last because `planRun` follows `run` in the source, the order this list
keeps.

Spans, accumulated per call:

- `cache.get`
- `miss: build request`
- `miss: clean outputs`
- `miss: execute`
- `miss: recheck inputs`
- `miss: resolve outputs`
- `miss: save`
- `miss: stamp outputs`
- `output glob`
- `output stat`
- `probe`
- `restore: extract`
- `restore: rows`
- `save: index tx`
- `save: pack`
- `save: scan`
- `save: write temp`
- `stable keys`
- `task hash`

### Invariants

- The table is off by default. `mark` is a push per stage (~15 a run)
  either way; `span` returns a shared no-op when off, so the hot path
  allocates nothing.
- Spans run under the scheduler's concurrency, so they over-count (a
  span's wall includes time yielded to other tasks). Compare spans to
  each other, never to the stage total — see `docs/benchmarks.md`
  § Profiling a run.

### Tests

Exercised by every `VX_DEBUG_TIMING` measurement in `docs/benchmarks.md`.
`tests/timing-dry.test.ts` pins the dry-run table (present through
`build graph` and `close` with the variable, absent without); the
table's shape is a developer tool, not a contract.

## `src/util/edit-distance.ts` — the one "did you mean" rule

### Purpose

Every near-miss hint core prints — task names, `pkg#task` halves,
project names, flags, verbs, config keys — goes through one
rule, so a typo is hinted the same way wherever it is typed.

### Public surface

```ts
editDistance(a, b, cap = 3): number   // Levenshtein, capped: `cap` or more edits read as `cap`
nearest(name, candidates, maxEdits = 2): string | undefined
nearMatches(name, candidates, limit = 3): string[]
listed(names, limit = 8): string      // sorted, deduped, `, and N more` past the limit
```

- `nearest` is THE hint: the closest candidate within `maxEdits`, or
  nothing — an exact match is not a hint, and anything further would
  guess rather than help. Nor is a candidate the edits rewrite whole
  (as many edits as the longer name has letters): `--filter=x9`
  offered the root, `//`. `flagHint` (`cli/help.ts`) widens to three edits only among
  flags sharing a five-character stem (`--retrie` → `--retries`), so
  `--zzz` never reaches `--all`.
- `nearMatches` is for the inspection verbs (`why`, `show`) that list
  a few candidates instead of picking one: nearest by distance first,
  then case-insensitive containment either way, never `name` itself.
- `listed` is what an error offers when `nearest` finds nothing: the
  tasks, a project's tasks, or the projects that exist (M-56).

### Tests

`tests/near-miss.test.ts` (every surface that hints, the exact-match
and beyond-two-edits controls); `tests/no-cache-word.test.ts`.

## `src/util/bun-version.ts` — the runtime floor, read at run time

### Purpose

`package.json` states `"engines": { "bun": ">=1.4.4" }`. An install may print
that; a RUN never reads it. `bun src/bin.ts` on an older Bun starts fine and
then answers wrongly, which is this repo's worst failure class — a green exit
over a wrong answer.

```ts
export const MIN_BUN = [1, 4, 0] as const
isUnsupportedBun(version): boolean
unsupportedBunMessage(version): string
```

### What breaks below the floor

Measured on Bun 1.3.11 (2026-09-19, STATUS item 366), against the same tree
that is green on CI's pinned 1.4.2:

- A 2 MiB `--format json` answer reaches a pipe as **219 KB**. That was
  `bin.ts` ending stdout inside a callback, which fired early below the
  floor; `bin.ts` now sets `process.exitCode` and lets the loop drain
  instead (2026-09-20).
- The runner reads no `peakRssBytes` at all, so `vx last` and `vx why` report
  nothing about what a task used.
- A config syntax error arrives as a `BuildMessage`, which the loader's
  classifier does not know, so it surfaces as an internal error instead of the
  `UserError` naming file, line and column.

- `fs.watch` never reports a DOT-prefixed filename. A plain file is
  delivered, `.vx-watch-probe` is dropped, in both recursive modes — and
  that probe is precisely how `watch-fs.ts:armWatcher` proves a watcher is
  live, so every `vx watch` below the floor falls back to polling. Not
  silently: `WatcherPool` already swaps in `pollWatcher` and says so on stderr
  (`no OS watch events within … ms; polling every … ms instead`), which is
  why this one degrades rather than breaks.

Twenty-one of that container's 23 failures were these four.

On Bun 1.3.14 (2026-10-03), `Database.close(true)` with a prepared statement
alive answers SQLITE_BUSY ("database is locked") instead of finalizing it, so
every `vx run` with a local cache exited 1 with that stack after its tasks
passed. `cache.ts`'s `closeDb` now falls back to the deferred `close()` there
(M-44).

### Where the verdict is reported, and why there

`vx info`'s `bun` ROW, which already carried the version and not its meaning.
The typed field stays clean: `InfoFacts.bun` is the bare version a script
reads and `InfoFacts.bunSupported` is the verdict, because `--format json` is
a machine surface that a test holds to `Bun.version` exactly. The prose
appears only in the rendered row:

```
  bun               1.3.11 — unsupported, vx needs >= 1.4.4; answers may be wrong
```

Two designs were tried and measured against the repo before this one.

**A refusal**, mirroring `@vzn/vx-reapi`, which stops at its wire
(`wire.ts:assertBunSupportsChunking`). That is right for the plugin: its
failure mode is a **hang**, and a hang leaves the user nothing to read. Core's
failure mode is a wrong answer, and most of core works below the floor — 23 of
~2,000 tests failed there. "The tool does not start" is heavier than the
measurement supports.

**A warning on stderr from `bin.ts`**, before every verb. It cost 19 tests,
each asserting the same real property: a successful vx command writes NOTHING
to stderr. A diagnostic is not worth weakening that, and on a conforming
runtime the line never prints, so the relaxations would have been permanently
dead weight.

So the verdict goes where a reader already looks to ask whether the setup is
sane, beside the sandbox row and the config-error rows. The cost is stated: a
user who never runs `vx info` is not warned. That is proportionate to what was
measured — wrong answers on an unsupported runtime, not a broken tool.

A compiled binary carries its own Bun and the row never says it.

### Tests

`tests/bun-version.test.ts`:

- the comparison, major then minor then patch, over seven versions asserted as
  one set;
- a canary suffix judged by its release, junk treated as ancient;
- the doctor case, which asserts `bunSupported` is false **exactly when this Bun
  is below the floor** — the same claim on a conforming runtime and on one below
  it, which is the only way a guard about the runtime can be tested on both;
- and the property the first draft broke: a clean invocation still writes
  nothing to stderr.

## `src/util/num.ts` — integers at the boundaries

### Purpose

The numeric rules every argument boundary shares, and the one duration format every surface prints, in one place.

```ts
export const MAX_TIMEOUT_MS = 2 ** 31 - 1
clampInt(n, min, max): number
parseDecimalInt(input): number | null
formatElapsed(ms, minutes?): string
isMeasure(v): boolean
```

- **`MAX_TIMEOUT_MS`** is the largest delay `setTimeout` honours
  (~24.8 days). A larger one does not saturate and does not throw — it
  silently becomes **1 ms**, the inverse of what was asked: a task
  declaring a 317-year timeout would be SIGTERMed 4 ms after it spawns.
  Every surface that accepts a millisecond delay bounds against it.
- **`clampInt`** floors to an integer in `[min, max]`; non-finite
  collapses to `min`. The floor is load-bearing wherever the result
  reaches SQL: a fractional `LIMIT` is a `datatype mismatch`, not a
  smaller page.
- **`parseDecimalInt`** accepts a plain decimal integer only. `Number()`
  at an argument boundary accepts hex, exponents, fractions, a leading
  `+` and whitespace, so a typo becomes a different number instead of
  an error; values past `MAX_SAFE_INTEGER` parse to a number the user
  did not type and are rejected too.
- **`formatElapsed`** is a duration as vx prints it: `12ms`, `1.23s`,
  and with `minutes` (`vx last`) `2m 5s`. The value is rounded to the
  unit shown before the unit is chosen: 999.6 ms printed `1000ms` and
  119,600 ms `1m 60s` (item 1034).
- **`isMeasure`** is a timing SQLite may keep: finite and not below
  zero. Infinity stored as REAL reads back through `group_concat` as
  `Inf`, a NaN forecast.

### Tests

`tests/util-num.test.ts`; `tests/timeout-bounds.test.ts` (every
timeout surface against the ceiling); `tests/options-resolve.test.ts`.

## `src/util/settle.ts` — the end-of-run settle bound

### Purpose

A plugin's flush or teardown is I/O a third party wrote; it must not
hold the run's exit hostage. This is the deadline every end-of-run
await goes through (`plugin-host.ts`, `telemetry-host.ts`), and a
plugin's `telemetry()` consultation before the run too (item 921).

```ts
testTimerMs(name, defaultMs, zero = false): number // VX_TEST_<name>, else defaultMs
teardownTimeoutMs(): number                       // default 3000
settleWithin(p: Promise<unknown>, ms): Promise<boolean>
killGraceMs(defaultMs: number): number            // defaultMs
POST_EXIT_DRAIN_MS                                // 250: the drain after a shell exits
claimExitForSignal(): void                        // a signal's handler will end the process
exitClaimedBySignal(): boolean
dieOf(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void // die of it, waiting (1 s bound) for it to land
```

- `testTimerMs` is the one way a test shortens a run's timer:
  `VX_TEST_<name>`, a duration, read per call. It is undocumented and in
  no settings table (the kill grace, teardown bound and ready notice are
  fixed, 0.0.639); the suites that prove a deadline drive it instead of
  waiting the real one out. Zero is taken only where `zero` allows it;
  garbage, zero elsewhere and a value past `MAX_TIMEOUT_MS` fall back to
  the default rather than clamping: this is a BOUND, not a duration —
  clamping would honour "wait 24.8 days", and past the ceiling the delay
  becomes 1 ms and every flush times out.
- `teardownTimeoutMs` is 3 s (`VX_TEST_TEARDOWN_TIMEOUT`; `0ms` waits
  for nothing not already done).
- `settleWithin` returns true when `p` fulfilled before the deadline,
  false when the deadline won; the caller decides whether a lost result
  is worth a warning. A rejection before the deadline is not a timeout:
  it throws, so the caller reports the failure rather than a hang. One
  landing after the deadline won is swallowed rather than surfacing as
  an unhandled-rejection crash.

- `killGraceMs` is the SIGTERM→SIGKILL grace a run grants a child that
  ignores SIGTERM — the one-shot timeout escalation (`exec/runner.ts`),
  the signal teardown (`orchestrator/signals.ts`) and the end-of-run
  persistent shutdown (`orchestrator/persistent.ts`) share it, 2 s each.
  `VX_TEST_KILL_GRACE` shortens all three: each escalation test used to
  wait the full two seconds, a third of the suite's wall time, for a
  claim 200 ms proves.

- `POST_EXIT_DRAIN_MS` is how long a task's or a runtime probe's pipes
  are read after its shell exits before the reads stop: a child the
  shell left running holds them open, and the run waited for the child.
  Here, not in `exec/`, because `cache/inputs.ts` (the probe) cannot
  import `exec/`.

- `claimExitForSignal` / `exitClaimedBySignal`: bin.ts exits once its
  verb has settled and both streams have ended, so a timer a config left
  cannot hold vx open. A signal's handler (`orchestrator/signals.ts`)
  exits by itself with the signal's code after the run it stopped is
  done, and the verb settles first with the run's verdict; the claim
  keeps bin.ts from exiting 1 ahead of it.

- `dieOf` is how vx and its hand-off die of a stop signal: listeners
  off, the signal sent to itself, then a synchronous wait until it lands
  (1 s bound, the caller's exit code the fallback). A kill can land after
  it returns (another thread took it, a tracer held it), and the
  `process.exit` right after it exited with the code (130, 143, 129)
  instead (CI, PR #4867).
  `VX_TEST_SELF_SIGNAL_DELAY` sends it from a helper that late, the
  window `tests/signal-handling.test.ts` widens.

### Tests

`tests/util-settle.test.ts` (both deadlines and the grace knob);
`tests/timeout-bounds.test.ts`; `tests/exit-held-loop.test.ts` and
`tests/signal-handling.test.ts` (the exit claim).

## `src/util/tail.ts` — head-evicting tail for a stream that may never end

### Purpose

A persistent task (dev server, watcher, daemon) is unbounded by
construction, so anything accumulating its output needs a cap, and
the cap has to be honest: a truncated log that reads as complete is
worse than one that says what it lost.

```ts
export const PERSISTENT_TAIL_CHARS = 64 * 1024

export interface Tail {
  chunks: string[]
  chars: number
  dropped: number // characters evicted from the head; non-zero means the tail is partial
}
export function createTail(): Tail
export function appendTail(t: Tail, chunk: string, limit?: number): void // limit defaults to PERSISTENT_TAIL_CHARS
export function tailText(t: Tail): string
export function resetTail(t: Tail): void
```

Whole chunks are evicted from the head — no concatenation until the
one join at flush, so a chatty server costs one array push per chunk;
a single chunk over the cap is the one place a copy happens. `dropped`
is non-zero exactly when the tail is partial.

`report/logger.ts` is the sole holder: one tail per persistent
task from `taskStart` for the rest of the run, covering the pre-ready
window and everything after with one mechanism. A second pre-ready
copy in `exec/runner.ts` was deleted rather than kept in sync — two
copies of the rule had drifted (one grew a bound, the other did not,
and a never-ready `readyWhen` grew the heap ~100 MiB/s with the cap
sitting unused). The file stays in `util` because `exec` cannot import
`orchestrator`.

### Tests

`tests/util-tail.test.ts` (cap, whole-chunk eviction, the oversize
single chunk, `dropped` accounting, reset).

## `src/util/secret-mask.ts` — masking secret-named values in what vx shows

### Purpose

A task that echoes `$NPM_TOKEN`, or a TS config that builds its command
from `process.env.API_KEY`, put the value in the terminal, the stdout
the cache keeps and every hit replays, the `$ command` line, telemetry
records and `vx show` (L-11). The mask replaces a known value wherever it
appears, the way GitHub Actions masks its secrets.

```ts
export const MASKED = '***'
export interface SecretMask {
  mask(text: string): string
  spans(text: string): Array<[start: number, end: number]> // where mask replaces a value
  stream(): { push(chunk: string): string; end(): string }
  maskCut(head: string, tail: string): [string, string] // also the pieces a cut left
}
export function secretMask(
  sources: readonly (Record<string, string | undefined> | undefined)[],
  named?: readonly string[], // the task's `exec.env.secret`: masked whatever the name
): SecretMask | null
export interface TaskEnvSecrets {
  readonly define?: Record<string, string>
  readonly secret?: readonly string[]
}
export function maskedCommand(command: string, env?: TaskEnvSecrets): string
export function maskedLine(line: string): string // this process's secrets only
export function secretNamed(name: string): boolean // the name rule alone; `vx why` hides such an env input's hashes
export function holdSecret(value: string): void // a keychain answer, the sandbox proxy's token: masked with this process's secrets
export function heldSecrets(): number // how many are held: a mask built with fewer is stale
export function maskedStreams(
  mask: SecretMask,
  emitOut: (text: string) => void,
  emitErr: (text: string) => void,
  idleMs?: number,
): { out(chunk: string): void; err(chunk: string): void; end(): void }
export function maskStreams(
  chunks: ReadonlyArray<{ text: string; err: boolean }>,
  mask: SecretMask | undefined,
): Array<{ text: string; err: boolean }> // each stream's whole text masked
```

A variable is masked when its name holds `TOKEN`, `SECRET`, `KEY`,
`PASSWORD`, `PASSWD` or `CREDENTIAL`, it does not end `_FILE`, `_PATH`
or `_DIR` and is not git's `GIT_CONFIG_KEY_<n>`, or the task names it in
`exec.env.secret` (L-14), and its value has six characters or more. No such variable: `secretMask` is null and nothing is
paid per byte. Any variable's value also masks a URL's password, split
as WHATWG splits it: the userinfo ends at the last `@` before the path,
query or fragment, so `app:p@ss@db` masks `p@ss`.

A mask whose sources include `process.env` also masks every value
`holdSecret` holds: what a plugin's keychain (`ctx.secret`) answered,
which no environment names, and the sandbox proxy's session token
(`initSandbox`), which the runtime puts in a networked task's env
(`CLOUDSDK_PROXY_PASSWORD`, the proxy URLs' password). A server's reply
that echoed that token printed it whole in the warning. `events.ts`
builds its status-line mask again when `heldSecrets()` grows, and
`execute-task.ts` its task's once the sandbox is armed.

Every value is matched at every position (a lookahead alternation), and
overlapping or adjacent matches merge into one span and one `***`: one
alternation resumed past a match, so `${A}xyz789`, where `B` is `A`'s
tail plus `xyz789`, printed `***xyz789`. A stream never cuts through a
span, nor right after one with a held tail behind it.

`stream()` holds back only a tail that could begin a value, so a value
split across two chunks is caught and output that cannot be one (a
`readyWhen` line, a start marker) is never delayed. `maskedStreams` emits a held tail
25 ms after the last chunk when none follows, so a long task's last
characters do not wait for its exit, and before a chunk on the other
stream, so stdout and stderr keep the order the task wrote them in; a
value split by a longer pause, or by a write to the other stream, is
not caught where it streams live. What vx stores of the output
(`encodeOutputLog`, `failedOutputLog`), a replayed hit and a buffered
frame (`report/logger.ts`, the CI default) mask each stream's whole
text again through `spans` (`maskStreams`), a write to the other stream
between the pieces included, so no stored or framed copy keeps a value
a pause split. A telemetry `task.log` record passes a second `stream()`
with no timer (`orchestrator/telemetry.ts`). `maskCut` masks the two sides of a
cut whose middle is gone: a value the cut split leaves a piece at the
end of `head` or the start of `tail`, and each piece is masked too.

Callers: `orchestrator/execute-task.ts` (live output, captured stdout),
`orchestrator/hit-restore.ts` (a replayed hit's output),
`orchestrator/output-log.ts` (the stored log), `report/logger.ts` (a
buffered frame), `report/framed-output.ts`, `report/events.ts` and
`orchestrator/telemetry.ts` (the command; `events.ts` also masks every
status line, where plugin warnings land, L-40), `orchestrator/remote-prefetch.ts`
(the command a remote hit's entry row stores), `cli/show.ts`, `cli/plugin-commands.ts` and `cli/select.ts` (a
plugin's warning, `maskedLine`), `orchestrator/plugin-host.ts` and
`orchestrator/plugin.ts` (a plugin's failure, `maskedLine`, so the error
`run()` rejects with is masked).

## util/hide-env

`hideEnvFromTasks()`, called once at the start of every verb
(`cli/index.ts`, 2026-10-13), and by a global vx before it hands off to
the project's (`handoff.ts`), since it waits out the run. A task gets only the variables it
declares, but vx's own process still holds the rest, and an unsandboxed
task, which runs as the same user, could read them: on Linux from
`/proc/<vx pid>/environ`, on macOS through `ps eww`.

**Linux.** `prctl(PR_SET_DUMPABLE, 0)` through `bun:ffi`: the kernel then
closes vx's `environ` (and ptrace) to every same-user process, root
aside. `/proc/<pid>/stat` stays readable, so the run lock's liveness
check still works, and vx still reads its own `/proc/self`. A child is
dumpable again after `exec`, so tasks are unaffected. About 0.8 ms per
command, the `bun:ffi` load.

`VX_DEBUG_DUMPABLE=1` (or `true`) skips it: strace cannot read a non-dumpable
tracee's memory, so it prints no paths, and a debugger cannot list
`/proc/<pid>/fd`. The strace tests, `vx-bench`'s `strace-vx.ts` and
`sandbox-session-guard.unsafe.test.ts` set it.

**macOS.** No flag closes `ps eww` (sysctl `KERN_PROCARGS2`) to the same
user: it reads the env strings the kernel copied above vx's stack. vx
zeroes the value of every variable there except `ESSENTIAL_ENV`
(`util/essential-env.ts`), which every task gets anyway
(2026-10-13). It finds them through the original `envp` array, which
follows `argv` (`_NSGetArgv`) and never moves, unlike `environ`. Bun
copied the env at startup, so `process.env`, and every task env built
from it, keeps the values; libc's `getenv` answers `''` for a wiped name.
Cost: 0.65 ms per command on macOS CI (`bun:ffi` load included).

A helper vx keeps running beside its tasks would show the same values:
a spawn with no `env` hands the child vx's startup env, and the child is
readable after its `exec`. `helperEnv()` is `PATH` alone; the group
guard (`exec/kill-tree.ts`) and the port bridges (`sandbox/runtime.ts`)
start with it. `gitEnv()` is what git reads (`GIT_*`, the locale,
`XDG_CONFIG_HOME`) plus the essentials; every `git` vx runs gets it
(`tests/git-env.test.ts`). Not covered: the sandbox runtime's own network
bridges on Linux (`socat`, started by the library with its env).

Elsewhere (musl, other systems) it returns `false`. It hides the
environment, not files: an unsandboxed task still reads anything you
can. `exec.sandbox` is the boundary (`docs/security.md`).
`tests/hide-env.unsafe.test.ts` holds both directions on both systems
and prints the cost; `tests/sandbox-parent-env.unsafe.test.ts` holds a
real run.

### util/env-flag

```ts
// A flag-like variable (`CI`, `GITHUB_ACTIONS`) is on: set, and not '', '0' or 'false' in any case.
export function envFlagOn(v: string | undefined): boolean
```

Every reader of `CI` asks this one, so a run cannot be CI to one part of
vx and a laptop to another.

## `src/util/which.ts` — a tool's absolute path, found once

### Purpose

A spawn of a bare name makes Bun walk PATH with a stat per entry. vx
spawned `sh` for every task and `git` for every git call, so a
200-task run on a 100-package workspace paid 2,800 stats for the same
`sh` (14 PATH entries) and 12 for each of five gits. Every spawn site
of a tool vx itself runs — the task shell (runner, sandbox), strace,
git — asks here and hands Bun the absolute path.

### Public surface

```ts
export function executablePath(name: string): string
export function shellArgv(script: string): string[]
export function taskShell(): string
```

- Resolved on vx's OWN `process.env.PATH`, never a task's. A task's
  PATH leads with its project's and the workspace's `node_modules/.bin`
  and `exec.env.define` may set it; the shell that parses the command
  and the git that enumerates the inputs are the machine's tools, so a
  dependency shipping a `sh` bin does not become the interpreter of
  every command in its project (it did: Bun resolved the bare `sh`
  against the task's PATH). The task's PATH still decides what the
  command resolves, inside that shell.
- Memoized per PATH VALUE: one walk per tool while PATH is unchanged
  (nothing in vx changes it mid-run), and a new walk when it does
  change, so an embedder or a test that sets PATH is answered for the
  PATH it has.
- A miss throws Bun's own shape for a spawn that could not run
  (`code: 'ENOENT'`, `Executable not found in $PATH: "<name>"`), so a
  call inside a spawn site's `try` reaches the same
  `isExecutableMissing` refusal ("vx requires git", "Install a POSIX
  sh") as before. A miss is not remembered: it ends the spawn that
  asked, and a long-lived process (`vx watch`) finds the tool once it
  is installed.
- The answer is absolute even for a relative PATH entry (`Bun.which`
  resolves one against this process's cwd).

- `taskShell` is the shell every command runs in: `dash` on macOS when
  vx's PATH has it (macOS's `/bin/sh` is a stub that execs bash), else
  `sh`, both resolved by `executablePath`. Kill-tree's guard and the sandbox use it
  too.
- `shellArgv` is the task shell's argv: `[taskShell(), '-c', script]`.

### Not here

The `inputs.runtime` probe (`cache/inputs.ts`) spawns
`shellArgv` with a PATH led by the task's `node_modules/.bin`.

### Tests

`tests/util-which.test.ts` (one walk per PATH, a PATH change heard, the
miss's shape and that it is not remembered); `tests/task-shell.test.ts`
(a `node_modules/.bin/sh` parses no task command; `$0` is still `sh`);
`tests/syscall-repeats.unsafe.test.ts` (the lookup stats of `sh` and
`git` do not grow with the number of spawns, counted by strace).

## `src/util/procfs.ts` — is `/proc` this process's view

### Purpose

Two readers look other processes up by pid in `/proc`: the group
liveness check (`exec/kill-tree.ts`, which skips a zombie) and the run
lock's holder start time (`orchestrator/run-lock.ts`, which tells a
recycled pid apart). Both assumed the procfs they read numbers
processes the way `process.pid` and `Bun.spawn` do. Under vx's own
sandbox it does not: the task runs in a nested pid namespace where it
is pid 2 while `/proc/self` names 7, and `/proc/<child pid>` is some
other process or none (measured 2026-09-24). The liveness check then
found no member in any group, so a server that ignored the SIGTERM was
never SIGKILLed and the run hung on its pipe.

### Public surface

```ts
export function procfsIsOwn(): boolean
```

- True when `readlink('/proc/self')` is this process's pid: the mount
  belongs to this pid namespace. False off Linux, and when the link
  cannot be read.
- Asked once per process; the mount does not change under a run.
- A caller that gets false answers the way it does off Linux: the
  liveness check trusts `kill(-pgid, 0)`, the run lock trusts the pid.

### Tests

The differential is the sandboxed shards: with the check reverted,
`tests/task-tree-kill.test.ts`, `tests/runner.test.ts` and
`tests/persistent.test.ts` (a SIGTERM-ignoring group outlives the
grace), and `tests/run-lock.test.ts` (a live holder read as another
process), fail under the gate's sandbox. `tests/run-lock-recycled.unsafe.test.ts`
holds that an unsandboxed Linux process reads its own procfs, and the
recycled-pid row that needs one.

## `src/util/secrets.ts` — a plugin's keychain

### Purpose

A remote cache's token typed into every shell (`export TURBO_TOKEN=…`) is
friction a laptop should not have. `ctx.secret` keeps a plugin's secrets
in the OS keychain (`Bun.secrets`: macOS Keychain, libsecret, Windows
Credential Manager) and, when the plugin offers a prompt, asks once on the
terminal and saves the answer (2026-10-17). Core reads no
environment here: a variable, an option or a config file is the plugin's
to check first, so the keychain is always the last source.
`src/util/hidden-prompt.ts` is the terminal side.

### Public surface

```ts
export interface SecretRequest {
  readonly key: string
  readonly prompt?: string
}
export interface PluginSecrets {
  secret(req: SecretRequest): Promise<string>
  forgetSecret(req: { readonly key: string }): Promise<void>
}
export type SecretUnavailableReason = 'not-found' | 'no-terminal' | 'declined' | 'store-unavailable'
export interface SecretUnavailable extends Error {
  readonly reason: SecretUnavailableReason
}
export function isSecretUnavailable(err: unknown): err is SecretUnavailable
export interface SecretStore {
  get(o: { service: string; name: string }): Promise<string | null>
  set(o: { service: string; name: string; value: string }): Promise<void>
  delete(o: { service: string; name: string }): Promise<boolean>
}
export class SecretBroker {
  constructor(
    ci: boolean,
    warn: (m: string) => void,
    store?: SecretStore,
    terminal?: SecretTerminal,
    quiet?: () => () => void, // erases the live region until the release; run.ts: the terminal logger's holdStatus
  )
  for(plugin: string): PluginSecrets
  closePrompts(): void
}
export interface SecretTerminal {
  interactive(): boolean
  ask(question: string): Promise<string>
}
export function terminalOf(stdin, stderr, interrupt?): SecretTerminal
```

- **Where.** On `setup`'s context and on a remote layer's `open`
  (`RemoteOpenContext`): the hooks that run before the status line. A
  `SecretBroker` per run (`run.ts`); `closePrompts` right before
  `runStart`, so a later ask is `no-terminal`, never drawn over the frames.
  An earlier step (`vx:load`) has already started the region's ticker, so
  `quiet` holds every draw from the question to its answer: the ticker's
  erase wiped the prompt line, and vx looked frozen (2026-10-17).
- **Order.** The keychain entry (service: the plugin's package name, name:
  `key`), else, given a `prompt`, the terminal's answer, trimmed and saved.
  Else a rejection `isSecretUnavailable` names: `not-found` (no prompt),
  `no-terminal` (CI, stdin or stderr not a TTY, a terminal that refuses
  raw mode, or prompts closed),
  `declined` (an empty answer, Ctrl-D, Ctrl-C), `store-unavailable` (the
  keychain threw and no prompt was given). By name, not `instanceof`: a
  plugin may load its own copy of core.
- **Once per run per plugin and key.** Concurrent asks share one promise;
  a rejection is kept too, so nothing is asked twice. `forgetSecret` drops
  the memo and deletes the entry (a server refused it); it never throws.
- **One prompt at a time.** A prompt waits for the one before it, so two
  plugins never interleave on the terminal.
- **No keychain** (headless Linux without libsecret): a read is a miss; an
  answer that cannot be saved is used for the run, with one warning.
- **Hidden input.** Raw mode, nothing echoed, backspace edits, the mode
  restored after. Raw mode swallows SIGINT, so Ctrl-C answers nothing and
  raises it: the run stops as it would at any other moment.

### Tests

`tests/secrets.test.ts` (order, no environment, namespacing, memo,
forget, the three prompt gates and the closed-prompt gate, serialization,
store-unavailable, the hidden input); `tests/remote-open.test.ts` (the
run hands `open` its secrets).

## `src/util/hangup.ts` — did vx start with SIGHUP ignored

### Purpose

`nohup` and a supervisor that wants a job to outlive its terminal start
it with SIGHUP ignored. A `process.on('SIGHUP')` replaces that
disposition, so `nohup vx run` stopped its run and exited 129 when the
terminal closed (2026-10-08). The POSIX idiom is to ask before
installing a handler; Node has no API for it.

### Public surface

```ts
export function hangupIgnored(): boolean
```

- Linux reads the `SigIgn` mask in `/proc/self/status`: `self` is this
  process in any pid namespace's procfs, so the sandbox's foreign mount
  (`util.md`) answers too.
- macOS asks `sigaction(SIGHUP)` through `bun:ffi` (about 1 ms, the
  trampoline's compile).
- False elsewhere and when the read fails: a handler is installed, as
  before.
- Read once per process, before the first handler: `signals.ts` and
  `vx watch` ask it before they install theirs, and a removed handler
  does not bring the ignore back.

### Tests

`tests/hangup-ignored.test.ts` (both answers, each from a fresh
process); `tests/task-tree-kill.test.ts` and
`tests/watch-signals.test.ts` (a nohup'd `vx run` and `vx watch` run on
through a hang-up; each fails with the handler installed regardless).

## `src/util/signal-relay.ts` — one stop, heard twice through a relaying parent

### Purpose

A parent that relays stop signals to vx (`npm-launcher.cjs` where Node
cannot `execve`, a global vx handing the call off) shares vx's process
group. Outside a terminal's foreground it passes on every stop, since it
cannot tell one sent to it alone from one sent to the whole group. A
group stop (`kill -TERM -<pgid>`, a hang-up to a background job) then
reached vx twice, and vx read the copy as a second stop, "now": every
task was SIGKILLed mid-cleanup (vercel/turborepo#14972, 2026-11-11).

Bun's package-bin runner (`bun vx run`, the form the docs use) relays
every SIGINT too, in a terminal's foreground as well, and sets no mark:
one Ctrl-C reached vx twice, 0.2 ms apart, and the run ended with no
summary, no job summary and no grace (2026-11-12).

### Public surface

```ts
export function takeSignalRelay(): boolean
export function stopActedOn(): void
export function relayedCopy(signal: string, earlier: string | undefined): boolean
```

- The parent sets `VX_SIGNAL_RELAY=1`; `bin.ts` takes it out of the env
  first, so no task and no vx it hands off to inherits it.
- `stopActedOn` marks the end of vx's work on a stop (`holdSignals`,
  `forwardSignals`); a relayed copy follows it within 40 ms.
- `relayedCopy` is true for the same signal again under a marked parent,
  outside the terminal's foreground (there the Node launcher relays
  nothing). With no mark it is true within 40 ms of the stop when the
  parent is a launcher: it sits in vx's process group, so it heard the
  same stop (a shell's job has a group of its own), and its arguments end
  with vx's, so it ran vx for its own command line (`bun vx run build`).
  The copy took 0.2 ms; a person's second Ctrl-C comes a key press later,
  so it still means "now"; so does a different signal.

### Tests

`tests/relayed-signal.test.ts`: a group SIGTERM and a group SIGHUP
through the Node launcher, a group SIGTERM through a hand-off, and a
group SIGINT through a launcher that relays it unmarked and through the
real `bun vx`, each leave the task its grace to clean up; under that
launcher a second SIGINT 200 ms later still ends the grace at once.

## `src/util/before-exit.ts` — work finished before the process exits

### Purpose

A verb can start work it does not wait for, off its own path: the
workspace config's bytecode bundle (project-loader.md) builds beside a
run instead of inside its `workspace config` stage. `bin.ts` exits once
the verb answers (`exitOnceFlushed`), which would cut that work and leave
its temp dir behind, so the work registers here and `bin.ts` settles it
first, on a refusal too.

A run can also be stranded: a plugin hook that never settles leaves the
verb pending, the loop drains and `bin.ts`'s `beforeExit` ends the
process with exit 1. The run's owed work (its plugins' teardown) and the
name of the hook still awaited are kept here for that exit.

### Public surface

```ts
export function beforeExit(work: () => Promise<void>): void
export async function settleBeforeExit(): Promise<void>
export function hookStarted(plugin: string, hook: string): () => void
export function unsettledHooks(): string[]
export function owedIfStranded(work: () => Promise<void>): () => void
export async function settleStranded(): Promise<void>
```

- `beforeExit` queues `work`: a promise already running (`() => started`)
  or work that starts only once the verb has answered.
- `settleBeforeExit` runs the queue until it is empty, work that queues
  more included, and never throws (`Promise.allSettled`).
- `hookStarted` marks a plugin's hook as awaited until the call it
  returns: `plugin-host.ts`'s `safe` (every stage and factory) and
  `setup`. `unsettledHooks` lists those still awaited, as
  `plugin 'p' never settled its h hook`, for `bin.ts`'s line.
- `owedIfStranded` registers work until the call it returns withdraws
  it: `prepareRun` from its factories to its return, `run()` until its
  teardown. `settleStranded` runs what is registered, once, and never
  throws.

### Tests

`tests/config-bytecode.test.ts` ("a run that makes .vx/cache leaves the
bundle"): the run's bundle is there, with no temp dir, after the
process exits. `tests/telemetry-lifecycle.test.ts` ("a hook that never
settles"): a `setup`, `key` or `schedule` hook that never settles is
named, and the `key` and `schedule` rows' teardown runs.

## `src/util/git-attributes.ts` — which paths a clean filter can rewrite

### Purpose

An index OID is the filtered blob, not the bytes a task reads, so a path
an attribute converts is hashed from disk (cache/git-inputs.ts
`dropFilteredOids`) and is a change to `--affected` (workspace/affected.ts).
Both ask git the same question here.

### Public surface

```ts
export const CHECK_ATTR: string[]
export function parseCheckAttrOutput(out: string): Set<string>
```

- `CHECK_ATTR`: `git check-attr --stdin -z --all`, the paths on stdin.
  `--all` prints only what a rule sets; asked by name, git printed all
  five converting attributes for every path, `unspecified` included
  (vueuse: 473 KB and ~5 ms of the main thread a run, 160 KB under
  `--all`).
- `parseCheckAttrOutput`: the paths with `text`, `eol`, `ident`,
  `filter`, `working-tree-encoding` or the legacy `crlf` set to anything
  but `unset` (or `unspecified`). What converts nothing (`diff`,
  `linguist-generated`, the `binary` macro's own line) is ignored.

## `src/util/git-ignored.ts` — does git ignore everything an output writes

### Purpose

A key reads only what git lists, so an output git ignores whole never
reaches a reader's key: it is no input overlap for `vx lock` (X-54)
and no reach for the stability gate (2026-10-15). Git is asked, never
a `.gitignore` read: git alone knows every rule source (nested files,
`info/exclude`, `core.excludesFile`) and that a directory holding a
tracked file is not ignored.

### Public surface

```ts
export function ignoreProbes(
  glob: string,
): { paths: string[]; deep: boolean; dir: string; rules?: string[] } | null
export async function checkIgnore(
  cwd: string,
  paths: readonly string[],
): Promise<Set<string> | null>
export function checkIgnoreSync(cwd: string, paths: readonly string[]): Set<string> | null
export function listedSync(cwd: string, dirs: readonly string[]): string[] | null
export function skipWorktreeSync(cwd: string, rel: string): string | null
export function ignoreCaseLies(dir: string, probe: string): boolean
export function gitCaseArgs(cwd: string): readonly string[]
export function wholeIgnored(
  globs: Iterable<string>,
  ignored: ReadonlySet<string> | null,
  listedMatch: (glob: string) => boolean,
): Set<string>
export function ignoredByGlobs(
  declared: readonly string[] | undefined,
  base: string,
  root: string,
  files: readonly { readonly path: string }[],
): [abs: string, rel: string, glob: string][]
export function ignoredInputLine(task: string, rel: string, glob: string): string
```

- `ignoreProbes`: the paths that stand for a root-relative glob: its
  literal directory (`dist/**` → `dist/`), a literal path as itself, and
  for `**/<name>…` the name at the prefix and under a fresh
  `__vx_probe__/` (a directory a task may create). `deep` marks the last:
  a file below them (a tracked one, or one a `!` rule takes back) must be
  looked for in git's listing. A root glob with no literal directory
  whose one wildcard part is a name of `*` and `?` (`*.tgz`,
  `**/*.tgz`) is asked as a fresh name it matches (`__vx_probe__.tgz`,
  and under `__vx_probe__/` for `**`), deep, with `rules`: the rule texts
  git must name for each probe (the name pattern itself, `**/` or, at the
  root only, `/` before it), since `pkg-*.tgz` ignores the probe and not
  `a.tgz`. Null when no few paths stand (`*.{js,ts}`).
- `checkIgnore` / `checkIgnoreSync`: one `git check-ignore --stdin -z -v`;
  a path a `!` rule matched last is dropped, and the rule beside each
  ignored path is kept for `wholeIgnored`; null when git cannot answer
  (no work tree). Each path is sent as
  `./<path>`: git reads a line as a pathspec, so `:top/dist/` was asked as
  `top/dist/` (the command refuses `:(literal)`). `migration.ts` asks
  through `checkIgnoreSync` too.
- `listedSync`: `git ls-files --cached --others --exclude-standard` under
  `dirs`, for `vx lock`; a run reads its own enumeration instead.
- `skipWorktreeSync`: `git ls-files -t --full-name` of one path: its
  repository path when the index flags it skip-worktree (a sparse
  checkout left it out), else null. Asked only when a locked config is
  missing (`orchestrator/projects.ts`), so a run pays no spawn.
- `ignoreCaseLies`: whether `core.ignorecase=true`, which git in `dir`
  reported, is false on disk (a `.git` copied from macOS to Linux): one
  stat of `probe` with its name's case swapped, once per `dir`. Asked
  only where git's config is read anyway: the enumeration's `git var -l`
  (probe `HEAD`) and `--affected`'s `git config` (probe the root).
- `gitCaseArgs`: `-c core.ignorecase=false` for a git spawn at or under a
  directory found lying, else nothing; free until one is. Every listing
  git could fold prepends it: these checks and `listedSync`, the
  enumeration's, `--affected`'s, watch's inventory and `vx lock`'s
  discovery, so a new `a.txt` beside the tracked `A.txt` is listed.
- `wholeIgnored`: the globs whose probes git ignores, by one of their
  `rules` when they have some, and, when deep, no listed file matches.
  Undecided is not ignored.
- `ignoredByGlobs`: the files on disk under `base` that an input glob's
  last segment matches directly (`.env*`, `config/*.json`; no `**`) and
  `files` (root-relative) does not hold, one `readdir` per such glob, no
  git. A run's miss passes its keyed files, so what is left is ignored;
  `vx lock` passes the entries' literals and asks `checkIgnoreSync` of
  what is left. `ignoredInputLine` is the line both print.

Callers: `graph/task-graph.ts` `refuseOverlaps` (at `vx lock`) and
`orchestrator/stable-keys.ts` `askIgnoredOutputs` (once per run);
`ignoredByGlobs`: `orchestrator/execute-task.ts` (the miss) and
`cli/lock.ts` `unkeyedReads`.

### Tests

`tests/ignored-glob-warning.test.ts` (the miss) and
`tests/lock-unkeyed-inputs.test.ts` (`vx lock`, with the `passThrough`
note): an ignored file a glob's last segment matches is named, and not
once a literal names it, a `!` takes it back, or it is the task's own
output.

`tests/ignored-outputs.test.ts`: the rule passes and the key is taken up
front, the same before and after the build, with the rule in the root,
a parent, the project's own `.gitignore` and `.git/info/exclude`; with
the rule off the gate alone; controls: nothing ignored, a rule only one
nested directory holds, a tracked file at the output and deeper, and a
directory a `!` rule takes back are all still overlaps.

`tests/git-ignorecase.test.ts`: under a lying `core.ignorecase`, the
enumeration, `--affected` alone, and after the enumeration watch's
inventory, `listedSync` and discovery all list the case twin.

## `src/util/real-path.ts` — a path's canonical spelling

### Purpose

One canonical spelling per path, so a key that folds a path and a
caller that compares it agree (O-16: the config-eval closure once
folded one spelling while every caller compared another).

### Public surface

```ts
export function realPath(p: string): string
export function realpathOf(p: string): string
export function sameDir(a: string, b: string): boolean
```

- `realPath` — `realpathSync.native`: the OS's final path for `p`.
  Throws as `realpathSync` does.
- `realpathOf` — `realpathSync`, for a path holding a backslash too.
  Bun's realpath answers ENOENT for any such path (1.4.2); this one
  reads its links one by one instead. Used by output containment
  (`cache/inputs.ts`).
- `sameDir` — whether `a` and `b` stat to one directory (same device
  and inode): two spellings a disk folds together, such as APFS's NFC
  and NFD `café`. Linux keeps those as two directories, so git's
  enumeration (`cache/git-inputs.ts`) and `--affected`
  (`workspace/affected.ts`) match a project dir by its own spelling
  first and by its NFC name only when this holds.

### Tests

`tests/real-path.test.ts` holds `realPath(os.tmpdir())` equal to
`fs.promises.realpath` of it, and `realpathOf` through a chain of
backslash-named links agreeing with what the kernel opens.
`tests/inputs-resolution.test.ts` (an output under `dist/a\b/` is kept)
holds it through its caller. `tests/git-enum-unicode.test.ts` and
`tests/affected-unicode.test.ts` hold `sameDir` through its callers:
NFC and NFD sibling projects each keep their own files on Linux, and an
NFD spelling of the NFC dir (a link, as APFS folds the names) still
takes git's NFC paths.

## `src/util/foreign-cache-dir.ts` — a cache dir that is not vx's own

### Purpose

A `.vx/cache` linked to `~` or `..` passed every unresolved check: the
run wrote its config bundle and index there, and `vx cache clean`
deleted from it. One check, shared by the config bundle (workspace,
which writes `compiled/` before the cache opens), the cache's open and
the clear, so the refusal comes before vx's first write there.

### Public surface

```ts
export const OWN_DIR_HINT: string
export function refuseForeignCacheDir(cacheDir: string, workspaceRoot: string | undefined): void
```

- `refuseForeignCacheDir` — throws (`VX_E_CONFIG`) when `cacheDir`
  resolves, through links, to home, `/`, or a directory holding
  `workspaceRoot` or a `.git`. A directory not there yet passes (made
  as named). A pass is kept for the process, so the bundle's check and
  the cache's open cost one realpath; a refusal is decided each time.
  Asked by `buildCompiled` (`workspace/config-bytecode.ts`), every open
  of an index (`cache/cache.ts`) and `vx cache clean` before it deletes.
- `OWN_DIR_HINT` — the hint every cache-dir refusal ends with.

### Tests

`tests/cache-clean.test.ts` ("a .vx/cache linked to %s is refused by
the run and by the clear"): neither an index nor `compiled/` appears
where the link leads, and the clear deletes nothing there.

## `util/cgroup.ts` — the machine as this process may use it

Inside a container `navigator.hardwareConcurrency` and `os.totalmem()`
report the HOST's cores and RAM; what the kernel enforces is the cgroup
the job runs under — a docker executor's `--cpus` / `--memory`, a
Kubernetes limit. This module reads that. Linux only; elsewhere the
machine's own numbers stand.

### API

```ts
machineParallelism(probe?): number   // cores, capped by the CPU quota, rounded UP, ≥ 1
machineMemoryBytes(probe?): number   // os.totalmem(), capped by the memory limit
cgroupCpuQuota(probe?): number | undefined          // cores as a fraction (1.5 for --cpus=1.5)
cgroupMemoryLimitBytes(probe?): number | undefined  // bytes
interface CgroupProbe { root?: string; procSelfCgroup?: string }
```

`probe` (`{ root, procSelfCgroup }`, default `/sys/fs/cgroup` and
`/proc/self/cgroup`) exists for the fixture trees the tests build.

### Rules

- **The walk goes up.** A limit set on an ANCESTOR binds this process
  too, so each reader starts at this process's cgroup (the membership
  file names it), walks to the hierarchy's root and keeps the tightest
  value. v2 is the one unified tree at the root (`memory.max`,
  `cpu.max`); v1 is one mount per controller (`<root>/memory`,
  `<root>/cpu`, with `memory.limit_in_bytes` and `cpu.cfs_quota_us` /
  `cpu.cfs_period_us`), and a controller list like `cpu,cpuacct` still
  names its controller.
- **Unlimited binds nothing.** `max` on v2; on v1 a memory level at the
  page-counter maximum (~2^63, anything past 2^60) and a CPU quota of
  `-1`.
- **A CPU quota rounds UP.** A 1.5-core quota is two workers: the half
  core is real time, and one worker would leave it idle. Never below one.
- **Nothing here throws.** A missing membership file, absent cgroup
  files, an unreadable level, or a membership path that escapes the root
  (a foreign file) all mean "no limit", and the machine's numbers stand.

### Who reads it

`run()`'s default `concurrency`, the placement preview (`placement.ts`)
and `--concurrency <n>%` read `machineParallelism`; the doctor
(`doctor.ts`, what `vx info` reports)
reads both, with the limit itself, to name the worker count and the
memory budget with their source. Both functions are on the façade so
`@vzn/vx-history` budgets memory by `machineMemoryBytes`
instead of carrying its own walk (items 160–161).

### Tests

`tests/cgroup.test.ts`: fixture trees for both hierarchies — the
tightest level on the path, `max` / the sentinel / `-1`, the fraction,
the combined controller list, absent files, the escape — and one live
read of the machine that must not throw and never exceeds what the OS
reports. This box (2026-09-12) has a v1 memory limit of 13.3 GiB on a
15.7 GiB machine and no CPU quota, so the memory arm is proven live and
the CPU arm by fixture.

## `src/util/umask.ts` — the mode a restore gives

### Purpose

The process umask, read when a restore starts, and the permission bits a
restore gives a stored mode: minus the umask, as tar gives a non-root
user. A file on disk holds a stored mode as saved, or as a restore here
leaves it.

### Public surface

```ts
export function readUmask(): void
export function restoredMode(mode: number): number
export function modeMatches(disk: number, stored: number): boolean
```
