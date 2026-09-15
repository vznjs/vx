// A task with no `cache` block derives a key for its dependents to fold,
// and, declaring nothing, folds every file in its project — its own
// outputs included, since it declared none. So when it writes a file git
// does not ignore, its key moves after its first run and a cached
// dependent misses once more; ignored outputs keep the key still. Found
// on a first-run walk (2026-09-15): the migrated build had no block yet,
// and its cached dependent missed twice before it hit.

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

const LIB = `
  export default {
    tasks: {
      build: { exec: { command: 'echo lib > dist.txt' } },
    },
  }
`
const WEB = `
  export default {
    tasks: {
      build: {
        exec: { command: 'cat ../lib/dist.txt > out.txt' },
        dependsOn: ['^build'],
        cache: { inputs: { files: ['package.json'] }, outputs: { files: ['out.txt'] } },
      },
    },
  }
`

async function vx(root: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, out }
}

async function fixture(ignoreOutput: boolean): Promise<string> {
  const root = await makeWorkspace({ prefix: 'vx-uncached-upstream-' })
  await addProject(root, 'lib', LIB)
  await addProject(root, 'web', { config: WEB, deps: { lib: 'workspace:*' } })
  if (ignoreOutput) await writeFile(path.join(root, '.gitignore'), 'packages/lib/dist.txt\n')
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return root
}

/** `vx why`'s this-run line for the task's latest run. */
async function thisRun(root: string, task: string): Promise<string> {
  const r = await vx(root, ['why', task])
  expect(r.code).toBe(0)
  return r.out.split('\n').find((l) => l.startsWith('  this run')) ?? ''
}

async function upstreamKeyMoved(root: string): Promise<boolean> {
  const r = await vx(root, ['why', 'lib#build', '--format', 'json'])
  expect(r.code).toBe(0)
  return (JSON.parse(r.out) as { why: { hashChanged: boolean } }).why.hashChanged
}

describe('an uncached upstream that writes an un-ignored file', () => {
  let root: string
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'moves its own key after its first run, so a cached dependent misses once more, then hits',
    async () => {
      root = await fixture(false)
      expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)
      expect(await thisRun(root, 'web#build')).toContain('· success · executed')

      expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)
      expect(await upstreamKeyMoved(root)).toBe(true)
      expect(await thisRun(root, 'web#build')).toContain('· success · executed')
      // The dependent's why names the upstream as the moved component.
      const why = await vx(root, ['why', 'web#build'])
      expect(why.out).toMatch(/changed\s+upstream\s+lib#build/)

      expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)
      expect(await upstreamKeyMoved(root)).toBe(false)
      expect(await thisRun(root, 'web#build')).toContain('· cache-hit ·')
    },
    TIMEOUT,
  )

  it(
    'control: the same output git-ignored keeps the upstream key still and the dependent hits on the second run',
    async () => {
      root = await fixture(true)
      expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)
      expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)
      expect(await upstreamKeyMoved(root)).toBe(false)
      expect(await thisRun(root, 'web#build')).toContain('· cache-hit ·')
    },
    TIMEOUT,
  )
})
