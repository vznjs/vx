// An input that is a symlink keys the content behind it, as Nx reads a
// linked file where it points (2026-10-16: "Do like nx"). Its target
// string alone (git's mode-120000 blob) let an edit behind it replay the old
// output under a green run (Growth's symlink-input.sh): a file link and a
// directory link alike, inside or outside the project or the workspace.
// The target string stays in the key, so a retarget to equal bytes moves
// it; a dangling link keys its target string.

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { RunSummary } from '../src/orchestrator/index.js'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const TIMEOUT = 30_000

let root: string
let outside: string
let app: string
let said: string[]
const logger: Logger = {
  status: (line) => said.push(line),
  taskStdout: () => {},
  taskStderr: (_node, chunk) => said.push(String(chunk)),
  taskComplete: () => {},
}

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-linked-' })
  outside = await mkdtemp(path.join(os.tmpdir(), 'vx-linked-outside-'))
  await mkdir(path.join(root, 'shared'), { recursive: true })
  await writeFile(path.join(root, 'shared', 'x.txt'), 'V1\n')
  await writeFile(path.join(root, '.gitignore'), '.vx/cache/\nout.txt\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

/** `a#build` copies `read` to out.txt, keyed on `src/**`; `src` holds the links. */
async function project(
  read: string,
  task = `inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },`,
): Promise<void> {
  app = await addProject(root, 'a', {
    config: `export default { tasks: { build: { exec: { command: 'cat ${read} > out.txt' }, ${task} } } }`,
  })
  await mkdir(path.join(app, 'src'), { recursive: true })
}

function commit(message: string): void {
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', message)
}

async function build(): Promise<RunSummary> {
  said = []
  await rm(path.join(app, 'out.txt'), { force: true })
  return run({ cwd: root, tasks: ['build'], log: logger })
}

const statusOf = (r: RunSummary): string | undefined =>
  r.outcomes.find((o) => o.node.id === 'a#build')?.status

const out = (): Promise<string> => readFile(path.join(app, 'out.txt'), 'utf8')

/** Built once, hit unchanged, then rebuilt with `after` once `edit` ran: never a hit replaying the old bytes. */
async function rebuildsAfter(edit: () => Promise<void>, after: string): Promise<void> {
  const first = await build()
  expect(statusOf(first), said.join('')).toBe('success')
  expect(statusOf(await build())).toBe('cache-hit')
  await edit()
  expect(statusOf(await build()), said.join('')).toBe('success')
  expect(await out()).toBe(after)
}

describe('a symlinked input keys what it points to', () => {
  // 2026-10-25: git lists a linked directory as the link alone, so `lib/**`
  // over `lib -> ../shared` matched no file: an edit behind it was a hit.
  it(
    "a glob whose directory is a link: an edit behind it, and a workspace input's",
    async () => {
      app = await addProject(root, 'a', {
        config: `export default { tasks: { build: { exec: { command: 'cat lib/x.txt ${path.join(root, 'ws', 'x.txt')} > out.txt' }, inputs: { files: ['lib/**'], workspaceFiles: ['ws/**'] }, cache: { outputs: { files: ['out.txt'] } } } } }`,
      })
      await symlink(path.relative(app, path.join(root, 'shared')), path.join(app, 'lib'))
      await mkdir(path.join(root, 'other'))
      await writeFile(path.join(root, 'other', 'x.txt'), 'W1\n')
      await symlink('other', path.join(root, 'ws'))
      commit('fixture')
      await rebuildsAfter(() => writeFile(path.join(root, 'shared', 'x.txt'), 'V2\n'), 'V2\nW1\n')
      await writeFile(path.join(root, 'other', 'x.txt'), 'W2\n')
      expect(statusOf(await build()), said.join('')).toBe('success')
      expect(await out()).toBe('V2\nW2\n')
    },
    TIMEOUT,
  )

  // 2026-10-28: a link BELOW a glob's fixed prefix was missed the same way.
  // `src/**/*.txt` over `src/v -> shared` and `**/*.txt` over `lib -> more`
  // matched the link's name against the pattern, which it does not match,
  // so the files the task read through it were in no key. Untracked too.
  it(
    'a link to a directory below a glob’s fixed prefix: an edit behind it',
    async () => {
      await mkdir(path.join(root, 'more'))
      await writeFile(path.join(root, 'more', 'y.txt'), 'M1\n')
      await mkdir(path.join(root, 'other'))
      await writeFile(path.join(root, 'other', 'z.txt'), 'W1\n')
      app = await addProject(root, 'a', {
        config: `export default { tasks: { build: { exec: { command: 'cat src/v/x.txt lib/y.txt ../../ws/l/z.txt > out.txt' }, inputs: { files: ['src/**/*.txt', '**/*.txt'], workspaceFiles: ['ws/**/*.txt'] }, cache: { outputs: { files: ['out.txt'] } } } } }`,
      })
      await mkdir(path.join(app, 'src'))
      await symlink('../../../shared', path.join(app, 'src', 'v'))
      await mkdir(path.join(root, 'ws'))
      await symlink('../other', path.join(root, 'ws', 'l'))
      commit('fixture')
      await symlink('../../more', path.join(app, 'lib'))
      await rebuildsAfter(
        () => writeFile(path.join(root, 'shared', 'x.txt'), 'V2\n'),
        'V2\nM1\nW1\n',
      )
      await writeFile(path.join(root, 'more', 'y.txt'), 'M2\n')
      expect(statusOf(await build()), said.join('')).toBe('success')
      expect(await out()).toBe('V2\nM2\nW1\n')
      await writeFile(path.join(root, 'other', 'z.txt'), 'W2\n')
      expect(statusOf(await build()), said.join('')).toBe('success')
      expect(await out()).toBe('V2\nM2\nW2\n')
    },
    TIMEOUT,
  )

  it(
    'a brace glob whose alternative directory is a link: an edit behind it',
    async () => {
      // The link was found by each glob's static prefix, and a brace has
      // none: `{lib,src}/**` and `{lib/**,src/**}` matched no file behind
      // `lib -> ../shared`, so an edit there was a hit.
      app = await addProject(root, 'a', {
        config: `export default { tasks: { build: { exec: { command: 'cat lib/x.txt etc/x.txt > out.txt' }, inputs: { files: ['{lib,src}/**', '{etc/**,src/**}'] }, cache: { outputs: { files: ['out.txt'] } } } } }`,
      })
      await mkdir(path.join(root, 'other'))
      await writeFile(path.join(root, 'other', 'x.txt'), 'W1\n')
      await symlink(path.relative(app, path.join(root, 'shared')), path.join(app, 'lib'))
      await symlink(path.relative(app, path.join(root, 'other')), path.join(app, 'etc'))
      commit('fixture')
      await rebuildsAfter(() => writeFile(path.join(root, 'shared', 'x.txt'), 'V2\n'), 'V2\nW1\n')
      await writeFile(path.join(root, 'other', 'x.txt'), 'W2\n')
      expect(statusOf(await build()), said.join('')).toBe('success')
      expect(await out()).toBe('V2\nW2\n')
    },
    TIMEOUT,
  )

  // 2026-10-28: a gitignored directory a declaration names (`gen/**/*.txt`)
  // is walked from disk without following links, so a link to a directory
  // in it matched by its name alone, as above: an edit behind it was a hit.
  it(
    'a link to a directory inside a gitignored input directory: an edit behind it',
    async () => {
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\nout.txt\ngen/\n')
      await mkdir(path.join(root, 'other'))
      await writeFile(path.join(root, 'other', 'z.txt'), 'W1\n')
      app = await addProject(root, 'a', {
        config: `export default { tasks: { build: { exec: { command: 'cat gen/v/x.txt ../../gen/l/z.txt > out.txt' }, inputs: { files: ['gen/**/*.txt'], workspaceFiles: ['gen/**/*.txt'] }, cache: { outputs: { files: ['out.txt'] } } } } }`,
      })
      await mkdir(path.join(app, 'gen'))
      await symlink('../../../shared', path.join(app, 'gen', 'v'))
      await mkdir(path.join(root, 'gen'))
      await symlink('../other', path.join(root, 'gen', 'l'))
      commit('fixture')
      await rebuildsAfter(() => writeFile(path.join(root, 'shared', 'x.txt'), 'V2\n'), 'V2\nW1\n')
      await writeFile(path.join(root, 'other', 'z.txt'), 'W2\n')
      expect(statusOf(await build()), said.join('')).toBe('success')
      expect(await out()).toBe('V2\nW2\n')
    },
    TIMEOUT,
  )

  it(
    'a file link to a tracked file outside the project',
    async () => {
      await project('src/x.txt')
      await symlink('../../../shared/x.txt', path.join(app, 'src', 'x.txt'))
      commit('fixture')
      // Before the fix: refused, naming a workspaceFiles entry.
      await rebuildsAfter(async () => {
        await writeFile(path.join(root, 'shared', 'x.txt'), 'V2\n')
        commit('v2')
      }, 'V2\n')
    },
    TIMEOUT,
  )

  it(
    'a file link to a file outside the workspace',
    async () => {
      await writeFile(path.join(outside, 'x.txt'), 'O1\n')
      await project('src/x.txt')
      await symlink(path.join(outside, 'x.txt'), path.join(app, 'src', 'x.txt'))
      commit('fixture')
      await rebuildsAfter(() => writeFile(path.join(outside, 'x.txt'), 'O2\n'), 'O2\n')
    },
    TIMEOUT,
  )

  it(
    'a file link to a git-ignored file',
    async () => {
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\nout.txt\nsecret.txt\n')
      await writeFile(path.join(root, 'secret.txt'), 'S1\n')
      await project('src/x.txt')
      await symlink('../../../secret.txt', path.join(app, 'src', 'x.txt'))
      commit('fixture')
      await rebuildsAfter(() => writeFile(path.join(root, 'secret.txt'), 'S2\n'), 'S2\n')
    },
    TIMEOUT,
  )

  it(
    'a directory link inside the workspace: an edit, and a file added behind it',
    async () => {
      await project('src/sh/*.txt')
      await symlink('../../../shared', path.join(app, 'src', 'sh'))
      commit('fixture')
      await rebuildsAfter(async () => {
        await writeFile(path.join(root, 'shared', 'x.txt'), 'V2\n')
        commit('v2')
      }, 'V2\n')
      await writeFile(path.join(root, 'shared', 'y.txt'), 'Y\n')
      expect(statusOf(await build())).toBe('success')
      expect(await out()).toBe('V2\nY\n')
    },
    TIMEOUT,
  )

  it(
    'a directory link outside the workspace, through a nested link too',
    async () => {
      await mkdir(path.join(outside, 'd', 'deep'), { recursive: true })
      await writeFile(path.join(outside, 'd', 'deep', 'x.txt'), 'O1\n')
      await writeFile(path.join(outside, 'z.txt'), 'Z1\n')
      await symlink('../z.txt', path.join(outside, 'd', 'z.txt'))
      await project('src/d/deep/x.txt src/d/z.txt')
      await symlink(path.join(outside, 'd'), path.join(app, 'src', 'd'))
      commit('fixture')
      await rebuildsAfter(
        () => writeFile(path.join(outside, 'd', 'deep', 'x.txt'), 'O2\n'),
        'O2\nZ1\n',
      )
      await writeFile(path.join(outside, 'z.txt'), 'Z2\n')
      expect(statusOf(await build())).toBe('success')
      expect(await out()).toBe('O2\nZ2\n')
    },
    TIMEOUT,
  )

  it(
    'a link retargeted to a file of equal bytes moves the key',
    async () => {
      await writeFile(path.join(root, 'shared', 'twin.txt'), 'V1\n')
      await project('src/x.txt')
      await symlink('../../../shared/x.txt', path.join(app, 'src', 'x.txt'))
      commit('fixture')
      await rebuildsAfter(async () => {
        await rm(path.join(app, 'src', 'x.txt'))
        await symlink('../../../shared/twin.txt', path.join(app, 'src', 'x.txt'))
      }, 'V1\n')
    },
    TIMEOUT,
  )

  it(
    'a dangling link keys its target string, and the target appearing moves the key',
    async () => {
      await project('src/x.txt 2>/dev/null > out.txt || echo none')
      await symlink('../nowhere.txt', path.join(app, 'src', 'x.txt'))
      commit('fixture')
      await rebuildsAfter(() => writeFile(path.join(app, 'nowhere.txt'), 'N\n'), 'N\n')
      await rm(path.join(app, 'src', 'x.txt'))
      await symlink('../elsewhere.txt', path.join(app, 'src', 'x.txt'))
      expect(statusOf(await build())).toBe('success')
    },
    TIMEOUT,
  )

  it(
    'a link loop reads nothing, and runs',
    async () => {
      await project('src/a.txt 2>/dev/null > out.txt || echo none')
      await symlink('b.txt', path.join(app, 'src', 'a.txt'))
      await symlink('a.txt', path.join(app, 'src', 'b.txt'))
      commit('fixture')
      expect(statusOf(await build()), said.join('')).toBe('success')
      expect(statusOf(await build())).toBe('cache-hit')
    },
    TIMEOUT,
  )

  it(
    'a task with no cache block keys its dependants on the content behind its link',
    async () => {
      await project('src/x.txt', `inputs: { files: ['src/**'] },`)
      await symlink('../../../shared/x.txt', path.join(app, 'src', 'x.txt'))
      commit('fixture')
      expect(statusOf(await build()), said.join('')).toBe('success')
    },
    TIMEOUT,
  )
})
