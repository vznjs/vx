// An input glob whose brace alternative ends in `**`. `Bun.Glob`'s match
// reads that `**` as one segment: `{src/**,lib/**}` matched `src/a.ts` and
// never `src/deep/a.ts`, so an edit to a nested source was a stale hit.

import { writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run, type Logger } from '../src/orchestrator/index.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const log: Logger = {
  status: () => {},
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
}
let root: string

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-brace-in-' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a brace alternative ending in ** folds files below its first directory', async () => {
  const app = await addProject(root, 'app', {
    config: `
      export default {
        tasks: {
          build: {
            exec: { command: 'true' },
            cache: { inputs: { files: ['{src/**,lib/**}'] }, outputs: { files: [] } },
          },
        },
      }
    `,
    files: { 'src/top.ts': 'a', 'src/deep/x.ts': 'a', 'lib/y.ts': 'a', 'other/z.ts': 'a' },
  })
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'fixture')
  const build = async () =>
    (await run({ cwd: root, tasks: ['app#build'], log, handleSignals: false })).outcomes[0]!.status
  expect(await build()).toBe('success')
  writeFileSync(path.join(app, 'src/deep/x.ts'), 'b')
  expect(await build()).toBe('success')
  // CONTROL: a file no alternative names stays out of the key.
  writeFileSync(path.join(app, 'other/z.ts'), 'b')
  expect(await build()).toBe('cache-hit')
})
