// An input gone between its enumeration and its hash: an upstream task that
// deletes a file its dependant's globs matched failed the dependant as
// `internal error … ENOENT` on every run (A-55). The key folds the file as
// absent; the run's save is withheld when the key taken up front still
// folded the file.
import { mkdir, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  addProject,
  type Fixture,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
} from './helpers/orchestrator-fixture.js'
import { gitIn } from './helpers/workspace.js'
import { ABSENT_INPUT, Cache, type CacheKeyInput } from '../src/cache/index.js'
import { foldKey } from '../src/cache/key-fold.js'
import { run } from './helpers/orchestrator.js'
import type { TaskNode } from '../src/graph/index.js'
import { describeTaskInputs, movedInput } from '../src/orchestrator/task-hash.js'

let fx: Fixture
beforeEach(async () => {
  fx = await makeWorkspace('vx-absent-in-', { b: ['a'] })
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
          inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] }, cache: true,
        } } }`,
      })
      const b = await addProject(fx.root, 'b', {
        files: { 'src/keep': 'k' },
        config: `export default { tasks: { build: {
          dependsOn: ['^build'],
          exec: { command: 'ls src > out.txt' },
          inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] }, cache: true,
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
            inputs: { files: ['src/**'] },
            outputs: { files: [] },
            cache: true,
          },
          deps: [],
          requested: true,
        } as TaskNode,
        upstream: [],
        workspaceRoot: fx.root,
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

// A declared path whose parent is a regular file: lstat answers ENOTDIR, not
// ENOENT, and `throwIfNoEntry: false` passes over only ENOENT, so the key
// failed as `internal error … ENOTDIR` (fuzz, 2026-11-10). The path is
// absent, as under a directory that does not exist.
describe('an input under a path that is a regular file', () => {
  const statuses = async (): Promise<string[]> => {
    const r = await run({ cwd: fx.root, tasks: ['build'], log: silentLogger(fx) })
    expect(fx.err.filter((l) => l.includes('internal error'))).toEqual([])
    return r.outcomes.map((o) => `${o.node.id} ${o.status}`)
  }

  it(
    'a literal, a glob under it and a workspace literal are absent, and keyed once there',
    async () => {
      const dir = await addProject(fx.root, 'a', {
        files: { conf: 'x', 'src/a': 'a' },
        config: `export default { tasks: { build: {
          exec: { command: 'cat conf/b.txt conf/sub/c.txt ../../shared/x.txt > out.txt 2>/dev/null; true' },
          inputs: { files: ['src/**', 'conf/b.txt', 'conf/sub/**'], workspaceFiles: ['shared/x.txt'] },
          outputs: { files: ['out.txt'] }, cache: true,
        } } }`,
      })
      await Bun.write(path.join(fx.root, 'shared'), 'file')
      expect(await statuses()).toEqual(['a#build success'])
      expect(await statuses()).toEqual(['a#build cache-hit'])
      await rm(path.join(dir, 'conf'))
      await Bun.write(path.join(dir, 'conf', 'b.txt'), 'b')
      expect(await statuses()).toEqual(['a#build success'])
      await Bun.write(path.join(dir, 'conf', 'sub', 'c.txt'), 'c')
      expect(await statuses()).toEqual(['a#build success'])
      await rm(path.join(fx.root, 'shared'))
      await Bun.write(path.join(fx.root, 'shared', 'x.txt'), 'x')
      expect(await statuses()).toEqual(['a#build success'])
      expect(await Bun.file(path.join(dir, 'out.txt')).text()).toBe('bcx')
    },
    TIMEOUT,
  )

  it(
    'a literal input link that leads under a file: the run says the dead glob, and runs',
    async () => {
      // The dead-glob check stat'ed through the link to ask for a directory.
      const dir = await addProject(fx.root, 'a', {
        files: { conf: 'x' },
        config: `export default { tasks: { build: {
          exec: { command: 'true' },
          inputs: { files: ['lib/**', 'src/l'] }, outputs: { files: [] }, cache: true,
        } } }`,
      })
      await mkdir(path.join(dir, 'src'))
      await symlink('../conf/x', path.join(dir, 'src', 'l'))
      expect(await statuses()).toEqual(['a#build success'])
      expect(fx.log.filter((l) => l.includes('matched no files (lib/**)'))).toHaveLength(1)
    },
    TIMEOUT,
  )

  it(
    'a tracked directory replaced by a file keys its files as absent',
    async () => {
      const dir = await addProject(fx.root, 'a', {
        files: { 'top/a.md': 'a' },
        config: `export default { tasks: { build: {
          exec: { command: 'cat top > out.txt 2>/dev/null; true' },
          inputs: { files: ['**'] }, outputs: { files: ['out.txt'] }, cache: true,
        } } }`,
      })
      await Bun.write(path.join(fx.root, '.gitignore'), '.vx/cache/\nout.txt\n')
      gitIn(fx.root)('add', '-A')
      gitIn(fx.root)('commit', '-q', '-m', 'fixture')
      expect(await statuses()).toEqual(['a#build success'])
      await rm(path.join(dir, 'top'), { recursive: true })
      await Bun.write(path.join(dir, 'top'), 'f')
      expect(await statuses()).toEqual(['a#build success'])
      expect(await Bun.file(path.join(dir, 'out.txt')).text()).toBe('f')
      expect(await statuses()).toEqual(['a#build cache-hit'])
    },
    TIMEOUT,
  )
})
