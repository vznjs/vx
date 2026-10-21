// One task's command on this machine, as an agent (or the orchestrator's own
// share of the run) runs it: `sh -c`, both streams kept, a timeout, a stop.

export interface CommandResult {
  exitCode: number
  durationMs: number
  stdout: string
  stderr: string
  signal?: string
  timedOut?: boolean
  cpuMs?: number
  spawnFailed?: true
}

export async function runCommand(opts: {
  command: string
  cwd: string
  env: Record<string, string | undefined>
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  onSpawn?: (pid: number) => void
}): Promise<CommandResult> {
  const started = performance.now()
  let proc
  try {
    proc = Bun.spawn(['sh', '-c', opts.command], {
      cwd: opts.cwd,
      env: opts.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (err) {
    return {
      exitCode: 127,
      durationMs: performance.now() - started,
      stdout: '',
      stderr: `${(err as Error).message}\n`,
      spawnFailed: true,
    }
  }
  opts.onSpawn?.(proc.pid)
  let timedOut = false
  const stop = (): void => proc.kill('SIGTERM')
  const timer =
    opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          stop()
        }, opts.timeoutMs)
  opts.signal?.addEventListener('abort', stop)
  const read = async (s: ReadableStream<Uint8Array>, on?: (c: string) => void) => {
    let all = ''
    const dec = new TextDecoder()
    for await (const chunk of s) {
      const text = dec.decode(chunk, { stream: true })
      all += text
      on?.(text)
    }
    return all
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    read(proc.stdout, opts.onStdout),
    read(proc.stderr, opts.onStderr),
    proc.exited,
  ])
  clearTimeout(timer)
  opts.signal?.removeEventListener('abort', stop)
  const usage = proc.resourceUsage()
  return {
    exitCode,
    durationMs: performance.now() - started,
    stdout,
    stderr,
    ...(proc.signalCode === null ? {} : { signal: proc.signalCode }),
    ...(timedOut ? { timedOut } : {}),
    ...(usage === undefined
      ? {}
      : // maxRSS is bytes or kilobytes by runtime (core's item 437): left out.
        { cpuMs: Number(usage.cpuTime.user + usage.cpuTime.system) / 1000 }),
  }
}
