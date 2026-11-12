// A sandboxed formatter with a write grant over its own input and
// `inputs.stability: { strategy: 'unchecked' }`, ahead of a reader that
// folds no key of it: the grant is the write that skipping the check must
// still account for (execute-task.ts `keyStillTrue`). Unsafe: it runs a
// sandbox, which cannot nest inside a sandboxed shard (A-24).

import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { FILE_HASH_RACY_MS, racyWindowMs } from '../src/memo/index.js'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox unchecked-rewriter test')

const log: Logger = {
  status: () => {},
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
}

describe.skipIf(!available)("a sandboxed 'unchecked' rewriter with a write grant", () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-sb-unchecked-' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('seeds A, B, B, A build A, B, B, A: its reader is not restored ahead of it', async () => {
    const app = await addProject(root, 'app', {
      files: { 'a.ts': 'X' },
      config: `export default { tasks: {
        fmt: {
          exec: { command: 'cp seed.txt a.ts', sandbox: { allow: { read: ['.'], write: ['a.ts'] } } },
          inputs: { files: ['seed.txt', 'a.ts'], stability: { strategy: 'unchecked' } },
          outputs: { files: [] }, cache: true,
        },
        build: {
          dependsOn: ['fmt'],
          exec: { command: 'mkdir -p dist && cat a.ts > dist/out.txt' },
          inputs: { files: ['a.ts'], tasks: [] }, outputs: { files: ['dist/**'] }, cache: true,
        },
      } }`,
    })
    await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\n')
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'fixture')
    const outs: string[] = []
    for (const seed of ['A', 'B', 'B', 'A']) {
      await writeFile(path.join(app, 'seed.txt'), seed)
      // Past the racy window, as a user's runs a second apart are: a file
      // written inside it is hashed again on every read.
      const { ctimeMs } = await stat(path.join(app, 'a.ts'))
      await Bun.sleep(
        Math.max(0, ctimeMs + racyWindowMs(ctimeMs, FILE_HASH_RACY_MS) + 1 - Date.now()),
      )
      expect((await run({ cwd: root, tasks: ['build'], log, handleSignals: false })).ok).toBe(true)
      outs.push(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8'))
    }
    expect(outs).toEqual(['A', 'B', 'B', 'A'])
  }, 30_000)
})
