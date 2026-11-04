// Every tool runs inside bubblewrap: the whole filesystem read-only except
// the case's own directory, no network, its own PID namespace (a daemon a
// tool starts dies with the run), and a fresh home inside the case. So a
// tool cannot read another case's cache, keep state between cases, reach a
// remote cache, or leave a process behind.

import { mkdirSync } from 'node:fs'
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
}

/**
 * `argv` started in `cwd` (inside `root`), able to write only under `bind`
 * (`root` or a directory holding it); killing it ends its whole PID namespace
 * unless `hostProc`.
 */
export function spawnSandboxed(
  root: string,
  cwd: string,
  argv: string[],
  env: Record<string, string>,
  timeoutMs?: number,
  /**
   * The host's /proc and PID namespace in place of fresh ones: a tool that
   * sandboxes its own tasks (vx's bwrap) cannot mount a proc inside a fresh
   * one, and the PIDs it reads there must be its own. `--die-with-parent`
   * still ends the run's process when the harness goes.
   */
  hostProc = false,
  bind = root,
): Running {
  if (BWRAP === null)
    throw new Error('bwrap not found: the conformance suite runs every tool sandboxed')
  const home = caseHome(root)
  mkdirSync(home, { recursive: true })
  const proc = Bun.spawn(
    [
      BWRAP,
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
      ...argv,
    ],
    {
      cwd,
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: home,
        XDG_CACHE_HOME: path.join(home, '.cache'),
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_DATA_HOME: path.join(home, '.local/share'),
        TMPDIR: '/tmp',
        LANG: 'C.UTF-8',
        // Git as it ships: no user config changes how a tool reads the tree.
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        ...env,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    },
  )
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
  return { proc, out: () => stdout + stderr, drained }
}

/** `argv` run in `cwd` (inside `root`), able to write only under `bind`; see `spawnSandboxed`. */
export async function sandboxed(
  root: string,
  cwd: string,
  argv: string[],
  env: Record<string, string>,
  timeoutMs = 120_000,
  hostProc = false,
  bind = root,
): Promise<Result> {
  const started = performance.now()
  const { proc, out, drained } = spawnSandboxed(root, cwd, argv, env, timeoutMs, hostProc, bind)
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
