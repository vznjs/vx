// An input gone between its enumeration and its hash: an upstream task that
// deletes a file its dependant's globs matched failed the dependant as
// `internal error … ENOENT` on every run (A-55). The key folds the file as
// absent; the run's save is withheld when the key taken up front still
// folded the file.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  addProject,
  type Fixture,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
} from './helpers/orchestrator-fixture.js'
import { ABSENT_INPUT, Cache, type CacheKeyInput } from '../src/cache/index.js'
import { foldKey } from '../src/cache/key-fold.js'
import { run } from '../src/orchestrator/index.js'
import type { TaskNode } from '../src/graph/index.js'
import { describeTaskInputs, movedInput } from '../src/orchestrator/task-hash.js'

let fx: Fixture
beforeEach(async () => {
  fx = await makeWorkspace('vx-absent-in-')
})
afterEach(async () => {
  await rm(fx.root, { recursive: true, force: true })
})

describe('an input an upstream deletes before its dependant is keyed', () => {
  it(
    'is keyed as absent: the dependant runs instead of failing',
    async () => {
      await addProject(fx.root, 'a', {
        files: { 'src/x': 'x' },
        config: `export default { tasks: { build: {
          exec: { command: 'rm -f ../b/src/gen.txt && echo a > out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      })
      const b = await addProject(fx.root, 'b', {
        deps: { a: '*' },
        files: { 'src/keep': 'k' },
        config: `export default { tasks: { build: {
          dependsOn: ['^build'],
          exec: { command: 'ls src > out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      })
      await Bun.write(path.join(b, 'src', 'gen.txt'), 'g')
      const r = await run({ cwd: fx.root, tasks: ['build'], log: silentLogger(fx) })
      expect(r.outcomes.map((o) => `${o.node.id} ${o.status}`).sort()).toEqual([
        'a#build success',
        'b#build success',
      ])
      expect(await Bun.file(path.join(b, 'out.txt')).text()).toBe('keep\n')
      expect(fx.err.filter((l) => l.includes('internal error'))).toEqual([])
    },
    TIMEOUT,
  )
})

describe('the key of an absent input', () => {
  const base = (inputFiles: string[]): CacheKeyInput => ({
    taskId: 'p#build',
    workspaceRoot: '/ws',
    workspaceFingerprint: 'f',
    projectPackageJsonHash: 'p',
    taskConfigHash: 'c',
    envValues: [],
    upstreamHashes: [],
    inputFiles,
  })
  const gone = (): Promise<string> =>
    Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
  const rel = (f: string): string => f.slice('/ws/'.length)

  it('folds apart from the file present and from the file never listed', async () => {
    const absent = await foldKey(base(['/ws/a']), gone, rel)
    const present = await foldKey(base(['/ws/a']), async () => '100644 abc', rel)
    const unlisted = await foldKey(base([]), gone, rel)
    expect(new Set([absent, present, unlisted]).size).toBe(3)
    // Stable: the same state keys the same.
    expect(await foldKey(base(['/ws/a']), gone, rel)).toBe(absent)
  })

  it('rethrows any other read error', async () => {
    const denied = (): Promise<string> =>
      Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
    const err = await foldKey(base(['/ws/a']), denied, rel).catch((e: unknown) => e)
    expect((err as Error).message).toBe('denied')
  })
})

describe('movedInput and an input the key folded as absent', () => {
  const cache = { hashFile: async () => 'x' } as never

  it('is unmoved while it stays gone, and moved once it is back', async () => {
    const p = path.join(fx.root, 'maybe.txt')
    const fact = { path: p, digest: ABSENT_INPUT, since: 0 }
    expect(await movedInput([fact], cache)).toBeUndefined()
    await Bun.write(p, 'back')
    expect(await movedInput([fact], cache)).toBe(p)
  })
})

describe('the inputs an executor is handed', () => {
  it('leave out a file gone before the hash, and keep it in the facts as absent', async () => {
    const dir = await addProject(fx.root, 'app', {
      files: { 'src/a.txt': 'a', 'src/gen.txt': 'g' },
    })
    const cache = new Cache(path.join(fx.root, '.vx', 'cache'))
    const read = cache.hashFile.bind(cache)
    // Enumerated, then gone before the hash: an upstream's delete.
    cache.hashFile = (f: string) =>
      f.endsWith('gen.txt')
        ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
        : read(f)
    try {
      const described = await describeTaskInputs({
        node: {
          id: 'app#t',
          projectName: 'app',
          projectDir: dir,
          taskName: 't',
          config: {
            exec: { command: 'true' },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
          },
          deps: [],
          requested: true,
        } as TaskNode,
        upstream: [],
        workspaceRoot: fx.root,
        workspaceFingerprint: 'fp',
        cache,
        nestedProjectDirs: [],
      })
      expect(described.inputs.files.map((f) => f.path)).toEqual(['packages/app/src/a.txt'])
      expect(described.facts.filter((f) => f.digest === ABSENT_INPUT).map((f) => f.path)).toEqual([
        path.join(dir, 'src', 'gen.txt'),
      ])
    } finally {
      cache.close()
    }
  })
})
