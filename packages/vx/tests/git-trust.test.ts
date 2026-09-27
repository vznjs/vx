// When the git enumeration may trust an index OID for a file, end to end:
// each row is a working tree git reports in a shape the trust rule once
// misread, and the run that followed replayed stale bytes under a green
// run. The rule itself is in `src/cache/git-inputs.ts`.

import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Logger, RunSummary } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const TIMEOUT = 30_000

let root: string

const logger: Logger = {
  status: () => {},
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
}

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-git-trust-' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function build(): Promise<string | undefined> {
  const r: RunSummary = await run({ cwd: root, tasks: ['build'], log: logger })
  expect(r.ok).toBe(true)
  return r.outcomes.find((o) => o.node.id === 'a#build')?.status
}

describe('a rename git reports in the second status column', () => {
  it(
    'a deleted rename source is not an input (item 976)',
    async () => {
      // `git add -N` on the copy, then the original removed: porcelain v1
      // prints ` R new.txt\0old.txt\0`, the rename in Y. The parser took
      // the source token only for an R or C in X, so `old.txt` read as a
      // record of its own, stayed trusted, and was keyed from the index
      // though it was gone.
      const dir = await addProject(root, 'a', {
        config: `export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && ls *.txt > dist/out' },
              cache: { inputs: { files: ['*.txt'] }, outputs: { files: ['dist/**'] } },
            },
          },
        }`,
      })
      await writeFile(path.join(dir, 'old.txt'), 'x\n')
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'fixture')
      await writeFile(path.join(dir, 'new.txt'), 'x\n')
      git('add', '-N', path.join(dir, 'new.txt'))

      expect(await build()).toBe('success')
      expect(await readFile(path.join(dir, 'dist', 'out'), 'utf8')).toBe('new.txt\nold.txt\n')

      await rm(path.join(dir, 'old.txt'))
      const porcelain = git('status', '--porcelain', '-z', '--', dir)
      expect(porcelain).toContain(' R ')
      expect(await build()).toBe('success')
      expect(await readFile(path.join(dir, 'dist', 'out'), 'utf8')).toBe('new.txt\n')
    },
    TIMEOUT,
  )
})
