// Child-process invocation + resource accounting.
//
// Uses Bun.spawn so we get .resourceUsage() (cpuTime, maxRSS) after the
// process exits. cpuMs / peakRssBytes are then surfaced on RunResult and
// folded into the v11 `runs` table by the orchestrator.

import { constants as osConstants } from 'node:os'

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

export interface RunOptions {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  /** Extra args appended to the command (shell-quoted). For arg forwarding. */
  forwardArgs?: readonly string[] | undefined
  /** Called for each chunk of stdout/stderr as it arrives, for live output. */
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
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
 * `exec` REPLACES the wrapping `sh` with the program, so on a teardown
 * SIGTERM there is no intermediate shell whose death would orphan the
 * real process — the documented grandchild-orphan limitation, resolved
 * for the common single-command case (dev servers: `astro dev`, `vite`,
 * `next dev`; one-shot compilers). It also makes `resourceUsage` measure
 * the program itself rather than the shell. Compound commands, builtins,
 * and `FOO=bar cmd` forms keep the shell (compound-command grandchildren
 * still orphan on a hard programmatic kill — the residual limit every
 * non-cgroup runner shares).
 */
export function execWrap(command: string): string {
  if (SHELL_CONTROL.test(command)) return command
  const first = command.trimStart().split(/\s+/)[0] ?? ''
  if (first === '' || first.includes('=') || SHELL_BUILTINS.has(first)) return command
  return `exec ${command}`
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
 * Arm a SIGTERM timeout on a spawned child. Returns a handle whose
 * `timedOut()` reports whether the timer fired — so the caller can
 * classify the resulting SIGTERM as a real failure rather than a
 * Ctrl-C abort — and `clear()` cancels the timer once the child exits
 * on its own. A no-op (never fires, nothing to clear) when `timeoutMs`
 * is undefined.
 */
export function armTimeout(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number | undefined,
): { timedOut: () => boolean; clear: () => void } {
  if (timeoutMs === undefined) return { timedOut: () => false, clear: () => {} }
  let fired = false
  const timer = setTimeout(() => {
    fired = true
    proc.kill('SIGTERM')
  }, timeoutMs)
  return { timedOut: () => fired, clear: () => clearTimeout(timer) }
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
 * run), so this is far longer than any real drain needs.
 */
const POST_EXIT_DRAIN_MS = 250

/**
 * After the direct child has exited, wait for the stdout/stderr readers to
 * reach EOF — but bound it: an orphaned grandchild holding the pipe open would
 * hang the run forever (there is no default task timeout). If the grace expires
 * first, abort the reader signal so `streamToString` cancels its read and
 * returns whatever it captured. The timer is cleared AND unref'd so it can
 * never keep the CLI alive after the readers settle (the plugin-flush lesson).
 */
export async function drainOrAbort(streams: Promise<unknown>, ac: AbortController): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), POST_EXIT_DRAIN_MS)
    timer.unref?.()
  })
  const winner = await Promise.race([streams.then(() => 'drained' as const), deadline])
  if (timer !== undefined) clearTimeout(timer)
  if (winner === 'timeout') ac.abort()
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
  /** Captured stdout/stderr up to the moment ready resolved. */
  bufferedStdout: () => string
  bufferedStderr: () => string
  /** ms elapsed from spawn to ready (or to current time if not yet ready). */
  readyMs: () => number
}

export interface PersistentOptions extends Omit<RunOptions, 'forwardArgs'> {
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
  let bufferedStdout = ''
  let bufferedStderr = ''
  let readyAt: number | undefined

  // Pattern compiled once; thrown errors surface synchronously so the
  // caller can wrap with a user-facing message.
  const readyRe = opts.readyWhen !== undefined ? new RegExp(opts.readyWhen) : undefined

  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn(['sh', '-c', execWrap(opts.command)], {
      cwd: opts.cwd,
      env: opts.env as Record<string, string>,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      child: undefined as unknown as ReturnType<typeof Bun.spawn>,
      ready: Promise.reject(new Error(`failed to spawn persistent task: ${message}`)),
      bufferedStdout: () => '',
      bufferedStderr: () => `\n[vx] failed to spawn: ${message}\n`,
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
      // Buffers capture "up to the moment ready resolved" (their
      // documented contract) — a dev server kept alive for hours must
      // not accrete its whole log history into vx's heap.
      if (isStderr) {
        if (readyAt === undefined) bufferedStderr += chunk
        opts.onStderr?.(chunk)
      } else {
        if (readyAt === undefined) bufferedStdout += chunk
        opts.onStdout?.(chunk)
      }
      if (readyRe && readyAt === undefined) {
        fragment += chunk
        if (readyRe.test(fragment)) {
          markReady()
          fragment = ''
        } else {
          const lastNl = fragment.lastIndexOf('\n')
          if (lastNl >= 0) fragment = fragment.slice(lastNl + 1)
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
          new Error(
            `persistent task not ready within ${opts.timeoutMs}ms — ` +
              `readyWhen pattern never matched; child killed`,
          ),
        )
        child.kill('SIGTERM')
      }
    }, opts.timeoutMs)
  }

  // If the child exits BEFORE ready fires, that's a failure to start
  // — reject the ready promise so the caller can surface it.
  void child.exited.then((code) => {
    opts.liveChildren?.delete(child)
    if (readyTimer !== undefined) clearTimeout(readyTimer)
    if (readyAt === undefined) {
      rejectReady(
        new Error(
          `persistent task exited before becoming ready (exit ${code ?? '?'})` +
            (readyRe ? ` — readyWhen pattern never matched` : ''),
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
    bufferedStdout: () => bufferedStdout,
    bufferedStderr: () => bufferedStderr,
    readyMs: () => (readyAt ?? Date.now()) - start,
  }
}

export async function runCommand(opts: RunOptions): Promise<RunResult> {
  const start = Date.now()
  const fullCommand =
    opts.forwardArgs && opts.forwardArgs.length > 0
      ? opts.command + ' ' + opts.forwardArgs.map(shellQuote).join(' ')
      : opts.command

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(['sh', '-c', execWrap(fullCommand)], {
      cwd: opts.cwd,
      env: opts.env as Record<string, string>,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      exitCode: 127,
      durationMs: Date.now() - start,
      stdout: '',
      stderr: `\n[vx] failed to spawn: ${message}\n`,
    }
  }

  opts.liveChildren?.add(proc)
  const timeout = armTimeout(proc, opts.timeoutMs)
  const ac = new AbortController()
  const streams = Promise.all([
    streamToString(proc.stdout, opts.onStdout, ac.signal),
    streamToString(proc.stderr, opts.onStderr, ac.signal),
  ])
  // Gate on the child's own exit, not on stream EOF: an orphaned grandchild
  // can keep the pipe open past the child's exit (a timeout SIGTERM leaves the
  // grandchild alive; a NORMAL exit of `server & echo up` does too), so EOF may
  // never arrive. A timeout aborts the readers at once; otherwise drainOrAbort
  // lets a clean exit EOF immediately and only cuts off a stuck reader after a
  // brief grace — without this the run hangs forever.
  await proc.exited
  timeout.clear()
  if (timeout.timedOut()) ac.abort()
  else await drainOrAbort(streams, ac)
  const [stdout, stderr] = await streams
  opts.liveChildren?.delete(proc)
  const exitCode = proc.exitCode ?? (proc.signalCode ? signalExitCode(proc.signalCode) : 1)
  return {
    exitCode,
    durationMs: Date.now() - start,
    stdout,
    stderr,
    ...(proc.signalCode ? { signal: proc.signalCode } : {}),
    ...(timeout.timedOut() ? { timedOut: true } : {}),
    ...resourceUsageToCpuRss(proc.resourceUsage()),
  }
}

/**
 * Drain a `Bun.spawn` stdout/stderr stream while invoking the live
 * callback per UTF-8 chunk. Returns the full accumulated string.
 */
export async function streamToString(
  stream: ReadableStream<Uint8Array> | number | undefined,
  onChunk?: (s: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  // Bun.spawn types stdout/stderr as `ReadableStream | number | undefined`
  // — the `number` is for inheritance modes, only present when the caller
  // chose `'inherit'` instead of `'pipe'`. We only call this with `'pipe'`,
  // so the runtime value is always a ReadableStream; the `number` branch
  // is unreachable but typed.
  if (!stream || typeof stream === 'number') return ''
  let full = ''
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
      full += chunk
      onChunk?.(chunk)
    }
    const tail = decoder.decode()
    if (tail.length > 0) {
      full += tail
      onChunk?.(tail)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
  return full
}

/**
 * Pull CPU + RSS out of Bun's resourceUsage() shape into our schema's
 * shape (ms + bytes). Returns an empty object when usage isn't available
 * (e.g., the platform didn't expose rusage), so the orchestrator records
 * NULLs in the runs table for those tasks.
 */
export function resourceUsageToCpuRss(
  usage: ReturnType<ReturnType<typeof Bun.spawn>['resourceUsage']>,
  platform: NodeJS.Platform = process.platform,
): { cpuMs?: number; peakRssBytes?: number } {
  if (!usage) return {}
  // cpuTime.total is microseconds as a bigint → ms.
  const cpuMs = Number(usage.cpuTime.total) / 1000
  // maxRSS is the raw kernel `ru_maxrss`, whose UNIT IS PLATFORM-SPECIFIC and
  // Bun does NOT normalize it:
  //   • Linux   → kilobytes  (multiply by 1024 for bytes)
  //   • macOS / BSD → bytes  (already bytes; do NOT multiply)
  //   • Windows → bytes (PeakWorkingSetSize)
  // Treating macOS's byte value as KB inflates peak RSS by 1024× — e.g. a
  // real 460 MB showed up as 460 GB. Convert per platform.
  const peakRssBytes = platform === 'linux' ? usage.maxRSS * 1024 : usage.maxRSS
  return { cpuMs, peakRssBytes }
}
