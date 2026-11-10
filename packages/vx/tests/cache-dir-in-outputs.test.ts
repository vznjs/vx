// A cache directory under a task's declared outputs can never work: the
// task's output clean deleted the index mid-run (`--cache-dir a/dist/cc`
// saved, then nothing ever hit), and with `outputs.clean: false` each save
// packed the index, its lock and earlier entries into the new entry, which
// a later hit restored over the live index. The run is refused up front,
// naming the task and the directory.

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import {
  addProject,
  type Fixture,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
} from './helpers/orchestrator-fixture.js'
import { gitIn } from './helpers/workspace.js'

const config = (outputs: string) => `
  export default {
    tasks: {
      build: {
        exec: { command: 'mkdir -p dist && cat src/x > dist/out' },
        cache: true,
        inputs: { files: ['src/**'] },
        outputs: ${outputs},
      },
    },
  }
`

describe('a cache directory under a task’s outputs', () => {
  let fx: Fixture
  beforeEach(async () => {
    fx = await makeWorkspace('vx-cache-in-outputs-')
  })
  afterEach(async () => {
    await rm(fx.root, { recursive: true, force: true })
  })

  const commit = () => {
    const git = gitIn(fx.root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  }

  for (const [label, outputs] of [
    ['cleaned', `{ files: ['dist/**'] }`],
    ['kept', `{ files: ['dist/**'], clean: false }`],
  ] as const) {
    it(
      `refuses the run before any task, naming both (outputs ${label})`,
      async () => {
        await addProject(fx.root, 'a', { config: config(outputs), files: { 'src/x': 'v1\n' } })
        commit()
        const cacheDir = path.join(fx.root, 'packages', 'a', 'dist', 'cc')
        const err = await run({
          cwd: fx.root,
          tasks: ['build'],
          cacheDir,
          log: silentLogger(fx),
        }).then(
          () => undefined,
          (e: unknown) => e,
        )
        expect(err).toBeInstanceOf(Error)
        expect((err as Error).message).toContain('a#build')
        expect((err as Error).message).toContain(cacheDir)
        expect(existsSync(path.join(fx.root, 'packages', 'a', 'dist', 'out'))).toBe(false)
      },
      TIMEOUT,
    )
  }

  it(
    'runs and hits when a take-back keeps the cache directory out of the outputs',
    async () => {
      await addProject(fx.root, 'a', {
        config: config(`{ files: ['dist/**', '!dist/cc/**'] }`),
        files: { 'src/x': 'v1\n' },
      })
      commit()
      const cacheDir = path.join(fx.root, 'packages', 'a', 'dist', 'cc')
      const opts = { cwd: fx.root, tasks: ['build'], cacheDir, log: silentLogger(fx) }
      const first = await run(opts)
      expect(first.outcomes.map((o) => o.status)).toEqual(['success'])
      const second = await run(opts)
      expect(second.outcomes.map((o) => o.status)).toEqual(['cache-hit'])
    },
    TIMEOUT,
  )
})
