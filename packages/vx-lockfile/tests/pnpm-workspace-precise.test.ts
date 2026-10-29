// pnpm 10+ keeps `patchedDependencies` and `overrides` in
// pnpm-workspace.yaml, and the install records what each one did in
// pnpm-lock.yaml, per project (D-142). Folded whole into every task, one
// patch for a package only `lib` reaches re-keyed every project (Growth's
// pnpm-workspace-yaml-rekeys-all, 2026-10-17; Turbo keys it per closure).
// The rest of the file still lays out every install.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { TaskNode } from '@vzn/vx'
import { pnpm } from '../src/index.js'
import * as pnpmLock from '../src/pnpm.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-pnpm-ws-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const key = async (): Promise<string> => {
  const ctx = { workspaceRoot: root, cacheDir: path.join(root, '.vx', 'cache'), warn() {} }
  return JSON.stringify(await pnpm().key!({ projectDir: root } as TaskNode, ctx))
}
const write = (text: string): Promise<void> =>
  writeFile(path.join(root, 'pnpm-workspace.yaml'), text)
const affected = async (before: string, after: string): Promise<unknown> => {
  const enc = new TextEncoder()
  const change = {
    file: 'pnpm-workspace.yaml',
    before: enc.encode(before),
    after: enc.encode(after),
  }
  const ctx = { workspaceRoot: root, cacheDir: root, warn() {}, projects: [] }
  return pnpm().fingerprint!.affected(change, ctx)
}

const BASE = "packages:\n  - 'packages/*'\n"
const PATCHED = `${BASE}patchedDependencies:\n  is-number@7.0.0: patches/is-number@7.0.0.patch\n`
const OVERRIDDEN = `${PATCHED}overrides:\n  is-odd>is-number: 7.0.0\n`

it('a patch or an override in pnpm-workspace.yaml keys no task by itself', async () => {
  await write(BASE)
  const base = await key()
  await write(PATCHED)
  expect(await key()).toBe(base)
  await write(OVERRIDDEN)
  expect(await key()).toBe(base)
  expect(await affected(BASE, OVERRIDDEN)).toEqual([])
})

it('a catalog in pnpm-workspace.yaml keys no task by itself', async () => {
  // pnpm-lock.yaml records what each catalog entry resolved to and the
  // importers naming it (probed, pnpm 10.28: a bump re-keys b and c, its
  // dependent, and an entry no importer names leaves the lockfile as it
  // was). Folded whole, one bump re-keyed every project.
  await write(BASE)
  const base = await key()
  const CATALOGS = `${BASE}catalog:\n  is-number: 7.0.0\ncatalogs:\n  next:\n    is-odd: 3.0.1\n`
  await write(CATALOGS)
  expect(await key()).toBe(base)
  expect(await affected(BASE, CATALOGS)).toEqual([])
})

it('any other pnpm-workspace.yaml setting keys every task, and a file that does not parse folds whole', async () => {
  await write(BASE)
  const base = await key()
  await write(`${OVERRIDDEN}nodeLinker: hoisted\n`)
  expect(await key()).not.toBe(base)
  expect(await affected(OVERRIDDEN, `${OVERRIDDEN}nodeLinker: hoisted\n`)).toBeUndefined()
  await write('packages: [\n')
  const broken = await key()
  await write('packages: [[\n')
  expect(await key()).not.toBe(broken)
  expect(await affected('packages: [\n', 'packages: [[\n')).toBeUndefined()
})

// Where a patch applies is the lockfile's to say: pnpm-lock.yaml records
// each patch's hash, and the package it patches sits in some projects'
// closures only (2026-10-17: "Our pnpm should be able to tell where
// the patch version is used").
const lock = (hash: string): string => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

patchedDependencies:
  is-number@7.0.0:
    hash: ${hash}
    path: patches/is-number@7.0.0.patch

importers:

  .: {}

  packages/a:
    dependencies:
      is-buffer:
        specifier: 1.1.6
        version: 1.1.6

  packages/b:
    dependencies:
      is-odd:
        specifier: 3.0.1
        version: 3.0.1

packages:

  is-buffer@1.1.6:
    resolution: {integrity: sha512-buf}

  is-number@7.0.0:
    resolution: {integrity: sha512-n7}

  is-odd@3.0.1:
    resolution: {integrity: sha512-odd}

snapshots:

  is-buffer@1.1.6: {}

  is-number@7.0.0: {}

  is-odd@3.0.1:
    dependencies:
      is-number: 7.0.0
`

it('a patch edit moves only the projects whose closure holds the patched package', () => {
  const one = pnpmLock.importerDigests(pnpmLock.parseLockfile(lock('h1')))
  const two = pnpmLock.importerDigests(pnpmLock.parseLockfile(lock('h2')))
  expect([...one.keys()].sort()).toEqual(['.', 'packages/a', 'packages/b'])
  expect([...one.keys()].filter((d) => one.get(d) !== two.get(d))).toEqual(['packages/b'])
})

// pnpm 10 reads install settings from the root package.json's `pnpm`
// field too, and the lockfile records none of `onlyBuiltDependencies`:
// adding `dep` there ran its postinstall under a byte-identical
// pnpm-lock.yaml (probed, pnpm 10.28), and no key moved. The rest of the
// manifest is the lockfile's to record, or the root's own input.
it("the root package.json's pnpm field keys every task, but for what the lockfile records", async () => {
  const manifest = (pkg: Record<string, unknown>): Promise<void> =>
    writeFile(path.join(root, 'package.json'), JSON.stringify(pkg))
  await manifest({ name: 'root', private: true })
  const base = await key()
  await manifest({ name: 'root', private: true, devDependencies: { x: '1.0.0' } })
  expect(await key()).toBe(base)
  await manifest({ name: 'root', pnpm: { overrides: { x: '2' }, patchedDependencies: { x: 'p' } } })
  expect(await key()).toBe(base)
  await manifest({ name: 'root', pnpm: { onlyBuiltDependencies: ['dep'] } })
  expect(await key()).not.toBe(base)
  const enc = new TextEncoder()
  const ctx = { workspaceRoot: root, cacheDir: root, warn() {}, projects: [] }
  const affectedBy = (before: unknown, after: unknown): unknown =>
    pnpm().fingerprint!.affected(
      {
        file: 'package.json',
        before: enc.encode(JSON.stringify(before)),
        after: enc.encode(JSON.stringify(after)),
      },
      ctx,
    )
  expect(await affectedBy({ name: 'root' }, { name: 'root', dependencies: { x: '1' } })).toEqual([])
  expect(
    await affectedBy({ name: 'root' }, { name: 'root', pnpm: { neverBuiltDependencies: ['x'] } }),
  ).toBeUndefined()
})
