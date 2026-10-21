// A distributed run end to end on `local()`: the agents are processes in
// their own git worktrees, joined through the adapter's loopback relay. The
// orchestrator keeps no share (`local: 0`), so every task that may leave
// this machine runs on an agent.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
export default { plugins: [dte({ agents: { small: { max: 2, cpu: 1 } }, adapter: local(), local: 0 })] }
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
