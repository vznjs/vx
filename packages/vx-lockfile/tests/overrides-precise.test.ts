// An override is how a resolution was forced; what it forced is the
// package entry a project reaches. Folded into every project, one pnpm 9
// override that only `b`'s tree reached re-keyed `a` and the root too, and
// so did an override edit that resolved the same version (probed on a real
// install). Each manager now keys an override through that entry (D-142).
import { expect, it } from 'bun:test'
import * as bunLock from '../src/bun.js'
import * as pnpmLock from '../src/pnpm.js'

const moved = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>) =>
  [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort()

/** pnpm 9's lockfile for `a` → is-buffer, `b` → is-odd → is-number@`n`. */
function pnpm(overrides: string, n: string): string {
  return `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
${overrides}
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

  is-number@${n}:
    resolution: {integrity: sha512-n${n}}

  is-odd@3.0.1:
    resolution: {integrity: sha512-odd}

snapshots:

  is-buffer@1.1.6: {}

  is-number@${n}: {}

  is-odd@3.0.1:
    dependencies:
      is-number: ${n}
`
}

const pnpmDigests = (t: string) => pnpmLock.importerDigests(pnpmLock.parseLockfile(t))
const ov = (range: string) => `\noverrides:\n  is-number: ${range}\n`

it('pnpm: an override edit that resolves the same version moves no importer', () => {
  expect(
    moved(pnpmDigests(pnpm(ov('7.0.0'), '7.0.0')), pnpmDigests(pnpm(ov('^7.0.0'), '7.0.0'))),
  ).toEqual([])
})

it('pnpm: an override that forces a new version moves the importer reaching it alone', () => {
  expect(moved(pnpmDigests(pnpm('', '6.0.0')), pnpmDigests(pnpm(ov('7.0.0'), '7.0.0')))).toEqual([
    'packages/b',
  ])
})

it('bun: an override edit that resolves the same version moves no workspace', () => {
  const text = (range: string) => `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "ws" },
    "packages/b": { "name": "b", "dependencies": { "is-odd": "3.0.1" } },
  },
  "overrides": { "is-number": "${range}" },
  "packages": {
    "b": ["b@workspace:packages/b"],
    "is-number": ["is-number@7.0.0", "", {}, "sha512-n7"],
    "is-odd": ["is-odd@3.0.1", "", { "dependencies": { "is-number": "^6.0.0" } }, "sha512-odd"],
  }
}`
  const d = (t: string) => bunLock.importerDigests(bunLock.parseLockfile(t))
  expect(moved(d(text('7.0.0')), d(text('^7.0.0')))).toEqual([])
})

it('CONTROL: a version an override forces still moves the importer that reaches it', () => {
  expect(moved(pnpmDigests(pnpm('', '6.0.0')), pnpmDigests(pnpm(ov('7.0.0'), '7.0.0')))).toContain(
    'packages/b',
  )
})
