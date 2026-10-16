// A task with no `cache` block derives a key only for its dependents to
// fold, and the env it was handed by name (`exec.env.passThrough`) is the
// one statement of what env it reads. Its key folded the names, not the
// values, so a generator writing `API_URL` into a gitignored file a cached
// dependent reads replayed the old value's build when the value changed
// (Growth, 2026-10-16; the shape vx-migrate writes for Turbo's
// `"gen": { "cache": false, "env": ["API_URL"] }`).

import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { RunSummary } from '../src/orchestrator/index.js'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const TIMEOUT = 30_000
const NAME = 'VX_TEST_UNCACHED_API_URL'

let root: string
const logger: Logger = {
  status: () => {},
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
}

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-uncached-env-' })
})

afterEach(async () => {
  delete process.env[NAME]
  await rm(root, { recursive: true, force: true })
})

const statusOf = (r: RunSummary, id: string): string | undefined =>
  r.outcomes.find((o) => o.node.id === id)?.status

async function buildWith(value: string): Promise<RunSummary> {
  process.env[NAME] = value
  const r = await run({ cwd: root, tasks: ['b#build'], log: logger })
  expect(r.ok).toBe(true)
  return r
}

describe('an uncached upstream', () => {
  it(
    'folds the values of the env it passes through, so a dependent rebuilds when one changes',
    async () => {
      await addProject(root, 'a', {
        config: `export default { tasks: { gen: { exec: { command: 'echo "api=$${NAME}" > gen.txt', env: { passThrough: ['${NAME}'] } } } } }`,
      })
      const b = await addProject(root, 'b', {
        config: `export default { tasks: { build: { dependsOn: ['a#gen'], exec: { command: 'cat ../a/gen.txt > out.txt' }, cache: { inputs: { files: ['package.json'] }, outputs: { files: ['out.txt'] } } } } }`,
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\nout.txt\ngen.txt\n')
      gitIn(root)('add', '-A')
      gitIn(root)('commit', '-q', '-m', 'fixture')

      await buildWith('one')
      expect(statusOf(await buildWith('one'), 'b#build')).toBe('cache-hit')
      await rm(path.join(b, 'out.txt'))
      // Before the fix: a hit restoring `api=one`.
      expect(statusOf(await buildWith('two'), 'b#build')).toBe('success')
      expect(await readFile(path.join(b, 'out.txt'), 'utf8')).toBe('api=two\n')
    },
    TIMEOUT,
  )
})
