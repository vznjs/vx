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
function vx(args: string[], run?: string) {
  const { VX_DTE_RUN: _, ...env } = process.env
  return Bun.spawnSync([process.execPath, CORE_BIN, ...args], {
    cwd: root,
    env: { ...env, ...(run === undefined ? {} : { VX_DTE_RUN: run }), NO_COLOR: '1' },
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
      env: { ...env, VX_DTE_RUN: 'hand', NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // Async: the relay is served by this process.
    const run = Bun.spawn([process.execPath, CORE_BIN, 'run', 'b#use'], {
      cwd: root,
      env: { ...env, VX_DTE_RUN: 'hand', NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = await new Response(run.stdout).text()
    expect([await run.exited, out]).toEqual([
      0,
      expect.stringMatching(/└─ b#use ── .*success  on agent·1/),
    ])
    expect(out).toMatch(/agents +agent·1  online  1 done  \d+c\/[\d.]+G real$/m)
    const own = await new Response(agent.stdout).text()
    expect(await agent.exited).toBe(0)
    expect(own).toMatch(/agent +agent·1/)
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
