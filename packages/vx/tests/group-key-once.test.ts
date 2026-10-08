// An unkeyed group's key is derived once per run when its upstream holds
// still (X-149). The up-front pass (`deriveStableKeys`) keys every group;
// execute-task reuses that key only when the live upstream folds the same
// ids and keys, so an upstream whose key moved mid-run moves the group's.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

async function vx(root: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect({ code: await proc.exited, err }).toEqual({ code: 0, err: expect.any(String) })
  return out
}

interface LastTask {
  hash: string
  cacheHit?: boolean
}

async function lastRun(root: string): Promise<Map<string, LastTask>> {
  const json = JSON.parse(await vx(root, ['last', '--format', 'json'])) as {
    tasks: (LastTask & { project: string; task: string })[]
  }
  return new Map(json.tasks.map((t) => [`${t.project}#${t.task}`, t]))
}

// A group is not recorded; its key reaches the record through a cached
// dependant's, which folds it.
const CACHED = `exec: { command: 'true' }, cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } }`

describe('an unkeyed group key is derived once', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-group-key-' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('the reused key is the one a run with no up-front pass derives', async () => {
    await addProject(
      root,
      'a',
      `
        export default { tasks: {
          t1: { ${CACHED} },
          t2: { exec: { command: 'true' } },
          g: { dependsOn: ['t1', 't2'] },
          d: { ${CACHED}, dependsOn: ['g'] },
        } }
      `,
    )
    await vx(root, ['run', 'd', '--all'])
    const reused = await lastRun(root)
    // `--force` reads no cache, so nothing is keyed up front.
    await vx(root, ['run', 'd', '--all', '--force'])
    const derived = await lastRun(root)
    expect(reused.get('a#d')?.hash).toBeString()
    expect(reused.get('a#d')?.hash).toBe(derived.get('a#d')!.hash)
  }, 30_000)

  it('follows an upstream whose key moved after the up-front pass', async () => {
    // c#w's output lands in c, so c#r's key (its whole project) taken up
    // front misses made.txt; the group must fold the live one, or c#d's
    // first key is one no later run derives and the second run misses.
    await addProject(
      root,
      'c',
      `
        export default { tasks: {
          w: {
            exec: { command: 'echo made > made.txt' },
            cache: { inputs: { files: ['package.json'] }, outputs: { files: ['made.txt'] } },
          },
          r: { exec: { command: 'true' }, dependsOn: ['w'] },
          g: { dependsOn: ['r'] },
          d: { ${CACHED}, dependsOn: ['g'] },
        } }
      `,
    )
    await vx(root, ['run', 'd', '--all'])
    const first = await lastRun(root)
    await vx(root, ['run', 'd', '--all'])
    const second = await lastRun(root)
    expect(first.get('c#d')?.cacheHit).not.toBe(true)
    expect(second.get('c#d')).toMatchObject({ hash: first.get('c#d')!.hash, cacheHit: true })
  }, 30_000)
})
