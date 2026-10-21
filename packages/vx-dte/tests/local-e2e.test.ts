// A distributed run end to end on `local()`: the agents are processes in
// their own git worktrees, joined through the adapter's loopback relay. The
// orchestrator keeps no share (`local: 0`), so every task that may leave
// this machine runs on an agent.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'

const DTE = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')
// Relative, as this package's test task sets it: each agent's worktree
// must still share the run's store.
process.env['VX_CACHE_DIR'] = '.vx/cache'
let root = ''

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-e2e-'))
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws', private: true }),
    '.gitignore': 'out\n.vx/cache\n',
    '.vx/workspace.mjs': `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ agents: { small: { max: 2, cpu: 1, memory: '1GB' } }, adapter: local(), local: 0 })] }
`,
    'a/vx.config.mjs': `export default { name: 'a', tasks: { gen: {
  exec: { command: 'mkdir -p out && echo made > out/a.txt' },
  inputs: { files: ['vx.config.mjs'] },
  cache: { outputs: { files: ['out/**'] } },
} } }
`,
    'b/vx.config.mjs': `export default { name: 'b', tasks: {
  use: {
    dependsOn: ['a#gen'],
    exec: { command: 'mkdir -p out && cat ../a/out/a.txt > out/b.txt && pwd > out/where.txt && echo used' },
    inputs: { files: ['vx.config.mjs'] },
    cache: { outputs: { files: ['out/**'] } },
  },
  fail: { exec: { command: 'echo oops >&2; exit 3' } },
  slow: { exec: { command: 'touch started && sleep 60' } },
  once: { exec: { command: 'if [ -e ../once ]; then echo again; else touch ../once && sleep 60; fi' } },
  env: { exec: {
    command: 'echo "shown=\${VX_E2E_SHOWN:-none} hidden=\${VX_E2E_HIDDEN:-none}"',
    env: { passThrough: ['VX_E2E_SHOWN'] },
  } },
} }
`,
    // Wide, then a two-task lull, then wide again.
    'c/vx.config.mjs': `const t = (dependsOn) => ({ exec: { command: 'sleep 0.3' }, dependsOn })
export default { name: 'c', tasks: {
  x1: t([]), x2: t([]), y1: t(['x1', 'x2']), y2: t(['y1']), z1: t(['y2']), z2: t(['y2']),
} }
`,
  }
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), text)
  }
  const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: root })
  git('init', '-q')
  expect(vx(['lock']).exitCode).toBe(0)
  git('add', '-A')
  git('-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'i')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** `vx`, a distributed run when `run` names one. */
function vx(args: string[], run?: string, extra: Record<string, string> = {}) {
  const { VX_DTE_RUN: _, ...env } = process.env
  return Bun.spawnSync([process.execPath, CORE_BIN, ...args], {
    cwd: root,
    env: { ...env, ...(run === undefined ? {} : { VX_DTE_RUN: run }), NO_COLOR: '1', ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

it('runs a task on an agent with its dependency’s outputs, and brings its outputs back', async () => {
  // a#gen runs here, so its outputs must travel to the agent that runs b#use.
  expect(vx(['run', 'a#gen']).exitCode).toBe(0)
  const first = vx(['run', 'b#use'], 'e2e-1')
  const out = first.stdout.toString() + first.stderr.toString()
  expect([first.exitCode, out]).toEqual([0, expect.stringContaining('used')])
  expect(await readFile(path.join(root, 'b/out/b.txt'), 'utf8')).toBe('made\n')
  const where = (await readFile(path.join(root, 'b/out/where.txt'), 'utf8')).trim()
  expect(where).not.toBe(path.join(root, 'b'))
  expect(where.endsWith(`${path.sep}b`)).toBe(true)
  // Saved here as the run's own: the next run is all hits.
  const second = vx(['run', 'b#use'], 'e2e-2')
  expect(second.exitCode).toBe(0)
  expect(second.stdout.toString()).toContain('local 2✓')
  // Nothing to run: no agent starts.
  expect(second.stdout.toString()).not.toContain('agents')
}, 60_000)

// `--force` reads no hit, but an agent's entry is the run's own work: it
// came back unreadable and every task failed.
it('brings an agent’s outputs back under --force', async () => {
  const run = vx(['run', 'b#use', '--force'], 'e2e-force')
  const out = run.stdout.toString() + run.stderr.toString()
  expect([run.exitCode, out]).toEqual([0, expect.stringContaining('used')])
  expect(await readFile(path.join(root, 'b/out/b.txt'), 'utf8')).toBe('made\n')
}, 60_000)

// An idle agent stays while the rest of the run will need it again: one
// left in the lull and another started for the wide part after it.
it('keeps an idle agent the rest of the run needs again', () => {
  const r = vx(['run', 'c#z1', 'c#z2'], 'e2e-lull')
  const out = r.stdout.toString() + r.stderr.toString()
  expect([r.exitCode, out]).toEqual([0, expect.stringContaining('small#2')])
  expect(out).not.toContain('small#3')
}, 60_000)

// The agent running a task is killed: the task runs again on one the run
// starts in its place, where it once waited for it forever.
it('runs a task again on a new agent when its agent is killed', async () => {
  const { VX_DTE_RUN: _, ...env } = process.env
  const run = Bun.spawn([process.execPath, CORE_BIN, 'run', 'b#once'], {
    cwd: root,
    env: { ...env, VX_DTE_RUN: 'e2e-kill', NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // `../once` from the agent's worktree of b: its worktree root.
  const marker = async (): Promise<boolean> => {
    const base = await readdir(os.tmpdir()).catch(() => [] as string[])
    for (const d of base.filter((n) => n.startsWith('vx-dte-') && !n.startsWith('vx-dte-e2e')))
      for (const i of await readdir(path.join(os.tmpdir(), d)).catch(() => [] as string[]))
        if (await Bun.file(path.join(os.tmpdir(), d, i, 'once')).exists()) return true
    return false
  }
  for (let i = 0; i < 200 && !(await marker()); i++) await Bun.sleep(100)
  const agents = Bun.spawnSync(['pgrep', '-P', String(run.pid), '-f', 'dte agent'])
  const pids = agents.stdout.toString().trim().split('\n').filter(Boolean)
  expect(pids).toHaveLength(1)
  process.kill(Number(pids[0]), 'SIGKILL')
  const out = (await new Response(run.stdout).text()) + (await new Response(run.stderr).text())
  expect([await run.exited, out]).toEqual([0, expect.stringContaining('again')])
}, 90_000)

// The orchestrator sends each task its own resolved env, and an agent adds
// only its host names and PATH: a name the task does not pass through
// reaches it from neither machine's env.
it('gives a task on an agent only the env it passes through', () => {
  const r = vx(['run', 'b#env'], 'e2e-env', { VX_E2E_SHOWN: 'yes', VX_E2E_HIDDEN: 'leak' })
  const out = r.stdout.toString() + r.stderr.toString()
  expect([r.exitCode, out]).toEqual([0, expect.stringContaining('shown=yes hidden=none')])
  expect(out).toContain('agents')
}, 60_000)

it('fails a task that fails on its agent, with its output', () => {
  const r = vx(['run', 'b#fail'], 'e2e')
  expect(r.exitCode).not.toBe(0)
  expect(r.stdout.toString() + r.stderr.toString()).toContain('oops')
}, 60_000)

it('runs on an agent started by hand, with no adapter, under one name on both sides', async () => {
  const { createRelay } = await import('@vzn/vx-dte-relay')
  const relay = createRelay()
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => relay.fetch(r) })
  const url = `http://127.0.0.1:${server.port}`
  try {
    await writeFile(
      path.join(root, '.vx/workspace.mjs'),
      `import { dte } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ relay: ${JSON.stringify(url)}, local: 0 })] }
`,
    )
    Bun.spawnSync(
      ['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qam', 'r'],
      {
        cwd: root,
      },
    )
    expect(vx(['run', 'a#gen']).exitCode).toBe(0)
    const { VX_DTE_RUN: _, ...env } = process.env
    const agent = Bun.spawn([process.execPath, CORE_BIN, 'dte', 'agent'], {
      cwd: root,
      env: { ...env, VX_DTE_RUN: 'hand', VX_DTE_SECRET: 'hand-secret', NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // Async: the relay is served by this process.
    const run = Bun.spawn([process.execPath, CORE_BIN, 'run', 'b#use'], {
      cwd: root,
      env: { ...env, VX_DTE_RUN: 'hand', VX_DTE_SECRET: 'hand-secret', NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = await new Response(run.stdout).text()
    expect([await run.exited, out]).toEqual([
      0,
      expect.stringMatching(/└─ b#use ── .*success  on agent#1/),
    ])
    expect(out).toMatch(/agents +agent#1  online  1 done  \d+c\/[\d.]+G$/m)
    const own = await new Response(agent.stdout).text()
    expect(await agent.exited).toBe(0)
    expect(own).toMatch(/agent +agent#1/)
    expect(own).toContain('✓ b#use')
  } finally {
    relay.close()
    await server.stop(true)
  }
}, 60_000)

/** The pids under `pid`, by `ps`. */
function descendants(pid: number): number[] {
  const rows = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=']).stdout.toString().trim().split('\n')
  const kids = new Map<number, number[]>()
  for (const r of rows) {
    const [c, p] = r.trim().split(/\s+/).map(Number)
    kids.set(p!, [...(kids.get(p!) ?? []), c!])
  }
  const out: number[] = []
  for (let i = -1; i < out.length; i++) out.push(...(kids.get(i < 0 ? pid : out[i]!) ?? []))
  return out
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

it.each(['SIGHUP', 'SIGINT'] as const)(
  'a %s to the run stops its agents and removes their worktrees',
  async (sig) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-sig-'))
    try {
      const { VX_DTE_RUN: _, ...env } = process.env
      const run = Bun.spawn([process.execPath, CORE_BIN, 'run', 'b#slow'], {
        cwd: root,
        env: { ...env, VX_DTE_RUN: 'sig', NO_COLOR: '1', TMPDIR: tmp },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      // The agent's worktree is `<tmp>/vx-dte-*/1`; the task touches `started` in it.
      const started = async (): Promise<boolean> => {
        for (const d of await readdir(tmp)) {
          if (await Bun.file(path.join(tmp, d, '1', 'b', 'started')).exists()) return true
        }
        return false
      }
      for (let i = 0; i < 600 && !(await started()); i++) await Bun.sleep(50)
      expect(await started()).toBe(true)
      const tree = descendants(run.pid)
      expect(tree.length).toBeGreaterThan(0)
      run.kill(sig)
      expect(await run.exited).not.toBe(0)
      for (let i = 0; i < 100 && tree.some(alive); i++) await Bun.sleep(50)
      expect(tree.filter(alive)).toEqual([])
      expect((await readdir(tmp)).filter((d) => d.startsWith('vx-dte-'))).toEqual([])
      const trees = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd: root })
      expect(trees.stdout.toString().match(/^worktree /gm)).toHaveLength(1)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  },
  60_000,
)

it('says why an agent never joined, and fails the run when none can', async () => {
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ agents: { small: { max: 1, cpu: 1, memory: '1GB' } }, adapter: local({ prepare: 'echo no bun here >&2; exit 4' }) })] }
`,
  )
  Bun.spawnSync(
    ['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qam', 'p'],
    {
      cwd: root,
    },
  )
  const r = vx(['run', 'a#gen'], 'e2e-none')
  const out = r.stdout.toString() + r.stderr.toString()
  expect(r.exitCode).not.toBe(0)
  expect(out).toMatch(/small#1  failed  prepare exited 4: no bun here/)
  expect(out).toContain('no agent could start')
  const log = out.match(/\(log: ([^)]+)\)/)?.[1]
  expect(log === undefined ? '' : await readFile(log, 'utf8')).toBe('no bun here\n')
  if (log !== undefined) await rm(path.dirname(log), { recursive: true, force: true })
}, 60_000)

it('agents run the tracked files as they are, uncommitted changes too', async () => {
  // Committed without dte(), as a user trying it first: a worktree of HEAD
  // alone had no `dte` verb, so every agent exited.
  const ws = path.join(root, '.vx/workspace.mjs')
  const withDte = await readFile(ws, 'utf8')
  await writeFile(ws, 'export default { plugins: [] }\n')
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], { cwd: root })
  git('commit', '-qam', 'no dte')
  await writeFile(ws, withDte)
  const r = vx(['run', 'a#gen'], 'e2e-dirty')
  const out = r.stdout.toString() + r.stderr.toString()
  expect([r.exitCode, out]).toEqual([0, expect.stringContaining('on small#')])
  // Nothing was committed or reset to get there.
  expect(git('status', '--porcelain').stdout.toString()).toContain(' M .vx/workspace.mjs\n')
}, 60_000)
