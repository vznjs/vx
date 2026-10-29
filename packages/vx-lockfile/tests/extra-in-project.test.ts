// An extra file a lockfile names (a `file:` directory, a patch) can sit
// inside another project's directory. `--affected` asked the claimant only
// about paths no project owned, so an edit there selected the owner by
// path and never the project the lockfile says reaches it: the key moved,
// the run left it out.
import { Database } from 'bun:sqlite'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { type Logger } from '@vzn/vx'
import { planRun } from '../../vx/tests/helpers/orchestrator.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { editMemo, readMemo } from './helpers/memo.js'
import { affectedIds, commitAll, moved } from './helpers/affected.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const BUILD =
  "export default { tasks: { build: { exec: { command: 'echo built' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } } } }\n"
const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  packages/lib:
    dependencies:
      dep:
        specifier: file:../other/vendor
        version: file:packages/other/vendor

  packages/other: {}

  packages/third: {}

packages:

  dep@file:packages/other/vendor:
    resolution: {directory: packages/other/vendor, type: directory}

snapshots:

  dep@file:packages/other/vendor: {}
`

const silent = (): Logger =>
  ({
    runStart() {},
    taskStart() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
    runStatus() {},
    runEnd() {},
    status() {},
  }) as never

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-extra-in-project-'))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
  )
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  for (const name of ['lib', 'other', 'third']) {
    const dir = path.join(root, 'packages', name)
    await mkdir(path.join(dir, 'src'), { recursive: true })
    const deps = name === 'lib' ? { dependencies: { dep: 'file:../other/vendor' } } : {}
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', ...deps }),
    )
    await writeFile(path.join(dir, 'src', 'index.js'), `// ${name}\n`)
    await writeFile(path.join(dir, 'vx.config.mjs'), BUILD)
  }
  await mkdir(path.join(root, 'packages/other/vendor'), { recursive: true })
  await writeFile(
    path.join(root, 'packages/other/vendor/package.json'),
    JSON.stringify({ name: 'dep', version: '1.0.0' }),
  )
  await writeFile(path.join(root, 'packages/other/vendor/index.js'), '// dep v1\n')
  await writeFile(path.join(root, 'pnpm-lock.yaml'), LOCK)
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource(['pnpm()'], `import { pnpm } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const hashes = async (): Promise<Record<string, string>> => {
  const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
  return Object.fromEntries(plan.tasks.map((t) => [t.node.id, t.hash]))
}

it('an edit to a `file:` directory inside another project selects the project reaching it', async () => {
  commitAll(root)
  const before = await hashes()
  await writeFile(path.join(root, 'packages/other/vendor/index.js'), '// dep v2\n')
  expect(moved(before, await hashes())).toEqual(['lib#build'])
  expect(affectedIds(root, 'build')).toContain('lib#build')
})

it('CONTROL: an edit beside it in that project selects no project the lockfile reaches', async () => {
  await hashes()
  commitAll(root)
  await writeFile(path.join(root, 'packages/other/src/index.js'), '// other v2\n')
  expect(affectedIds(root, 'build')).toEqual(['other#build'])
})

it('with no memo yet (a fresh clone) the edit still selects the project reaching it', async () => {
  await hashes()
  commitAll(root)
  await writeFile(path.join(root, 'packages/other/vendor/index.js'), '// dep v2\n')
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  db.run('DELETE FROM lockfile_memos')
  db.close()
  expect(affectedIds(root, 'build')).toContain('lib#build')
})

it('the files --affected is told the lockfile names come from the memo once a run wrote it', async () => {
  await hashes()
  const cacheDir = path.join(root, '.vx', 'cache')
  expect(Object.keys(readMemo(cacheDir, 'pnpm-lock.yaml').extras)).toEqual([
    'packages/other/vendor',
  ])
  editMemo(cacheDir, 'pnpm-lock.yaml', (m) => {
    m.extras = { 'from/the/memo': '' }
  })
  const { pnpm } = await import('../src/index.js')
  const ctx = {
    workspaceRoot: root,
    cacheDir: path.join(root, '.vx', 'cache'),
    warn() {},
    projects: [],
  }
  const bytes = await Bun.file(path.join(root, 'pnpm-lock.yaml')).bytes()
  expect(await pnpm().fingerprint!.extraFiles!('pnpm-lock.yaml', bytes, ctx)).toEqual([
    'from/the/memo',
  ])
})
