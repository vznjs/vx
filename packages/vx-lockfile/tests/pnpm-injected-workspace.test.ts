// pnpm 10 with `dependenciesMeta.b.injected` in packages/c, b a workspace
// package: the file records `version: file:packages/b`, an edge to b
// (`importerLinks`), and c's `^build` waits for b's. Its directory was
// also hashed as a `file:` copy's content, b's build output included: a
// build of b re-keyed c whatever b's inputs, and a clean checkout keyed c
// apart from a built tree.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { pnpm } from '../src/index.js'
import { lockedKey } from './helpers/key.js'

const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

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
  expect([...named]).toEqual(['vendor/dep'])
})
