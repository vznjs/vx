// Child-process invocation + resource accounting.
//
// Uses Bun.spawn so we get .resourceUsage() (cpuTime, maxRSS) after the
// process exits. cpuMs / peakRssBytes are then surfaced on RunResult and
// folded into the v11 `runs` table by the orchestrator.

import { existsSync, readFileSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { executablePath, isExecutableMissing, killGraceMs } from '../util/index.js'
import {
  closeSignalChannel,
  holdGroups,
  killTree,
  markGroupIfGone,
  releaseGroup,
  signalThrough,
  spawnGuarded,
  untilGroupsGone,
} from './kill-tree.js'

export interface RunResult {
  exitCode: number
  durationMs: number
  stdout: string
  stderr: string
  /** The signal that killed the child, if any (Bun's `signalCode`).
   *  SIGINT/SIGTERM here means a Ctrl-C / shutdown teardown — the
   *  orchestrator reverts such a task to aborted, not failed. */
  signal?: string
  /** True when vx's own `timeout` timer fired and SIGTERMed the child.
   *  Distinguishes a timeout (a real `failed`) from a Ctrl-C shutdown
   *  SIGTERM (which the orchestrator reverts to `aborted`). */
  timedOut?: boolean
  /** Total user+system CPU time for the child, in milliseconds. */
  cpuMs?: number
  /** Peak resident set size for the child, in bytes. */
  peakRssBytes?: number
}

/**
 * Which streams `runCommand` retains into `RunResult.stdout` / `.stderr`.
 * Both default to true — the primitive's contract is that those fields hold
 * what the child wrote, and a field that silently lies is worse than one
 * that costs. A caller that will not READ a stream opts down here: the live
 * `onStdout` / `onStderr` callbacks still fire for every chunk, so only the
 * retained string is dropped. Retaining a stream nothing reads costs its
 * full byte size in heap, for the whole task.
 */
export interface CaptureConfig {
  stdout?: boolean
  stderr?: boolean
}

export interface RunOptions {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  /** Extra args appended to the command (shell-quoted). For arg forwarding. */
  forwardArgs?: readonly string[] | undefined
  /** Called for each chunk of stdout/stderr as it arrives, for live output. */
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  /** See `CaptureConfig`. Omitted → both streams retained (today's behaviour). */
  capture?: CaptureConfig
  /**
   * Upper bound (ms) on the child's run time. When it elapses the
   * child is SIGTERMed and the result is flagged `timedOut`. Undefined
   * → no limit.
   */
  timeoutMs?: number
  /**
   * Run-scoped registry of in-flight subprocesses. The child is added
   * on spawn and removed once it exits, so the orchestrator's signal
   * handler can SIGTERM everything still alive mid-run.
   */
  liveChildren?: Set<ReturnType<typeof Bun.spawn>>
}

export function shellQuote(arg: string): string {
  if (arg === '') return `''`
  if (/^[A-Za-z0-9_\-.,/=:@%+]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

// Any shell control/expansion character means the wrapping `sh` has real
// work to do (chaining, pipes, redirects, globbing, variables, subshells,
// backgrounding) and must stay resident.
const SHELL_CONTROL = /[&|;<>(){}$`\n\\!*?~]/

// Shell builtins run INSIDE sh — `exec <builtin>` fails (there's no
// external `exit`/`true`/`echo`). They also spawn no grandchild, so
// there's nothing to gain by exec-wrapping them.
const SHELL_BUILTINS = new Set([
  'exit',
  'true',
  'false',
  ':',
  'echo',
  'cd',
  'export',
  'set',
  'unset',
  'read',
  'test',
  '[',
  'printf',
  'pwd',
  'umask',
  'wait',
  'trap',
  'eval',
  'exec',
  'source',
  '.',
  'alias',
  'unalias',
  'type',
  'hash',
  'jobs',
  'kill',
  'shift',
  'return',
  'break',
  'continue',
  'local',
  'readonly',
  'times',
  'ulimit',
  'command',
  'builtin',
  'let',
  'declare',
  'typeset',
])

/**
 * Prepend `exec ` to a command that is a single EXTERNAL program (no
 * shell control characters, not a builtin, no leading env-assignment).
 * `exec` REPLACES the wrapping `sh` with the program: `resourceUsage`
 * measures the program itself rather than the shell, a signal lands on
 * the program directly, and there is one process fewer per task.
 * (Until kill-tree.ts this was also what kept a single command's real
 * process from orphaning on a teardown; the process group covers every
 * shape now.) Compound commands, builtins, and `FOO=bar cmd` forms keep
 * the shell.
 */
export function execWrap(command: string): string {
  const first = execWord(command)
  return first === undefined ? command : `exec ${command}`
}

/**
 * The one program a command runs when it is a plain `word args…` — the
 * word `execWrap` execs, and the word the shell names in "not found" when
 * it exits 127. Undefined for a pipeline, a builtin, an assignment: there
 * the 127 could be any segment's.
 */
export function execWord(command: string): string | undefined {
  if (SHELL_CONTROL.test(command)) return undefined
  const first = command.trimStart().split(/\s+/)[0] ?? ''
  if (first === '' || first.includes('=') || SHELL_BUILTINS.has(first)) return undefined
  return first
}

/**
 * POSIX shells report signal death as 128 + signal number (SIGTERM →
 * 143, SIGKILL → 137). Bun gives us the signal NAME; `os.constants`
 * maps it to the platform-correct number. Unknown names fall back to
 * 130 (128 + SIGINT).
 */
export function signalExitCode(signal: string): number {
  const num = (osConstants.signals as Partial<Record<string, number>>)[signal]
  return num === undefined ? 130 : 128 + num
}

/**
 * The reverse: the signal an exit above 128 stands for (137 → SIGKILL),
 * by the platform's numbering; undefined for a plain exit. The shell
 * reports 128 + n for a death by signal n, so the read is the shell's
 * convention, not proof — a command may exit 137 on its own.
 */
export function exitSignal(code: number): string | undefined {
  if (code <= 128 || code >= 128 + 65) return undefined
  const signals = osConstants.signals as Partial<Record<string, number>>
  const num = code - 128
  return Object.keys(signals).find((k) => signals[k] === num && !SIGNAL_ALIASES.has(k))
}

// Second names for one number (SIGIOT = SIGABRT, SIGPOLL = SIGIO); the
// canonical one reads.
const SIGNAL_ALIASES = new Set(['SIGIOT', 'SIGPOLL', 'SIGCLD'])

/**
 * Grace after a timeout SIGTERM before escalating to SIGKILL — a child that
 * ignores SIGTERM must still be bounded. Matches the persistent-shutdown grace.
 */
const TIMEOUT_SIGKILL_GRACE_MS = 2000

/**
 * Arm a SIGTERM timeout on a spawned child. Returns a handle whose
 * `timedOut()` reports whether the timer fired — so the caller can
 * classify the resulting SIGTERM as a real failure rather than a
 * Ctrl-C abort — and `settle()`, awaited once the child has exited:
 * it cancels the timers and, when the timeout fired, waits out the rest
 * of the grace for the child's GROUP and SIGKILLs whoever is left. The
 * shell dying on the SIGTERM is not the tree dying: a backgrounded
 * process that ignores it lived on under init after vx exited (nx#11782's
 * sibling, reproduced on vx 2026-09-24). A no-op (never fires, nothing
 * to settle) when `timeoutMs` is undefined.
 */
export function armTimeout(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number | undefined,
): { timedOut: () => boolean; settle: () => Promise<void> } {
  if (timeoutMs === undefined) return { timedOut: () => false, settle: async () => {} }
  let firedAt: number | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const graceMs = killGraceMs(TIMEOUT_SIGKILL_GRACE_MS)
  const timer = setTimeout(() => {
    firedAt = Date.now()
    killTree(proc, 'SIGTERM')
    // Escalate to SIGKILL after a grace: a child that TRAPS+IGNORES SIGTERM
    // (`trap '' TERM`) would otherwise defeat the timeout entirely and hang
    // `await proc.exited` until its natural exit — there is no run-level
    // timeout, so a wedged child hangs the whole run forever. Mirrors the
    // end-of-run persistent-shutdown escalation. Unref'd so it never keeps
    // the CLI alive.
    killTimer = setTimeout(() => killTree(proc, 'SIGKILL'), graceMs)
    killTimer.unref?.()
  }, timeoutMs)
  return {
    timedOut: () => firedAt !== undefined,
    settle: async () => {
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (firedAt === undefined) return
      const left = await untilGroupsGone([proc], Math.max(0, firedAt + graceMs - Date.now()))
      for (const child of left) killTree(child, 'SIGKILL')
    },
  }
}

/**
 * Grace after the direct child exits before we abort the stdout/stderr readers.
 * The pipe reaches EOF only when EVERY write-end fd is closed, so a task that
 * backgrounds a process inheriting fd 1/2 (`server & echo up` — `execWrap`
 * leaves compound commands as `sh -c`, so `sh` exits while the grandchild holds
 * the pipe) never EOFs. On a clean exit with no lingering writer the pipe EOFs
 * at once, so the readers win this race immediately and normal tasks pay
 * nothing; only a stuck reader waits out the grace. Residual buffered output is
 * bounded by the OS pipe buffer (streamToString drains continuously DURING the
 * run), so this is far longer than any real drain needs. What the leftover
 * process writes after the bound is lost, and `POST_EXIT_CUT_LINE` says so.
 */
const POST_EXIT_DRAIN_MS = 250

/**
 * The line a task's frame gets when the drain bound cut its pipes. The cut
 * was silent: a backgrounded child's late output vanished from the frame and
 * the cached replay with no word (nx#35302 reproduced on vx, 2026-09-24).
 * The bound stays, since it is what keeps a leftover server from hanging the
 * run; the line makes the loss visible.
 */
export const POST_EXIT_CUT_LINE =
  `\n[vx] output after the task's shell exited was cut: a process it left running ` +
  `still held its stdout/stderr ${POST_EXIT_DRAIN_MS} ms later\n`

/**
 * After the direct child has exited, wait for the stdout/stderr readers to
 * reach EOF — but bound it: an orphaned grandchild holding the pipe open would
 * hang the run forever (there is no default task timeout). If the grace expires
 * first, abort the reader signal so `streamToString` cancels its read and
 * returns whatever it captured, and resolve true: the caller adds
 * `POST_EXIT_CUT_LINE` to the task's stderr. The timer is unref'd so it can
 * never keep the CLI alive after the readers settle (the plugin-flush
 * lesson); it is not cleared, because a late resolve on a race already won
 * by the drain changes nothing (item 636 deleted the clear and nothing
 * reddened).
 */
export async function drainOrAbort(
  streams: Promise<unknown>,
  ac: AbortController,
): Promise<boolean> {
  const deadline = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), POST_EXIT_DRAIN_MS).unref?.()
  })
  const winner = await Promise.race([streams.then(() => 'drained' as const), deadline])
  if (winner === 'timeout') ac.abort()
  return winner === 'timeout'
}

/**
 * Upper bound on the text a `readyWhen` regex is tested against. The matcher
 * normally keeps only the trailing partial line, so this bites only when the
 * stream has no line breaks at all.
 */
const READY_MATCH_WINDOW_CHARS = 64 * 1024

/**
 * Why a persistent task never became ready — the reason every label and
 * record reads instead of a fabricated exit (item 270). `exitCode` is the
 * child's own when it exited before the pattern matched.
 */
export class PersistentReadyError extends Error {
  readonly reason: 'timeout' | 'exited' | 'spawn'
  readonly exitCode: number | undefined
  constructor(message: string, reason: 'timeout' | 'exited' | 'spawn', exitCode?: number) {
    super(message)
    this.name = 'PersistentReadyError'
    this.reason = reason
    this.exitCode = exitCode
  }
}

export interface PersistentSpawn {
  /** Underlying Bun subprocess so the orchestrator can SIGTERM it later. */
  child: ReturnType<typeof Bun.spawn>
  /**
   * Resolves once the task is considered "ready":
   *   - immediately on successful spawn when no `readyWhen` is given,
   *   - on the first stdout/stderr line that matches `readyWhen`.
   * Rejects with the spawn error if the child fails to start.
   */
  ready: Promise<void>
  /** ms elapsed from spawn to ready (or to current time if not yet ready). */
  readyMs: () => number
}

// `capture` is a `runCommand` concept: a persistent task never returns a
// RunResult (it is handed back at READY, still running), so there is no
// retained string to opt out of. Its output reaches the caller only through
// the live callbacks.
export interface PersistentOptions extends Omit<RunOptions, 'forwardArgs' | 'capture'> {
  /**
   * String regex. The first stdout/stderr line that matches signals
   * "ready". Undefined → ready immediately on spawn.
   */
  readyWhen?: string
  /**
   * Bound the readiness wait: if `readyWhen` hasn't matched within
   * this window, the child is SIGTERMed and `ready` rejects. Only
   * meaningful together with `readyWhen` (a ready-on-spawn task
   * resolves before the timer can fire).
   */
  timeoutMs?: number
  /**
   * Spawn it with fd 3 as its signal channel and route its polite signals
   * there (`signalThrough`): a Linux sandboxed command, whose group signal
   * would kill bwrap instead (`wrapSandboxedCommand`'s `forwardsSignals`).
   */
  signalChannel?: boolean
}

/**
 * Spawn a long-running task. Unlike `runCommand`, this returns once
 * the task is *ready* (per `readyWhen`) — not when it exits. The
 * caller owns the returned `child` and must SIGTERM it during
 * cleanup. Stdout/stderr keep streaming into the live `onStdout` /
 * `onStderr` callbacks for the whole lifetime of the child.
 */
export function runPersistent(opts: PersistentOptions): PersistentSpawn {
  const start = Date.now()
  let readyAt: number | undefined

  // Pattern compiled once; thrown errors surface synchronously so the
  // caller can wrap with a user-facing message.
  const readyRe = opts.readyWhen !== undefined ? new RegExp(opts.readyWhen) : undefined

  let child: ReturnType<typeof Bun.spawn>
  try {
    child = spawnGuarded(() =>
      Bun.spawn([executablePath('sh'), '-c', execWrap(opts.command)], {
        argv0: 'sh',
        cwd: opts.cwd,
        env: opts.env as Record<string, string>,
        // A pipe vx holds and never writes: stdin stays open while vx
        // lives and ends when it does. A dev server that exits on stdin
        // EOF (esbuild --watch, Vite's case in turborepo#8915) became ready
        // and exited 0 under 'ignore'. Not the terminal: several servers
        // would steal each other's keystrokes, and a CI's /dev/null stdin
        // is the same EOF. The one-shot spawn below keeps 'ignore', so a
        // task that reads stdin can never hang CI.
        stdio:
          opts.signalChannel === true ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
        // Its own session and process group, so a kill reaches what it
        // forked (kill-tree.ts). stdin is a pipe, so a background group
        // never stops on a terminal read.
        detached: true,
      }),
    )
    if (opts.signalChannel === true) {
      signalThrough(child, child.stdio[3] as number)
      const spawned = child
      void spawned.exited.then(() => closeSignalChannel(spawned))
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      child: undefined as unknown as ReturnType<typeof Bun.spawn>,
      ready: Promise.reject(
        new PersistentReadyError(`failed to spawn persistent task: ${message}`, 'spawn'),
      ),
      readyMs: () => Date.now() - start,
    }
  }

  let resolveReady!: () => void
  let rejectReady!: (err: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const markReady = (): void => {
    if (readyAt === undefined) {
      readyAt = Date.now()
      if (readyTimer !== undefined) clearTimeout(readyTimer)
      resolveReady()
    }
  }

  // Stream readers. Each stream owns a pending fragment so a regex
  // match isn't missed across chunk boundaries. The match runs over
  // the WHOLE fragment, including a trailing partial line — prompt-
  // style markers ("Listening on :3000" with no newline) would never
  // resolve ready under line-by-line-only matching. Complete lines
  // that didn't match are discarded after each test to bound memory.
  const consumeChunks = async (
    stream: ReadableStream<Uint8Array> | number | undefined,
    isStderr: boolean,
  ): Promise<void> => {
    if (!stream || typeof stream === 'number') return
    let fragment = ''
    const handleChunk = (chunk: string): void => {
      if (chunk.length === 0) return
      // Chunks are forwarded, never retained. The one consumer of a
      // persistent task's text is the logger, which keeps its OWN bounded
      // tail fed from these same callbacks (registered at taskStart, so it
      // covers the pre-ready window too) — a second copy here was read by
      // nobody.
      if (isStderr) opts.onStderr?.(chunk)
      else opts.onStdout?.(chunk)
      if (readyRe && readyAt === undefined) {
        fragment += chunk
        if (readyRe.test(fragment)) {
          markReady()
          fragment = ''
        } else {
          const lastNl = fragment.lastIndexOf('\n')
          if (lastNl >= 0) fragment = fragment.slice(lastNl + 1)
          // Dropping complete lines assumes the stream HAS line breaks.
          // `\r`-only output — a progress bar, a spinner — is one endless
          // line, so the trim above never fires and the fragment becomes a
          // third unbounded accumulator (measured 464 MiB in 6 s, and the
          // per-chunk `test` over an ever-growing string makes it quadratic
          // in CPU too). Keep the most RECENT window: a match may span the
          // chunk boundary, and no readiness marker is anywhere near this
          // long.
          if (fragment.length > READY_MATCH_WINDOW_CHARS) {
            fragment = fragment.slice(fragment.length - READY_MATCH_WINDOW_CHARS)
          }
        }
      }
    }
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        handleChunk(decoder.decode(value, { stream: true }))
      }
      // Flush any undecoded multi-byte tail when the stream closes so
      // the buffered text (and a final-fragment match) stay complete.
      handleChunk(decoder.decode())
    } finally {
      reader.releaseLock()
    }
  }

  // Wire up readers. We deliberately don't await them — they run for
  // the child's lifetime. The `ready` promise resolves out-of-band.
  void consumeChunks(child.stdout, false)
  void consumeChunks(child.stderr, true)

  opts.liveChildren?.add(child)

  // Readiness deadline. Reject FIRST so the failure reads as a
  // timeout, then SIGTERM — the exit handler's later reject is a
  // no-op on the settled promise. Cleared the moment ready fires so
  // a healthy server is never killed by a stale timer.
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  if (readyRe && opts.timeoutMs !== undefined) {
    readyTimer = setTimeout(() => {
      if (readyAt === undefined) {
        rejectReady(
          new PersistentReadyError(
            `persistent task not ready within ${opts.timeoutMs}ms — ` +
              `readyWhen pattern never matched; child killed`,
            'timeout',
          ),
        )
        // Listed on the group guard until the SIGKILL: the shell may die
        // on the SIGTERM and let the group go while the server runs out
        // the grace, and a vx that exits inside it (the timer is unref'd)
        // leaves the server to the guard (kill-tree.ts, item 865).
        const letGo = holdGroups([child])
        killTree(child, 'SIGTERM')
        // Same escalation as `armTimeout`: a server that traps TERM and
        // never became ready is not in the persistent registry, so nothing
        // else would ever kill it — it outlived the run under init.
        const killTimer = setTimeout(() => {
          killTree(child, 'SIGKILL')
          letGo()
        }, killGraceMs(TIMEOUT_SIGKILL_GRACE_MS))
        killTimer.unref?.()
      }
    }, opts.timeoutMs)
  }

  // If the child exits BEFORE ready fires, that's a failure to start
  // — reject the ready promise so the caller can surface it.
  void child.exited.then((code) => {
    opts.liveChildren?.delete(child)
    markGroupIfGone(child)
    releaseGroup(child)
    if (readyTimer !== undefined) clearTimeout(readyTimer)
    if (readyAt === undefined) {
      rejectReady(
        new PersistentReadyError(
          `persistent task exited before becoming ready (exit ${code ?? '?'})` +
            (readyRe ? ` — readyWhen pattern never matched` : ''),
          'exited',
          code ?? undefined,
        ),
      )
    }
  })

  // No readyWhen → ready immediately. We still wire the readers above
  // so output streams during the task's lifetime.
  if (!readyRe) markReady()

  return {
    child,
    ready,
    readyMs: () => (readyAt ?? Date.now()) - start,
  }
}

/**
 * What a task's frame says when `Bun.spawn` itself threw. The text goes
 * through `onStderr` AND onto the result: the orchestrator retains no
 * stderr (execute-task's capture), so a reason that only sat on the result
 * reached nobody — a box without `sh` showed "failed (exit 127)" under a
 * bare `$ <command>` and nothing else (2026-09-16). An ENOENT with the
 * working directory in place is the shell; Bun's own text names the rest.
 */
export function spawnFailureText(err: unknown, cwd: string, what = 'task'): string {
  if (isExecutableMissing(err) && existsSync(cwd)) {
    return `\n[vx] vx runs each task with sh -c: failed to spawn 'sh' (working dir: ${cwd}). Install a POSIX sh and re-run.\n`
  }
  const message = err instanceof Error ? err.message : String(err)
  return `\n[vx] failed to spawn ${what}: ${message}\n`
}

export async function runCommand(opts: RunOptions): Promise<RunResult> {
  const start = Date.now()
  const fullCommand =
    opts.forwardArgs && opts.forwardArgs.length > 0
      ? opts.command + ' ' + opts.forwardArgs.map(shellQuote).join(' ')
      : opts.command

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = spawnGuarded(() =>
      Bun.spawn([executablePath('sh'), '-c', execWrap(fullCommand)], {
        argv0: 'sh',
        cwd: opts.cwd,
        env: opts.env as Record<string, string>,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        // Its own session and process group, so a kill reaches what it
        // forked (kill-tree.ts). stdin is ignored, so a background group
        // never stops on a terminal read.
        detached: true,
      }),
    )
  } catch (err) {
    const stderr = spawnFailureText(err, opts.cwd)
    opts.onStderr?.(stderr)
    return { exitCode: 127, durationMs: Date.now() - start, stdout: '', stderr }
  }

  opts.liveChildren?.add(proc)
  const timeout = armTimeout(proc, opts.timeoutMs)
  const ac = new AbortController()
  const streams = Promise.all([
    streamToString(proc.stdout, opts.onStdout, ac.signal, opts.capture?.stdout ?? true),
    streamToString(proc.stderr, opts.onStderr, ac.signal, opts.capture?.stderr ?? true),
  ])
  // Gate on the child's own exit, not on stream EOF: an orphaned grandchild
  // can keep the pipe open past the child's exit (a timeout SIGTERM leaves the
  // grandchild alive; a NORMAL exit of `server & echo up` does too), so EOF may
  // never arrive. A timeout aborts the readers at once; otherwise drainOrAbort
  // lets a clean exit EOF immediately and only cuts off a stuck reader after a
  // brief grace — without this the run hangs forever.
  await proc.exited
  await timeout.settle()
  let cut = false
  if (timeout.timedOut()) ac.abort()
  else cut = await drainOrAbort(streams, ac)
  const [stdout, streamed] = await streams
  if (cut) opts.onStderr?.(POST_EXIT_CUT_LINE)
  const stderr = cut ? streamed + POST_EXIT_CUT_LINE : streamed
  opts.liveChildren?.delete(proc)
  releaseGroup(proc)
  const exitCode = proc.exitCode ?? (proc.signalCode ? signalExitCode(proc.signalCode) : 1)
  return {
    exitCode,
    durationMs: Date.now() - start,
    stdout,
    stderr,
    ...(proc.signalCode ? { signal: proc.signalCode } : {}),
    ...(timeout.timedOut() ? { timedOut: true } : {}),
    ...resourceUsageToCpuRss(proc.resourceUsage(), ownRssHighWater()),
  }
}

/**
 * This process's own RSS high-water mark, in bytes: the floor under which
 * a child's `ru_maxrss` says nothing about the child. Linux folds the
 * forking parent's high-water mark into the child's figure at exec (a
 * forked child starts with its parent's pages; `exec_mmap` keeps the old
 * mm's peak), so a task lighter than vx itself reads vx's footprint —
 * `true` read 44 MB through vx while its shell's `VmHWM` was 1.9 MB, and
 * 300 MB allocated in the parent made `true` read 328 MB (2026-09-12).
 * Read after the child exits so it covers the whole task's span (the mark
 * is monotonic). Linux reads `VmHWM`; elsewhere the current RSS is the
 * bound in hand.
 */
export function ownRssHighWater(): number {
  if (process.platform === 'linux') {
    try {
      const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8'))
      if (m !== null) return Number(m[1]) * 1024
    } catch {
      // /proc unreadable: fall through to the current RSS.
    }
  }
  return process.memoryUsage.rss()
}

/**
 * What a task's captured output keeps: the first `CAPTURE_HEAD_CHARS` and
 * the last `CAPTURE_TAIL_CHARS` characters, the dropped middle counted and
 * named where it was. The live stream is never bounded — every byte still
 * reaches the terminal as the task writes it — only the copy vx retains
 * for the cache entry and its replay. Unbounded, a task printing 200 MB
 * cost vx 620 MB of RSS on the miss AND on every hit, and its stdout sat
 * whole in `cache.db` (measured 2026-09-16); a realistic chatty suite is
 * 5–20 MB, so the bound is above what a replay is worth reading anyway.
 */
export const CAPTURE_HEAD_CHARS = 8 * 1024 * 1024
export const CAPTURE_TAIL_CHARS = 8 * 1024 * 1024

const mib = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MiB`

/** The line that stands where the dropped middle was. */
export function droppedOutputLine(dropped: number): string {
  return (
    `\n[vx] ${mib(dropped)} of output not kept — vx keeps the first ${mib(CAPTURE_HEAD_CHARS)} ` +
    `and the last ${mib(CAPTURE_TAIL_CHARS)} of a task's output for its cache entry and replay\n`
  )
}

/**
 * A head-and-tail accumulator: the head fills once, the tail is a ring
 * of chunks trimmed from the front, so memory is bounded by the two
 * limits plus one chunk whatever the task prints.
 */
class BoundedCapture {
  private head = ''
  private readonly tail: string[] = []
  private tailLen = 0
  private dropped = 0

  push(chunk: string): void {
    if (this.head.length < CAPTURE_HEAD_CHARS) {
      const room = CAPTURE_HEAD_CHARS - this.head.length
      if (chunk.length <= room) {
        this.head += chunk
        return
      }
      this.head += chunk.slice(0, room)
      chunk = chunk.slice(room)
    }
    this.tail.push(chunk)
    this.tailLen += chunk.length
    while (this.tailLen > CAPTURE_TAIL_CHARS) {
      const first = this.tail[0]!
      const excess = this.tailLen - CAPTURE_TAIL_CHARS
      if (first.length <= excess) {
        this.tail.shift()
        this.tailLen -= first.length
        this.dropped += first.length
      } else {
        this.tail[0] = first.slice(excess)
        this.tailLen -= excess
        this.dropped += excess
      }
    }
  }

  text(): string {
    const tail = this.tail.join('')
    return this.dropped === 0
      ? this.head + tail
      : this.head + droppedOutputLine(this.dropped) + tail
  }
}

/**
 * Drain a `Bun.spawn` stdout/stderr stream while invoking the live
 * callback per UTF-8 chunk. Returns the accumulated string, or `''` when
 * `retain` is false — the stream is still fully drained and every chunk
 * still reaches `onChunk`; only the retained copy is dropped, so a caller
 * that will not read it does not pay its byte size in heap.
 */
export async function streamToString(
  stream: ReadableStream<Uint8Array> | number | undefined,
  onChunk?: (s: string) => void,
  signal?: AbortSignal,
  retain = true,
): Promise<string> {
  // Bun.spawn types stdout/stderr as `ReadableStream | number | undefined`
  // — the `number` is for inheritance modes, only present when the caller
  // chose `'inherit'` instead of `'pipe'`. We only call this with `'pipe'`,
  // so the runtime value is always a ReadableStream; the `number` branch
  // is unreachable but typed.
  if (!stream || typeof stream === 'number') return ''
  const full = new BoundedCapture()
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  // On abort, cancel the read so a pending `reader.read()` resolves
  // `done` and we return whatever we captured. Needed for the timeout
  // path: SIGTERMing `sh` doesn't close the pipe if an orphaned
  // grandchild still holds the write end, so EOF never arrives — the
  // abort breaks us out instead of hanging the run.
  const onAbort = (): void => void reader.cancel().catch(() => {})
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (retain) full.push(chunk)
      onChunk?.(chunk)
    }
    const tail = decoder.decode()
    if (tail.length > 0) {
      if (retain) full.push(tail)
      onChunk?.(tail)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
  return full.text()
}

/**
 * How far above the parent's own mark a child's `ru_maxrss` must read to
 * count as the child's. A light child inherits the parent's footprint at
 * exec, so its reading sits ON the floor by construction, and the kernel's
 * per-thread RSS counters lag by up to 64 pages between syncs — a `true`
 * spawned from a 300 MB parent read 376 MB against a floor a few pages
 * lower on one CI run in twelve (2026-09-16). Four MiB is above any
 * accounting jitter and below what any reservation resolves (64 MB steps).
 */
export const RSS_FLOOR_SLACK_BYTES = 4 * 1024 * 1024

const MIN_PLAUSIBLE_PEAK_BYTES = 1024 * 1024

/**
 * A child's `maxRSS` in BYTES, whatever unit the runtime reported it in.
 *
 * Bun >= 1.4 — vx's declared floor — normalizes the kernel's `ru_maxrss`
 * (kilobytes on Linux, bytes on macOS) before handing it over, and this file
 * used to state that as "BYTES on every platform". It is not true of every
 * Bun: 1.3.11 passes the raw kilobytes through, so every peak read 1024×
 * SMALL, fell under the parent floor and recorded nothing. The opposite
 * mistake is in this file's own history — an unconditional ×1024 on Linux
 * made a 64 MB suite read as 64 GB and, once reservations were learned from
 * that history, ran every task alone (2026-09-12). Both directions come from
 * asserting a platform unit instead of deciding it from the number in hand.
 *
 * The number decides it. No process peaks under a megabyte — a bare `true`
 * costs a couple — so a reading below that is not bytes, it is the kernel's
 * kilobytes, and multiplying is right by the same margin that makes the test
 * safe. A real byte figure is never near the threshold, and neither is a real
 * kilobyte one: the two live 1024× apart.
 *
 * Calibrating against this process's OWN `process.resourceUsage()` was the
 * first attempt and it was wrong: that is the node-compatible API, which
 * reports kilobytes even where `Subprocess.resourceUsage()` reports bytes, so
 * the ratio read 1024 on a runtime already handing over bytes and doubled the
 * old 64 GB defect. It passed here, where both APIs use kilobytes, and turned
 * CI red on both platforms (2026-09-20). Compare like with like, or do not
 * compare at all.
 */
export function peakRssBytes(maxRSS: number): number {
  return maxRSS > 0 && maxRSS < MIN_PLAUSIBLE_PEAK_BYTES ? maxRSS * 1024 : maxRSS
}

/**
 * Pull CPU + RSS out of Bun's resourceUsage() shape into our schema's
 * shape (ms + bytes). Returns an empty object when usage isn't available
 * (e.g., the platform didn't expose rusage), so the orchestrator records
 * NULLs in the runs table for those tasks.
 */
export function resourceUsageToCpuRss(
  usage: ReturnType<ReturnType<typeof Bun.spawn>['resourceUsage']>,
  /** The parent's own high-water mark (`ownRssHighWater`); a peak at or under it is inherited, not the child's, and is not reported. */
  floorBytes = 0,
): { cpuMs?: number; peakRssBytes?: number } {
  if (!usage) return {}
  // cpuTime.total is microseconds as a bigint → ms.
  const cpuMs = Number(usage.cpuTime.total) / 1000
  // `maxRSS` in whatever unit this runtime reports, in bytes by the rule
  // above. `tests/runner.test.ts` allocates a known number of bytes and
  // reads the peak back within a bounded factor of it, which is the
  // end-to-end check on both the unit and the floor.
  // A reading at or within the slack of the parent's own mark is the
  // parent's (see `ownRssHighWater`, `RSS_FLOOR_SLACK_BYTES`): the child's
  // peak is unknown, bounded by it.
  const peak = peakRssBytes(usage.maxRSS)
  return peak > floorBytes + RSS_FLOOR_SLACK_BYTES ? { cpuMs, peakRssBytes: peak } : { cpuMs }
}
