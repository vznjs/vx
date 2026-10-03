// An uncached task's key is derived once per run. The up-front pass
// (`deriveStableKeys`) keys every task; execute-task derived an uncached
// task's key again (item B-91). It now reuses the up-front key unless an
// upstream may write where that key reads (its whole project), or a
// root-anchored output may land there with no edge. Counted through
// VX_TIMING's `task hash` span; a reused key is checked against the one
// execute-task derives when `--force` skips the up-front pass.

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

async function vx(root: string, args: string[]): Promise<{ out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', VX_TIMING: '1' },
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(await proc.exited).toBe(0)
  return { out, err }
}

const run = async (root: string, tasks: string[], ...flags: string[]): Promise<string> => {
  const { out, err } = await vx(root, ['run', ...tasks, '--all', ...flags])
  return out + err
}

const hashCount = (out: string): number => {
  const m = /^\s*task hash\s+\S+\s+(\d+)$/m.exec(out)
  if (m === null) throw new Error(`no task hash span in:\n${out}`)
  return Number(m[1])
}

async function hashesOfLastRun(root: string): Promise<Map<string, string>> {
  const { out } = await vx(root, ['last', '--format', 'json'])
  const json = JSON.parse(out) as {
    tasks: { project: string; task: string; hash: string }[]
  }
  return new Map(json.tasks.map((t) => [`${t.project}#${t.task}`, t.hash]))
}

describe('an uncached task key is derived once', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-uncached-key-' })
    await addProject(
      root,
      'a',
      `
        export default { tasks: {
          t1: { exec: { command: 'true' } },
          t2: { exec: { command: 'true' } },
          t3: { exec: { command: 'true' } },
          t4: { exec: { command: 'true' } },
        } }
      `,
    )
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reuses the up-front key of an uncached task nothing upstream writes for', async () => {
    const out = await run(root, ['t1', 't2', 't3', 't4'])
    expect(hashCount(out)).toBe(4)
    const reused = await hashesOfLastRun(root)
    // `--force` reads no cache, so nothing is keyed up front: each key is
    // execute-task's own.
    expect(hashCount(await run(root, ['t1', 't2', 't3', 't4'], '--force'))).toBe(4)
    const derived = await hashesOfLastRun(root)
    expect(reused.size).toBe(4)
    expect(reused).toEqual(derived)
  }, 30_000)

  it('derives it again behind an upstream that may write into its project', async () => {
    await addProject(
      root,
      'c',
      `
        export default { tasks: {
          w: { exec: { command: 'echo made > made.txt' } },
          r: { exec: { command: 'true' }, dependsOn: ['w'] },
        } }
      `,
    )
    const out = await run(root, ['w', 'r'])
    // Both up front; c#r again once c#w may have written.
    expect(hashCount(out)).toBe(3)
  }, 30_000)

  it('derives it again where a root-anchored output may land with no edge', async () => {
    await addProject(
      root,
      'd',
      `
        export default { tasks: {
          gen: {
            exec: { command: 'mkdir -p ../e/gen && echo g > ../e/gen/f' },
            cache: {
              inputs: { files: ['package.json'] },
              outputs: { files: [], workspaceFiles: ['packages/e/gen/**'] },
            },
          },
        } }
      `,
    )
    await addProject(root, 'e', `export default { tasks: { u: { exec: { command: 'true' } } } }`)
    await writeFile(path.join(root, 'packages', 'e', 'keep.txt'), 'k\n')
    const out = await run(root, ['gen', 'u'])
    // Both up front; e#u again (d#gen reuses its probed key).
    expect(hashCount(out)).toBe(3)
  }, 30_000)
})
