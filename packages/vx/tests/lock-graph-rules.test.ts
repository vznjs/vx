// The graph rules (`run.rules`) are checked by `vx lock` and `vx lock
// --check`; a frozen run trusts the lock and checks them no more (owner,
// 2026-10-13). `run.frozen` is on under CI, and a frozen run with no lock
// writes one first.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { checkGraph, type TaskNode } from '../src/graph/index.js'
import { TIMEOUT } from './helpers/orchestrator-fixture.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const roots: string[] = []

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

const task = (outputs: string[], inputs: string[] = ['src/**']) =>
  `{ exec: { command: 'true' }, cache: { inputs: { files: ${JSON.stringify(inputs)} }, outputs: { files: ${JSON.stringify(outputs)} } } }`

/** A git workspace with one project `a` whose tasks are `tasks` (source text). */
async function workspace(tasks: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-lock-rules-'))
  roots.push(root)
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
  )
  await Bun.write(path.join(root, '.vx/workspace.mjs'), 'export default {}\n')
  const dir = path.join(root, 'packages', 'a')
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'src', 'x'), 'x')
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(path.join(dir, 'vx.config.mjs'), `export default { tasks: ${tasks} }\n`)
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
  Bun.spawnSync({
    cmd: ['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'],
    cwd: root,
  })
  return root
}

function vx(root: string, args: string[], env: Record<string, string | undefined> = {}) {
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env: { ...process.env, CI: '', VX_RUN_FROZEN: '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

const OVERLAP = `{ a: ${task(['dist/**'])}, b: ${task(['dist/**'])} }`

describe('vx lock checks the graph rules', () => {
  it(
    'two tasks writing the same output: the lock is refused and not written',
    async () => {
      const root = await workspace(OVERLAP)
      const r = vx(root, ['lock'])
      expect({
        code: r.code,
        said:
          r.err.includes('.vx/lock.json not written') && r.err.includes('both declare the output'),
        written: existsSync(path.join(root, '.vx/lock.json')),
      }).toEqual({ code: 1, said: true, written: false })
    },
    TIMEOUT,
  )

  it(
    '--check reports a rule the configs now break',
    async () => {
      const root = await workspace(`{ a: ${task(['dist/**'])} }`)
      expect(vx(root, ['lock']).code).toBe(0)
      await writeFile(
        path.join(root, 'packages/a/vx.config.mjs'),
        `export default { tasks: ${OVERLAP} }\n`,
      )
      const r = vx(root, ['lock', '--check'])
      expect({ code: r.code, said: r.err.includes('both declare the output') }).toEqual({
        code: 1,
        said: true,
      })
    },
    TIMEOUT,
  )
})

describe('run.frozen', () => {
  it(
    'is on under CI: a run with no lock writes one, and VX_RUN_FROZEN=false or --no-frozen turn it off',
    async () => {
      const root = await workspace(`{ a: ${task(['dist/**'])} }`)
      const lockFile = path.join(root, '.vx/lock.json')
      expect(vx(root, ['run', 'a', '--all'], { CI: '1', VX_RUN_FROZEN: 'false' }).code).toBe(0)
      expect(existsSync(lockFile)).toBe(false)
      expect(vx(root, ['run', 'a', '--all', '--no-frozen'], { CI: '1' }).code).toBe(0)
      expect(existsSync(lockFile)).toBe(false)
      expect(vx(root, ['run', 'a', '--all']).code).toBe(0)
      expect(existsSync(lockFile)).toBe(false)
      const r = vx(root, ['run', 'a', '--all'], { CI: '1' })
      expect({ code: r.code, locked: r.out.includes('vx lock: locked 1 project config') }).toEqual({
        code: 0,
        locked: true,
      })
      expect(existsSync(lockFile)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a frozen run with no lock and a broken rule fails before any task',
    async () => {
      const root = await workspace(OVERLAP)
      const r = vx(root, ['run', 'a', '--all', '--frozen'])
      expect({
        code: r.code,
        said: r.err.includes('.vx/lock.json not written'),
        written: existsSync(path.join(root, '.vx/lock.json')),
      }).toEqual({ code: 1, said: true, written: false })
    },
    TIMEOUT,
  )
})

describe('checkGraph under a lock', () => {
  const node = (id: string, outputs: string[], inputs: string[], deps: string[] = []) =>
    ({
      id,
      projectName: 'a',
      taskName: id.split('#')[1]!,
      projectDir: '/ws/a',
      deps,
      requested: true,
      config: {
        exec: { command: 'true' },
        cache: { inputs: { files: inputs }, outputs: { files: outputs } },
      },
    }) as unknown as TaskNode
  const graph = (...nodes: TaskNode[]) => new Map(nodes.map((n) => [n.id, n]))

  it('skips the rules the lock checked: an output overlap and an input that reads another output', () => {
    const overlap = () =>
      graph(node('a#x', ['dist/**'], ['src/**']), node('a#y', ['dist/**'], ['src/**']))
    expect(() => checkGraph(overlap(), '/ws')).toThrow('both declare the output')
    expect(() => checkGraph(overlap(), '/ws', { locked: true })).not.toThrow()
    const reads = () =>
      graph(node('a#x', ['gen/**'], ['src/**']), node('a#y', ['out/**'], ['gen/**']))
    expect(() => checkGraph(reads(), '/ws')).toThrow()
    expect(() => checkGraph(reads(), '/ws', { locked: true })).not.toThrow()
  })

  it('still marks an addition when exclusiveOutputs is off', () => {
    const nodes = graph(
      node('a#x', ['dist/**'], ['src/**']),
      node('a#y', ['dist/**'], ['src/**'], ['a#x']),
    )
    checkGraph(nodes, '/ws', { locked: true, exclusiveOutputs: false })
    expect(nodes.get('a#y')!.addsToOutputsOf).toEqual(['a#x'])
  })
})
