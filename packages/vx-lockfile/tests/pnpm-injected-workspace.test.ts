// pnpm 10 with `dependenciesMeta.b.injected` in packages/c, b a workspace
// package: the file records `version: file:packages/b`, an edge to b
// (`importerLinks`), and c's `^build` waits for b's. Its directory was
// also hashed as a `file:` copy's content, b's build output included: a
// build of b re-keyed c whatever b's inputs, and a clean checkout keyed c
// apart from a built tree.
//
// What c reads is pnpm's copy of b (node_modules/.pnpm/b@file+packages+b),
// which pnpm re-syncs at install, not after a build vx runs: keyed as an
// edge alone, c#build after b's edit read the old copy and saved its bytes
// under the key of b's new inputs, and after `pnpm install` re-synced the
// copy the next run hit and replayed them. The copy's content is keyed.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { type Logger } from '@vzn/vx'
import { planRun } from '../../vx/tests/helpers/orchestrator.js'
import { pnpm } from '../src/index.js'
import { affectedIds, commitAll, lockAt, moved } from './helpers/affected.js'
import { lockedKey } from './helpers/key.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  packages/a: {}

  packages/b: {}

  packages/c:
    dependencies:
      b:
        specifier: workspace:*
        version: file:packages/b
      dep:
        specifier: file:../../vendor/dep
        version: file:vendor/dep
    dependenciesMeta:
      b:
        injected: true

packages:

  b@file:packages/b:
    resolution: {directory: packages/b, type: directory}

  dep@file:vendor/dep:
    resolution: {directory: vendor/dep, type: directory}

snapshots:

  b@file:packages/b: {}

  dep@file:vendor/dep: {}
`

let root: string
const write = async (rel: string, text: string): Promise<void> => {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await writeFile(path.join(root, rel), text)
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-pnpm-injected-'))
  await write('package.json', JSON.stringify({ name: 'r', private: true }))
  await write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n")
  await write('packages/b/package.json', JSON.stringify({ name: 'b', version: '1.0.0' }))
  await write('packages/b/dist/index.js', '// v1\n')
  await write('vendor/dep/index.js', '// v1\n')
  await write('pnpm-lock.yaml', LOCK)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const key = async (): Promise<string> =>
  JSON.stringify(
    await lockedKey(pnpm(), root, path.join(root, '.vx', 'cache'), path.join(root, 'packages/c')),
  )

it("an edit under an injected workspace package's directory moves no key", async () => {
  const before = await key()
  await write('packages/b/dist/index.js', '// v2\n')
  expect(await key()).toBe(before)
})

it('CONTROL: an edit under a `file:` directory that is no workspace moves the key', async () => {
  const before = await key()
  await write('vendor/dep/index.js', '// v2\n')
  expect(await key()).not.toBe(before)
})

it("--affected's extra files leave out an injected workspace package, as the key does", async () => {
  const ctx = {
    workspaceRoot: root,
    cacheDir: path.join(root, '.vx', 'cache'),
    warn() {},
    projects: [],
  }
  const bytes = await Bun.file(path.join(root, 'pnpm-lock.yaml')).bytes()
  const named = await pnpm().fingerprint!.extraFiles!('pnpm-lock.yaml', bytes, ctx)
  // Its copies, where Node finds them from c: c's own node_modules (the
  // isolated linker), the root's (hoisted).
  expect([...named]).toEqual(['node_modules/b', 'packages/c/node_modules/b', 'vendor/dep'])
})

const COPY = 'node_modules/.pnpm/b@file+packages+b/node_modules/b'
const BUILD =
  "export default { tasks: { build: { exec: { command: 'echo built' }, inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true } } }\n"
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

const workspace = async (copyAt: 'isolated' | 'hoisted'): Promise<void> => {
  for (const name of ['a', 'b', 'c']) {
    await write(`packages/${name}/src/index.js`, `// ${name}\n`)
    await write(`packages/${name}/vx.config.mjs`, BUILD)
  }
  await write('packages/a/package.json', JSON.stringify({ name: 'a', version: '1.0.0' }))
  await write(
    'packages/c/package.json',
    JSON.stringify({
      name: 'c',
      version: '1.0.0',
      dependencies: { b: 'workspace:*', dep: 'file:../../vendor/dep' },
      dependenciesMeta: { b: { injected: true } },
    }),
  )
  await write('.gitignore', 'node_modules\n.vx/cache\n')
  const at = copyAt === 'isolated' ? COPY : 'node_modules/b'
  await write(`${at}/package.json`, JSON.stringify({ name: 'b', version: '1.0.0' }))
  await write(`${at}/dist/index.js`, '// v1\n')
  if (copyAt === 'isolated') {
    await mkdir(path.join(root, 'packages/c/node_modules'), { recursive: true })
    await symlink(`../../../${COPY}`, path.join(root, 'packages/c/node_modules/b'))
  }
  await write(
    '.vx/workspace.mjs',
    localWorkspaceSource(
      ['pnpm()'],
      `import { pnpm } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'index.ts'))}\n`,
    ),
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
}

const hashes = async (): Promise<Record<string, string>> => {
  const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
  return Object.fromEntries(plan.tasks.map((t) => [t.node.id, t.hash]))
}

for (const copyAt of ['isolated', 'hoisted'] as const) {
  it(`${copyAt}: a re-synced injected copy re-keys and selects only its dependant`, async () => {
    await workspace(copyAt)
    lockAt(root)
    commitAll(root)
    const before = await hashes()
    // CONTROL: nothing changed, nothing moves.
    expect(moved(before, await hashes())).toEqual([])
    expect(affectedIds(root, 'build', { lock: false })).toEqual([])
    // `pnpm install` after b's build: the copy now holds b's new output,
    // with no relock.
    await write(`${copyAt === 'isolated' ? COPY : 'node_modules/b'}/dist/index.js`, '// v2\n')
    expect(moved(before, await hashes())).toEqual(['c#build'])
    expect(affectedIds(root, 'build', { lock: false })).toEqual(['c#build'])
  })
}

// The lock records the copy's hash, which is local build state: a fresh
// clone's install copies b with no `dist/`. `vx lock --check` (the CI gate)
// passes there, as a run digests anew, but still fails a stale record.
it("`vx lock --check` passes where the injected copy differs from the lock's", async () => {
  await workspace('isolated')
  lockAt(root)
  const check = (): number =>
    Bun.spawnSync({
      cmd: [
        process.execPath,
        path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'bin.ts'),
        'lock',
        '--check',
      ],
      cwd: root,
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
    }).exitCode
  expect(check()).toBe(0)
  // CONTROL: a record that is not what the dependencies resolve to fails.
  const lockPath = path.join(root, '.vx/dependencies.lock.json')
  const rec = await Bun.file(lockPath).text()
  const bad = JSON.parse(rec) as { files: Record<string, { digests: string[] }> }
  bad.files['pnpm-lock.yaml']!.digests = bad.files['pnpm-lock.yaml']!.digests.map(() => '0')
  await writeFile(lockPath, JSON.stringify(bad))
  expect(check()).toBe(1)
  await writeFile(lockPath, rec)
  await rm(path.join(root, COPY, 'dist'), { recursive: true })
  expect(check()).toBe(0)
  await rm(path.join(root, 'packages/c/node_modules'), { recursive: true })
  expect(check()).toBe(0)
  // A run keys there too, digesting anew rather than refusing.
  expect(Object.keys(await hashes())).toContain('c#build')
})
