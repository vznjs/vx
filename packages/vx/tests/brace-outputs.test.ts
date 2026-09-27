// An output glob whose brace alternatives hold a `/` (A-10). `Bun.Glob`'s
// scan finds nothing for `{dist,lib/esm}/**`, so the save packed an empty
// artifact and a hit cleaned the outputs and restored nothing, green.

import { existsSync, readFileSync } from 'node:fs'
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
  root = await makeWorkspace({ prefix: 'vx-brace-out-' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a brace over two directories saves and restores both, and nothing beside them', async () => {
  const app = await addProject(root, 'app', {
    config: `
      export default {
        tasks: {
          build: {
            exec: { command: 'mkdir -p dist lib/esm lib/cjs && echo a > dist/a.js && echo b > lib/esm/b.js && echo c > lib/cjs/c.js' },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['{dist,lib/esm}/**'] } },
          },
        },
      }
    `,
    files: { 'src/x.ts': 'x', '.gitignore': 'dist/\nlib/\n' },
  })
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'fixture')
  const build = () => run({ cwd: root, tasks: ['app#build'], log, handleSignals: false })
  const first = await build()
  expect(first.outcomes[0]!.status).toBe('success')
  await rm(path.join(app, 'dist'), { recursive: true })
  await rm(path.join(app, 'lib'), { recursive: true })
  const hit = await build()
  expect(hit.outcomes[0]!.status).toBe('cache-hit')
  expect([
    readFileSync(path.join(app, 'dist/a.js'), 'utf8'),
    readFileSync(path.join(app, 'lib/esm/b.js'), 'utf8'),
    existsSync(path.join(app, 'lib/cjs/c.js')),
  ]).toEqual(['a\n', 'b\n', false])
})
