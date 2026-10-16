// An input that is a symlink folds as git folds it: the blob of its target
// STRING. The task reads the bytes behind it, so a link whose target was no
// input of its own let an edit to that target replay the old output under a
// green run — a file link (`src/x.txt -> ../../shared/x.txt`) and a directory
// link (`src/sh -> ../../shared`) alike. A link's target must now be an input
// itself (then the key, `--affected` and `vx watch` all see it), else the
// task is refused naming the declaration that keys it.

import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { RunSummary } from '../src/orchestrator/index.js'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const TIMEOUT = 30_000

let root: string
let said: string[]
const logger: Logger = {
  status: (line) => said.push(line),
  taskStdout: () => {},
  taskStderr: (_node, chunk) => said.push(String(chunk)),
  taskComplete: () => {},
}

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-linked-' })
  await mkdir(path.join(root, 'shared'), { recursive: true })
  await writeFile(path.join(root, 'shared', 'x.txt'), 'V1\n')
  await writeFile(path.join(root, '.gitignore'), '.vx/cache/\nout.txt\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const config = (read: string, inputs: string) => `
  export default {
    tasks: {
      build: {
        exec: { command: 'cat ${read} > out.txt' },
        cache: { inputs: ${inputs}, outputs: { files: ['out.txt'] } },
      },
    },
  }
`

function commit(message: string): void {
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', message)
}

function build(): Promise<RunSummary> {
  said = []
  return run({ cwd: root, tasks: ['build'], log: logger })
}

/** The task failed, and what it said holds `refusal`. */
async function refused(refusal: string): Promise<void> {
  const r = await build()
  expect(statusOf(r)).toBe('failed')
  expect(said.join('')).toContain(refusal)
}

const statusOf = (r: RunSummary): string | undefined =>
  r.outcomes.find((o) => o.node.id === 'a#build')?.status

/** The run refuses, or rebuilds V2 after the target moved: never a hit replaying V1. */
async function editTarget(app: string): Promise<RunSummary> {
  await writeFile(path.join(root, 'shared', 'x.txt'), 'V2\n')
  commit('v2')
  await rm(path.join(app, 'out.txt'), { force: true })
  return build()
}

describe('a symlinked input', () => {
  it(
    'a file link whose target is no input is refused, naming the declaration that keys it',
    async () => {
      const app = await addProject(root, 'a', {
        config: config('src/x.txt', `{ files: ['src/**'] }`),
      })
      await mkdir(path.join(app, 'src'), { recursive: true })
      await symlink('../../../shared/x.txt', path.join(app, 'src', 'x.txt'))
      commit('fixture')
      // Before the fix: `success`, then a `cache-hit` restoring V1 over V2.
      await refused(
        'cache.inputs: "packages/a/src/x.txt" is a symlink to "shared/x.txt", whose content the key does not see — an edit to it would replay the old output. Add "shared/x.txt" to cache.inputs.workspaceFiles.',
      )
    },
    TIMEOUT,
  )

  it(
    'declared, an edit to the target rebuilds',
    async () => {
      const app = await addProject(root, 'a', {
        config: config('src/x.txt', `{ files: ['src/**'], workspaceFiles: ['shared/x.txt'] }`),
      })
      await mkdir(path.join(app, 'src'), { recursive: true })
      await symlink('../../../shared/x.txt', path.join(app, 'src', 'x.txt'))
      commit('fixture')
      expect(statusOf(await build())).toBe('success')
      expect(statusOf(await editTarget(app))).toBe('success')
      expect(await readFile(path.join(app, 'out.txt'), 'utf8')).toBe('V2\n')
    },
    TIMEOUT,
  )

  it(
    'a directory link is refused until every file behind it is an input',
    async () => {
      await writeFile(path.join(root, 'shared', 'y.txt'), 'Y\n')
      const app = await addProject(root, 'a', {
        config: config('src/sh/x.txt', `{ files: ['src/**'], workspaceFiles: ['shared/y.txt'] }`),
      })
      await mkdir(path.join(app, 'src'), { recursive: true })
      await symlink('../../../shared', path.join(app, 'src', 'sh'))
      commit('fixture')
      await refused(
        'cache.inputs: "packages/a/src/sh" is a symlink to "shared", and "shared/x.txt" behind it is not an input — an edit to it would replay the old output. Add "shared/**" to cache.inputs.workspaceFiles.',
      )
      await writeFile(
        path.join(app, 'vx.config.mjs'),
        config('src/sh/x.txt', `{ files: ['src/**'], workspaceFiles: ['shared/**'] }`),
      )
      commit('declare')
      expect(statusOf(await build())).toBe('success')
      expect(statusOf(await editTarget(app))).toBe('success')
      expect(await readFile(path.join(app, 'out.txt'), 'utf8')).toBe('V2\n')
    },
    TIMEOUT,
  )

  it(
    'a link to a file the globs already hold keys it as before, and so does a dangling link',
    async () => {
      const app = await addProject(root, 'a', {
        config: config('src/x.txt', `{ files: ['src/**', 'data/**'] }`),
        files: { 'data/x.txt': 'D1\n' },
      })
      await mkdir(path.join(app, 'src'), { recursive: true })
      await symlink('../data/x.txt', path.join(app, 'src', 'x.txt'))
      await symlink('../nowhere.txt', path.join(app, 'src', 'gone.txt'))
      commit('fixture')
      expect(statusOf(await build())).toBe('success')
      await writeFile(path.join(app, 'data', 'x.txt'), 'D2\n')
      await rm(path.join(app, 'out.txt'))
      expect(statusOf(await build())).toBe('success')
      expect(await readFile(path.join(app, 'out.txt'), 'utf8')).toBe('D2\n')
    },
    TIMEOUT,
  )

  it(
    'a link to a file git does not list is refused with the probe that keys it',
    async () => {
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\nout.txt\nsecret.txt\n')
      await writeFile(path.join(root, 'secret.txt'), 'S\n')
      const app = await addProject(root, 'a', {
        config: config('src/x.txt', `{ files: ['src/**'] }`),
      })
      await mkdir(path.join(app, 'src'), { recursive: true })
      await symlink('../../../secret.txt', path.join(app, 'src', 'x.txt'))
      commit('fixture')
      await refused(
        'cache.inputs: "packages/a/src/x.txt" is a symlink to "secret.txt", which git does not list (gitignored, or outside the workspace), so no glob can key it — an edit to it would replay the old output. Point the link at a tracked file, or exclude it from the inputs and key its content with cache.inputs.runtime.',
      )
    },
    TIMEOUT,
  )
})
