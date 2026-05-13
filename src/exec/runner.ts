// Child-process invocation + resource accounting.
//
// Uses Bun.spawn so we get .resourceUsage() (cpuTime, maxRSS) after the
// process exits. cpuMs / peakRssBytes are then surfaced on RunResult and
// folded into the v11 `runs` table by the orchestrator.

export interface RunResult {
  exitCode: number
  durationMs: number
  stdout: string
  stderr: string
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
}

export function shellQuote(arg: string): string {
  if (arg === '') return `''`
  if (/^[A-Za-z0-9_\-.,/=:@%+]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
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
    child = Bun.spawn(['sh', '-c', opts.command], {
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
      resolveReady()
    }
  }

  // Stream readers — match against `readyWhen` line-by-line. Each
  // stream owns a pending fragment so a regex match isn't missed
  // across chunk boundaries.
  const consumeChunks = async (
    stream: ReadableStream<Uint8Array> | number | undefined,
    isStderr: boolean,
  ): Promise<void> => {
    if (!stream || typeof stream === 'number') return
    let fragment = ''
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        if (isStderr) {
          bufferedStderr += chunk
          opts.onStderr?.(chunk)
        } else {
          bufferedStdout += chunk
          opts.onStdout?.(chunk)
        }
        if (readyRe && readyAt === undefined) {
          fragment += chunk
          const lastNl = fragment.lastIndexOf('\n')
          const scanRegion = lastNl >= 0 ? fragment.slice(0, lastNl) : ''
          if (readyRe.test(scanRegion)) {
            markReady()
            fragment = ''
          } else if (lastNl >= 0) {
            fragment = fragment.slice(lastNl + 1)
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  // Wire up readers. We deliberately don't await them — they run for
  // the child's lifetime. The `ready` promise resolves out-of-band.
  void consumeChunks(child.stdout, false)
  void consumeChunks(child.stderr, true)

  // If the child exits BEFORE ready fires, that's a failure to start
  // — reject the ready promise so the caller can surface it.
  void child.exited.then((code) => {
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
    proc = Bun.spawn(['sh', '-c', fullCommand], {
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

  const [stdout, stderr] = await Promise.all([
    streamToString(proc.stdout, opts.onStdout),
    streamToString(proc.stderr, opts.onStderr),
  ])
  await proc.exited
  const exitCode = proc.exitCode ?? (proc.signalCode ? 130 : 1)
  return {
    exitCode,
    durationMs: Date.now() - start,
    stdout,
    stderr,
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
): { cpuMs?: number; peakRssBytes?: number } {
  if (!usage) return {}
  // cpuTime.total is microseconds as a bigint; maxRSS is kilobytes (Linux)
  // or bytes (macOS depending on Bun version) — Bun normalizes to KB on
  // Linux/macOS, returning the kernel value directly. We treat it as KB
  // consistently with Bun's docs and convert to bytes.
  const cpuMs = Number(usage.cpuTime.total) / 1000
  const peakRssBytes = usage.maxRSS * 1024
  return { cpuMs, peakRssBytes }
}
