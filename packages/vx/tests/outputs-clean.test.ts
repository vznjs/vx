// `cache.outputs.clean: false` (2026-10-15): a miss leaves the declared
// outputs in place for the command (tsc's `.tsbuildinfo`), and the save
// stores every file the outputs match after the run, a leftover included.
// "You opt out of security" (M, 07:44): the clean-tree guarantee is off.

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  addProject,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
  type Fixture,
} from './helpers/orchestrator-fixture.js'
import { run } from './helpers/orchestrator.js'

const task = (command: string, outputs: string, extra = ''): string => `
  export default {
    tasks: {
      build: {
        exec: { command: ${JSON.stringify(command)}, ${extra} },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**']${outputs} } },
      },
    },
  }
`

describe('cache.outputs.clean', () => {
  let f: Fixture
  beforeEach(async () => {
    f = await makeWorkspace('vx-outputs-clean-')
  })
  afterEach(async () => {
    await rm(f.root, { recursive: true, force: true })
  })

  const build = async () =>
    (await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })).outcomes[0]?.status

  const seed = async (dir: string, files: Record<string, string>) => {
    await mkdir(path.join(dir, 'dist'), { recursive: true })
    for (const [rel, body] of Object.entries(files)) await writeFile(path.join(dir, rel), body)
  }

  it(
    'false: a miss keeps what the outputs held, and saves all of it, a leftover included',
    async () => {
      const dir = await addProject(f.root, 'app', {
        files: { 'src/a.txt': 'v1' },
        config: task('cp src/a.txt dist/a.txt', ', clean: false'),
      })
      await seed(dir, { 'dist/.tsbuildinfo': 'incremental', 'dist/old.txt': 'stale' })
      expect(await build()).toBe('success')
      expect(await readFile(path.join(dir, 'dist/.tsbuildinfo'), 'utf8')).toBe('incremental')
      expect(existsSync(path.join(dir, 'dist/old.txt'))).toBe(true)
      expect(await build()).toBe('cache-hit')
      // The leftover is in the entry: a restore on a clean tree brings it back.
      await rm(path.join(dir, 'dist'), { recursive: true, force: true })
      expect(await build()).toBe('cache-hit')
      expect(await readFile(path.join(dir, 'dist/old.txt'), 'utf8')).toBe('stale')
      expect(await readFile(path.join(dir, 'dist/a.txt'), 'utf8')).toBe('v1')
    },
    TIMEOUT,
  )

  it(
    'false: a run that starts from nothing, or rewrites all it found, saves',
    async () => {
      const dir = await addProject(f.root, 'app', {
        files: { 'src/a.txt': 'v1' },
        config: task(
          'mkdir -p dist && cp src/a.txt dist/a.txt && echo i > dist/.tsbuildinfo',
          ', clean: false',
        ),
      })
      expect(await build()).toBe('success')
      expect(await build()).toBe('cache-hit')

      await writeFile(path.join(dir, 'src/a.txt'), 'v2')
      expect(await build()).toBe('success')
      expect(await build()).toBe('cache-hit')
      expect(await readFile(path.join(dir, 'dist/a.txt'), 'utf8')).toBe('v2')
    },
    TIMEOUT,
  )

  it(
    'the workspace sets the default, and a task overrides it',
    async () => {
      await writeFile(
        path.join(f.root, '.vx/workspace.mjs'),
        'export default { cache: { outputs: { clean: false } } }\n',
      )
      const kept = await addProject(f.root, 'kept', {
        files: { 'src/a.txt': 'v1' },
        config: task('cp src/a.txt dist/a.txt', ''),
      })
      const cleaned = await addProject(f.root, 'cleaned', {
        files: { 'src/a.txt': 'v1' },
        config: task('mkdir -p dist && cp src/a.txt dist/a.txt', ', clean: true'),
      })
      await seed(kept, { 'dist/.tsbuildinfo': 'incremental' })
      await seed(cleaned, { 'dist/.tsbuildinfo': 'incremental' })
      const r = await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
      expect(r.outcomes.map((o) => o.status)).toEqual(['success', 'success'])
      expect(existsSync(path.join(kept, 'dist/.tsbuildinfo'))).toBe(true)
      expect(existsSync(path.join(cleaned, 'dist/.tsbuildinfo'))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'a retry still starts from clean outputs',
    async () => {
      const dir = await addProject(f.root, 'app', {
        files: { 'src/a.txt': 'v1' },
        config: task(
          'if [ -f dist/partial ]; then exit 3; fi; if [ ! -f tried ]; then touch tried dist/partial; exit 1; fi; cp src/a.txt dist/a.txt',
          ', clean: false',
          'retries: 1',
        ),
      })
      await seed(dir, { 'dist/.tsbuildinfo': 'incremental' })
      expect(await build()).toBe('success')
      expect(existsSync(path.join(dir, 'dist/partial'))).toBe(false)
      expect(existsSync(path.join(dir, 'dist/.tsbuildinfo'))).toBe(false)
      // The retry ran on a clean tree, so its outputs are an entry.
      expect(await build()).toBe('cache-hit')
    },
    TIMEOUT,
  )

  it(
    'a value that is no boolean is refused',
    async () => {
      await addProject(f.root, 'app', {
        files: { 'src/a.txt': 'v1' },
        config: task('true', ", clean: 'no'"),
      })
      await expect(build()).rejects.toThrow('cache.outputs.clean must be true or false')
    },
    TIMEOUT,
  )
})
