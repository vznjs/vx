// Core refuses a task whose command runs `vx run` in the workspace running
// it (orchestrator/run.ts). `check.build-cold` did, and failed every macOS
// run once it became a task (#3909). No task of this repo may.
//
// `.unsafe`: reads the lock at the repo root, outside this project.
import path from 'node:path'
import { expect, it } from 'bun:test'
import { readLockfile } from '../src/workspace/lockfile.js'

it('no task of this repo runs `vx run` in its own workspace', async () => {
  const lock = (await readLockfile(path.resolve(import.meta.dir, '..', '..', '..')))!
  const nested = Object.entries(lock.projects).flatMap(([dir, p]) =>
    Object.entries(p.config?.tasks ?? {})
      .filter(([, t]) => /(^|[\s/])(vx|bin\.ts)\s+run\b/.test(t.exec?.command ?? ''))
      .map(([name]) => `${dir}#${name}`),
  )
  expect(nested).toEqual([])
})
