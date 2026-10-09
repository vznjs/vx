// Tasks that declare one `workspaceFiles` list share its resolution (the
// memo keyed by the declaration), and each still takes its own outputs out
// of it: a project's `outputs.files` and the task's `outputs.workspaceFiles`
// are no inputs of that task alone (A-44), whichever task resolved first.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import {
  applyGitEnumeration,
  GitFilesCache,
  startGitEnumeration,
  type WorkspaceFilesCache,
} from '../src/cache/index.js'
import { resolveInputs } from '../src/cache/inputs.js'
import { relPosix } from '../src/util/index.js'
import { gitInitCommit } from './helpers/workspace.js'

let root: string
let git: GitFilesCache
let memo: WorkspaceFilesCache

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-wsmemo-')))
  for (const p of ['a', 'b']) {
    await mkdir(path.join(root, 'packages', p, 'gen'), { recursive: true })
    await writeFile(path.join(root, 'packages', p, 'package.json'), `{"name":"${p}"}\n`)
    await writeFile(path.join(root, 'packages', p, 'gen', 'out.txt'), `${p}\n`)
  }
  await mkdir(path.join(root, 'shared'))
  await writeFile(path.join(root, 'shared', 'gen.txt'), 'g\n')
  gitInitCommit(root)
  git = new GitFilesCache()
  const dirs = ['a', 'b'].map((p) => path.join(root, 'packages', p))
  await applyGitEnumeration(await startGitEnumeration(root, ['.']), root, dirs, git)
  memo = new Map()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const ALL = [
  'packages/a/gen/out.txt',
  'packages/a/package.json',
  'packages/b/gen/out.txt',
  'packages/b/package.json',
  'shared/gen.txt',
]

async function wsInputs(
  project: string,
  outputs: { files?: string[]; workspaceFiles?: string[] },
): Promise<string[]> {
  const got = await resolveInputs({
    projectDir: path.join(root, 'packages', project),
    workspaceRoot: root,
    envSource: {},
    inputs: { files: [], workspaceFiles: ['packages/**', 'shared/**'] },
    ownOutputs: outputs.files ?? [],
    ownWorkspaceOutputs: outputs.workspaceFiles ?? [],
    nestedProjectDirs: [],
    gitFilesCache: git,
    workspaceFilesCache: memo,
  })
  return got.files.map((f) => relPosix(root, f))
}

it('a task with no outputs of its own reads the whole list', async () => {
  expect(await wsInputs('a', {})).toEqual(ALL)
})

it('each task takes out its own outputs, whichever resolved first', async () => {
  expect(await wsInputs('a', { files: ['gen/**'] })).toEqual(
    ALL.filter((f) => f !== 'packages/a/gen/out.txt'),
  )
  expect(await wsInputs('b', {})).toEqual(ALL)
  expect(await wsInputs('b', { workspaceFiles: ['shared/**'] })).toEqual(
    ALL.filter((f) => f !== 'shared/gen.txt'),
  )
  expect(await wsInputs('a', {})).toEqual(ALL)
})
