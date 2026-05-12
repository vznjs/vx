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
