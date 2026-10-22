// The home guard (helpers/home-guard.ts) fails a suite that adds a store to
// the real home, except this repository's own: on a DTE agent the agent's
// vx writes that one while the suite runs (2026-10-22, shard-1 on small#1).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { repoIdOf } from '../src/workspace/repo-id.js'

const guard = path.join(import.meta.dir, 'helpers', 'home-guard.ts')

async function suiteAdding(store: string): Promise<number> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-home-guard-'))
  try {
    const home = path.join(dir, 'home')
    await writeFile(
      path.join(dir, 'adds.test.ts'),
      `import { mkdirSync } from 'node:fs'
import { it } from 'bun:test'
it('adds', () => { mkdirSync(${JSON.stringify(path.join(home, '.vx', store))}, { recursive: true }) })
`,
    )
    const p = Bun.spawn(['bun', 'test', '--preload', guard, './adds.test.ts'], {
      cwd: dir,
      env: { ...process.env, HOME: home },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return await p.exited
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

it("passes a suite while this repository's own store appears, and fails one adding another", async () => {
  const own = await repoIdOf(path.resolve(import.meta.dir, '../../..'))
  expect(own).not.toBeNull()
  expect([await suiteAdding(own!), await suiteAdding('0123456789abcdef')]).toEqual([0, 1])
})
