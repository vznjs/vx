// Every tool runs inside bubblewrap: the whole filesystem read-only except
// the case's own directory, no network, its own PID namespace (a daemon a
// tool starts dies with the run), and a fresh home inside the case. So a
// tool cannot read another case's cache, keep state between cases, reach a
// remote cache, or leave a process behind. The one exception is a tool that
// isolates its own work (Nix's build sandbox, `Adapter.sandboxed`): it runs
// unboxed, with the same home, and every process it starts ends with the run.

import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface Result {
  exit: number
  out: string
  /** Killed at `timeoutMs`: the run did not end on its own. */
  timedOut?: boolean
}

const BWRAP = Bun.which('bwrap')

/** Whether this machine can sandbox a run. Without bwrap no case runs: an unsandboxed tool could escape it. */
export function sandboxAvailable(): boolean {
  return BWRAP !== null
}

/** The home every tool sees: inside the case, so it starts empty and goes with it. */
export function caseHome(root: string): string {
  return path.join(root, '.home')
}

/** A sandboxed process that keeps running: its output so far, and the process itself (bwrap). */
export interface Running {
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  out: () => string
  /** Resolves once both streams closed. */
  drained: Promise<void>
  /** Ends the run: bwrap with its PID namespace, or every process of an unboxed run. */
  kill: () => void
}

export interface SpawnOptions {
  /** Killed after this long. */
  timeoutMs?: number
  /**
   * The host's /proc and PID namespace in place of fresh ones: a tool that
   * sandboxes its own tasks (vx's bwrap) cannot mount a proc inside a fresh
   * one, and the PIDs it reads there must be its own. `--die-with-parent`
   * still ends the run's process when the harness goes.
   */
  hostProc?: boolean
  /** The directory the run may write: `root` or one holding it. */
  bind?: string
  /** `false`: no bubblewrap, for a tool whose own sandbox isolates what it runs. */
  boxed?: boolean
}

/** What every process of an unboxed run inherits, so one that left its group or session is still found. */
export const TAG = 'VX_CONFORMANCE_RUN'

/**
 * The processes of an unboxed run: `pid`, each carrying its tag, and all they
 * started (a Nix build's sandbox, whose environment is its own, and which
 * outlives a killed nix-build).
 */
export function runProcesses(pid: number, tag: string): number[] {
  const children = new Map<number, number[]>()
  const found = [pid]
  for (const name of readdirSync('/proc')) {
    const p = Number(name)
    if (!Number.isInteger(p) || p === process.pid) continue
    try {
      const stat = readFileSync(`/proc/${p}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      children.set(ppid, [...(children.get(ppid) ?? []), p])
      if (readFileSync(`/proc/${p}/environ`, 'latin1').includes(tag)) found.push(p)
    } catch {}
  }
  const all = new Set<number>()
  for (let next = found; next.length > 0;) {
    for (const p of next) all.add(p)
    next = next.flatMap((p) => children.get(p) ?? []).filter((c) => !all.has(c))
  }
  return [...all]
}

/** Kills every process of an unboxed run, until none is left to find. */
function killRun(pid: number, tag: string): void {
  for (let round = 0; round < 5; round++) {
    let killed = 0
    for (const p of runProcesses(pid, tag))
      try {
        process.kill(p, 'SIGKILL')
        killed++
      } catch {}
    if (killed === 0) return
  }
}

/**
 * `argv` started in `cwd` (inside `root`), able to write only under `bind`;
 * killing it ends its whole PID namespace unless `hostProc`. Unboxed, all
 * it started is killed when it exits or times out.
 */
export function spawnSandboxed(
  root: string,
  cwd: string,
  argv: string[],
  env: Record<string, string>,
  { timeoutMs, hostProc = false, bind = root, boxed = true }: SpawnOptions = {},
): Running {
  if (boxed && BWRAP === null)
    throw new Error('bwrap not found: the conformance suite runs every tool sandboxed')
  const home = caseHome(root)
  // Unboxed, /tmp is the host's: the case's own keeps one case's files from another's.
  const tmp = boxed ? '/tmp' : path.join(home, 'tmp')
  mkdirSync(tmp === '/tmp' ? home : tmp, { recursive: true })
  const tag = `${TAG}=${crypto.randomUUID()}`
  const boxing = [
    BWRAP!,
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    ...(hostProc ? ['--bind', '/proc', '/proc'] : ['--proc', '/proc']),
    '--tmpfs',
    '/tmp',
    '--bind',
    bind,
    bind,
    '--unshare-net',
    ...(hostProc ? [] : ['--unshare-pid']),
    '--unshare-ipc',
    '--die-with-parent',
    '--new-session',
    '--chdir',
    cwd,
  ]
  const proc = Bun.spawn(boxed ? [...boxing, ...argv] : argv, {
    cwd,
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: home,
      XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local/share'),
      TMPDIR: tmp,
      LANG: 'C.UTF-8',
      // Git as it ships: no user config changes how a tool reads the tree.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...(boxed ? {} : { [TAG]: tag.slice(TAG.length + 1) }),
      ...env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(boxed && timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
  })
  const kill = () => (boxed ? proc.kill('SIGKILL') : killRun(proc.pid, tag))
  if (!boxed) {
    const timer = timeoutMs === undefined ? undefined : setTimeout(kill, timeoutMs)
    // What the run left behind ends with it, as in a PID namespace; the pipes it holds close.
    void proc.exited.then(() => {
      clearTimeout(timer)
      kill()
    })
  }
  let stdout = ''
  let stderr = ''
  const drain = async (stream: ReadableStream<Uint8Array>, add: (s: string) => void) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) add(decoder.decode(chunk, { stream: true }))
  }
  const drained = Promise.all([
    drain(proc.stdout, (s) => (stdout += s)),
    drain(proc.stderr, (s) => (stderr += s)),
  ]).then(() => undefined)
  return { proc, out: () => stdout + stderr, drained, kill }
}

/** `argv` run in `cwd` (inside `root`); see `spawnSandboxed`. */
export async function sandboxed(
  root: string,
  cwd: string,
  argv: string[],
  env: Record<string, string>,
  opts: SpawnOptions = {},
): Promise<Result> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  const started = performance.now()
  const { proc, out, drained } = spawnSandboxed(root, cwd, argv, env, { ...opts, timeoutMs })
  const [exit] = await Promise.all([proc.exited, drained])
  if (process.env['CONFORMANCE_DEBUG'])
    console.error(
      `[${Math.round(performance.now() - started)} ms] ${argv.join(' ')} → ${exit}\n${out()}`,
    )
  const timedOut = proc.signalCode !== null && performance.now() - started >= timeoutMs
  return {
    exit: proc.signalCode ? 128 : exit,
    out: out(),
    ...(timedOut ? { timedOut } : {}),
  }
}
