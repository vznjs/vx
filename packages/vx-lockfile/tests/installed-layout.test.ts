// Where the lockfile's layout and the install's differ, a digest keyed on
// the lockfile's missed what a project loads. The lockfiles are the ones
// real installs wrote (bun 1.4.4, pnpm 10.28) for a (react 18) and b
// (react 19), cut to what each test needs.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as bunLock from '../src/bun.js'
import { pnpm } from '../src/index.js'
import * as pnpmLock from '../src/pnpm.js'
import { hoistedLinker } from '../src/pnpm-settings.js'
import { lockedKey } from './helpers/key.js'

const REACT_18 = `"react": ["react@18.3.1", "", { "dependencies": { "loose-envify": "^1.1.0" } }, "sha512-r18"],
    "loose-envify": ["loose-envify@1.4.0", "", {}, "sha512-le"],`

// Bun's isolated linker (the default for a workspace written with
// `configVersion: 1`) links a peer from the store, not by the hoisted walk:
// packages/c/node_modules/react -> .bun/react@19.0.0 while the walk from c
// lands on the root react@18.3.1. A bump of b's react moved what c (and a,
// through c) loads and no key.
describe('bun(): a peer under the isolated linker', () => {
  const text = (bReact: string): string => `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": { "name": "root" },
    "packages/a": { "name": "a", "dependencies": { "c": "workspace:*", "react": "18.3.1" } },
    "packages/b": { "name": "b", "dependencies": { "c": "workspace:*", "react": "${bReact}" } },
    "packages/c": { "name": "c", "peerDependencies": { "react": "*" } },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],
    "b": ["b@workspace:packages/b"],
    "c": ["c@workspace:packages/c"],
    ${REACT_18}
    "b/react": ["react@${bReact}", "", {}, "sha512-r${bReact}"],
  }
}
`
  const digests = (bReact: string) => bunLock.importerDigests(bunLock.parseLockfile(text(bReact)))

  it("a workspace's peer folds every installed copy of its name", () => {
    const [before, after] = [digests('19.0.0'), digests('19.1.0')]
    expect(after.get('packages/c')).not.toBe(before.get('packages/c'))
    expect(after.get('packages/a')).not.toBe(before.get('packages/a'))
    // CONTROL: the root reaches no react.
    expect(after.get('.')).toBe(before.get('.'))
  })

  // b has no react of its own; the isolated linker gave its store copy of
  // use-sync-external-store c's react@19.0.0, the walk the root's 18.3.1.
  it("a package's peer folds every installed copy of its name", () => {
    const pkgText = (cReact: string): string => `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": { "name": "root" },
    "packages/a": { "name": "a", "dependencies": { "react": "18.3.1" } },
    "packages/b": { "name": "b", "dependencies": { "use-sync-external-store": "1.4.0" } },
    "packages/c": { "name": "c", "dependencies": { "react": "${cReact}" } },
  },
  "packages": {
    ${REACT_18}
    "use-sync-external-store": ["use-sync-external-store@1.4.0", "", { "peerDependencies": { "react": "^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0" } }, "sha512-us"],
    "c/react": ["react@${cReact}", "", {}, "sha512-r${cReact}"],
  }
}
`
    const d = (cReact: string) => bunLock.importerDigests(bunLock.parseLockfile(pkgText(cReact)))
    const [before, after] = [d('19.0.0'), d('19.1.0')]
    expect(after.get('packages/b')).not.toBe(before.get('packages/b'))
    // CONTROL: a reaches no peer.
    expect(after.get('packages/a')).toBe(before.get('packages/a'))
  })
})

// pnpm's hoisted linker installs one copy per name@version, whatever the
// lockfile's peer variants: one root @tanstack/react-query with a's
// react@18.3.1 nested under it, which b loads, while b's snapshot is
// `@tanstack/react-query@5.59.0(react@19.0.0)`.
const pnpmText = (aReact: string): string => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  packages/a:
    dependencies:
      '@tanstack/react-query':
        specifier: 5.59.0
        version: 5.59.0(react@${aReact})
      react:
        specifier: ${aReact}
        version: ${aReact}

  packages/b:
    dependencies:
      '@tanstack/react-query':
        specifier: 5.59.0
        version: 5.59.0(react@19.0.0)
      react:
        specifier: 19.0.0
        version: 19.0.0

packages:

  '@tanstack/query-core@5.59.0':
    resolution: {integrity: sha512-qc}

  '@tanstack/react-query@5.59.0':
    resolution: {integrity: sha512-rq}
    peerDependencies:
      react: ^18 || ^19

  react@${aReact}:
    resolution: {integrity: sha512-r${aReact}}

  react@19.0.0:
    resolution: {integrity: sha512-r19}

snapshots:

  '@tanstack/query-core@5.59.0': {}

  '@tanstack/react-query@5.59.0(react@${aReact})':
    dependencies:
      '@tanstack/query-core': 5.59.0
      react: ${aReact}

  '@tanstack/react-query@5.59.0(react@19.0.0)':
    dependencies:
      '@tanstack/query-core': 5.59.0
      react: 19.0.0

  react@${aReact}: {}

  react@19.0.0: {}
`

describe('pnpm(): nodeLinker hoisted', () => {
  const digests = (aReact: string, hoisted: boolean) =>
    pnpmLock.importerDigests(pnpmLock.parseLockfile(pnpmText(aReact)), new Map(), hoisted)

  it("folds every peer variant of a package b reaches: a's react moves b", () => {
    const [before, after] = [digests('18.3.1', true), digests('18.2.0', true)]
    expect(after.get('packages/b')).not.toBe(before.get('packages/b'))
    // CONTROL: the root reaches nothing.
    expect(after.get('.')).toBe(before.get('.'))
  })

  it('CONTROL: the isolated layout keeps each variant to its own', () => {
    expect(digests('18.2.0', false).get('packages/b')).toBe(
      digests('18.3.1', false).get('packages/b'),
    )
  })

  it('reads the linker from pnpm-workspace.yaml or .npmrc', () => {
    expect(hoistedLinker('nodeLinker: hoisted\n', undefined)).toBe(true)
    expect(hoistedLinker(undefined, 'node-linker = hoisted\n')).toBe(true)
    expect(hoistedLinker('nodeLinker: isolated\n', 'registry=x\n')).toBe(false)
    expect(hoistedLinker('nodeLinker: pnp\n', undefined)).toBe(false)
    expect(hoistedLinker(undefined, undefined)).toBe(false)
  })

  describe('the plugin key', () => {
    let root: string
    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'vx-pnpm-hoisted-'))
      await mkdir(path.join(root, 'packages/b'), { recursive: true })
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })
    const keyOfB = async (aReact: string): Promise<string> => {
      await writeFile(path.join(root, 'pnpm-lock.yaml'), pnpmText(aReact))
      return JSON.stringify(
        await lockedKey(pnpm(), root, path.join(root, '.vx'), path.join(root, 'packages/b')),
      )
    }

    it("folds a's react into b's key under nodeLinker: hoisted", async () => {
      await writeFile(
        path.join(root, 'pnpm-workspace.yaml'),
        "packages:\n  - 'packages/*'\nnodeLinker: hoisted\n",
      )
      expect(await keyOfB('18.2.0')).not.toBe(await keyOfB('18.3.1'))
    })
  })
})

// `publishConfig: { directory: 'dist', linkDirectory: true }` makes pnpm
// link b's dist (`link:../b/dist`), and the importer records
// `publishDirectory: dist`. Read as a directory no importer holds, the
// link was no edge: a built before b, folded b's dist as plain content and
// none of b's dependencies, which b/dist resolves through packages/b.
describe('pnpm(): a link to a workspace publishDirectory', () => {
  const text = (isOdd: string): string => `lockfileVersion: '9.0'

importers:

  .: {}

  packages/a:
    dependencies:
      b:
        specifier: workspace:*
        version: link:../b/dist

  packages/b:
    dependencies:
      is-odd:
        specifier: ${isOdd}
        version: ${isOdd}
    publishDirectory: dist

packages:

  is-odd@${isOdd}:
    resolution: {integrity: sha512-io${isOdd}}

snapshots:

  is-odd@${isOdd}: {}
`
  const lock = (isOdd: string) => pnpmLock.parseLockfile(text(isOdd))

  it('is an edge to the workspace', () => {
    expect(pnpmLock.importerLinks(lock('3.0.1')).get('packages/a')).toEqual({
      deps: { b: 'packages/b' },
      peers: {},
    })
  })

  it("folds the workspace's reach, not the directory's content", () => {
    const [before, after] = [
      pnpmLock.importerDigests(lock('3.0.1')),
      pnpmLock.importerDigests(lock('3.0.0')),
    ]
    expect(after.get('packages/a')).not.toBe(before.get('packages/a'))
    expect(pnpmLock.fileDeps(lock('3.0.1'))).toEqual([])
  })
})
