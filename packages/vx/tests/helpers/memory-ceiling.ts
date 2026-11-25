// The memory-ceiling suites' harness (tests/memory-ceiling-*.unsafe.test.ts).
// Each row spawns the real CLI with tests/helpers/memory-probe.ts preloaded
// and reads the process's own peak RSS. A ceiling is what a scenario may
// ADD to `floor()`, the same CLI over a workspace that does almost nothing,
// read in the same file: a faster or slower machine moves both alike.
//
// #5466 read task output on a thread with no backpressure; a task printing
// 3 GB took vx from 100 MB to 1.5 GB of RSS while every unit test stayed
// green, because none measured a whole vx process.

import { mkdtempSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { localWorkspaceSource } from './local-workspace.js'
import { addProject, gitInitCommit, makeWorkspace } from './workspace.js'

export const linux = process.platform === 'linux'
export const MIB = 1024 * 1024
export const TIMEOUT = 120_000
const BIN = path.resolve(import.meta.dir, '..', '..', 'src', 'bin.ts')
const PROBE = path.resolve(import.meta.dir, 'memory-probe.ts')
const ENV = { CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1', VX_RUN_KILL_GRACE: '200ms' }
/** Printable lines, as a real log is; NUL bytes skip the line handling. */
export const text = (bytes: number): string =>
  `yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c ${bytes}`

const roots: string[] = []
const live = new Set<ReturnType<typeof Bun.spawn>>()
// Builds a test left running: removing their directory under them let the
// next addProject's mkdir make it again (CI 2026-11-25, `vx-mem-*` left).
const building = new Set<Promise<unknown>>()
let removing = false
/**
 * Each suite's afterEach: kills the vx a failed or timed-out test left
 * running, then removes its directories (ENOTEMPTY retries: a timed-out
 * body may still be writing). A hook registered here would bind to only
 * the first file importing this module in a process.
 */
export async function removeScratch(): Promise<void> {
  for (const p of live) p.kill('SIGKILL')
  await Promise.all([...live].map((p) => p.exited))
  live.clear()
  removing = true
  try {
    await Promise.allSettled([...building])
  } finally {
    removing = false
  }
  const dirs = roots.splice(0)
  await Promise.all(dirs.map((r) => rm(r, { recursive: true, force: true, maxRetries: 5 })))
}

/** A directory removed when the test ends. */
export function scratch(dir: string): string {
  roots.push(dir)
  return dir
}

/** A committed, locked workspace of `projects` (name → vx.config.mjs source). */
export async function workspace(
  projects: Record<string, string>,
  opts: {
    plugins?: readonly string[]
    fields?: string
    edges?: Record<string, string[]>
    /** Source files per project, `src/a.txt` and `src/f<i>.txt` (default 1). */
    files?: number
  } = {},
): Promise<string> {
  const p = build(projects, opts)
  building.add(p)
  return p.finally(() => building.delete(p))
}

async function build(
  projects: Record<string, string>,
  opts: Parameters<typeof workspace>[1] = {},
): Promise<string> {
  const halt = (): void => {
    if (removing) throw new Error('the test ended while its workspace was built')
  }
  // Registered before the first await: a test that times out inside
  // makeWorkspace never gets its path back to register.
  const dir = scratch(mkdtempSync(path.join(os.tmpdir(), 'vx-mem-')))
  const root = await makeWorkspace({
    dir,
    prefix: 'ws-',
    git: false,
    ...(opts.edges ? { edges: opts.edges } : {}),
  })
  if (opts.plugins !== undefined)
    await writeFile(
      path.join(root, '.vx', 'workspace.mjs'),
      localWorkspaceSource(opts.plugins, '', undefined, opts.fields),
    )
  for (const [name, config] of Object.entries(projects)) {
    halt()
    await addProject(root, name, {
      config,
      files: Object.fromEntries([
        ['src/a.txt', name],
        ...Array.from({ length: Math.max(0, (opts.files ?? 1) - 1) }, (_, i) => [
          `src/f${i}.txt`,
          `${i}`,
        ]),
      ]),
    })
  }
  halt()
  gitInitCommit(root)
  const lock = Bun.spawnSync([process.execPath, BIN, 'lock'], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ...process.env, ...ENV, HOME: root, VX_LOCK_REVIEW_FILES: 'false' },
  })
  if (lock.exitCode !== 0) throw new Error(`vx lock failed: ${lock.stderr.toString()}`)
  return root
}

/** One task `out` running `command` over `src/**`; `extra` is spliced into the task. */
export const task = (command: string, extra = ''): string =>
  `export default { tasks: { out: { exec: { command: ${JSON.stringify(command)} }, inputs: { files: ['src/**'] }${extra} } } }\n`

export interface Spawned {
  proc: ReturnType<typeof Bun.spawn>
  probe: string
  /** The last 200 000 characters of stdout. */
  out: () => string
  err: () => string
  /** Task frames closed (`└─ `), counted as they pass. */
  closed: () => number
}

let seq = 0

/**
 * `vx <args>` in `root`, its own HOME, so its cache is the workspace's own.
 * `consumer` is a shell command vx's stdout is piped into instead of this
 * process, which reads a pipe as fast as it fills, so a slow reader has to
 * be another process. The exit is then vx's (pipefail).
 */
export function spawnVx(root: string, args: readonly string[], consumer?: string): Spawned {
  const probe = path.join(root, `.mem-${seq++}`)
  const vx = [process.execPath, '--preload', PROBE, BIN, ...args]
  const cmd =
    consumer === undefined
      ? vx
      : ['bash', '-c', `set -o pipefail; "$@" | ${consumer}`, 'bash', ...vx]
  const proc = Bun.spawn(cmd, {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...ENV, HOME: root, VX_TEST_MEMORY_PROBE: probe },
  })
  live.add(proc)
  void proc.exited.then(() => live.delete(proc))
  let out = ''
  let err = ''
  let closed = 0
  let carry = ''
  const keep = (s: string, add: string): string => (s + add).slice(-200_000)
  void (async () => {
    const dec = new TextDecoder()
    for await (const chunk of proc.stdout) {
      const t = dec.decode(chunk, { stream: true })
      const seen = carry + t
      closed += seen.split('└─ ').length - 1
      carry = seen.slice(-2)
      out = keep(out, t)
    }
  })()
  void (async () => {
    const dec = new TextDecoder()
    for await (const chunk of proc.stderr) err = keep(err, dec.decode(chunk, { stream: true }))
  })()
  return { proc, probe, out: () => out, err: () => err, closed: () => closed }
}

/** The peak RSS of a spawned vx in MiB, once it exits `want`. */
export async function peakMib(s: Spawned, want = 0): Promise<number> {
  const code = await s.proc.exited
  if (code !== want)
    throw new Error(`vx exited ${code}:\n${s.out().slice(-4000)}\n${s.err().slice(-4000)}`)
  const m = /peak_kib=(\d+)/.exec(await readFile(s.probe, 'utf8'))
  if (m === null) throw new Error('the probe wrote no peak')
  return Math.round(Number(m[1]) / 1024)
}

/** `vx run <args>`: its peak RSS in MiB and what it printed. */
export async function run(
  root: string,
  args: readonly string[],
  exit = 0,
): Promise<{ peak: number; out: string }> {
  const s = spawnVx(root, ['run', ...args])
  const peak = await peakMib(s, exit)
  return { peak, out: s.out() }
}

/**
 * The CLI's peak over a one-task workspace that runs `true`, the highest
 * of three: what each scenario's ceiling is added to.
 */
export async function floor(): Promise<number> {
  const root = await workspace({ a: task('true') })
  let high = 0
  for (let i = 0; i < 3; i++) high = Math.max(high, (await run(root, ['a#out', '--no-cache'])).peak)
  return high
}
