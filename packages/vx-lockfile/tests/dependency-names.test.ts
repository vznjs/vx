// What a package resolves is the NAME it asks for and the package that
// name installs. pnpm and yarn berry folded only where each dependency
// lands, so a swap of two aliases (`foo: npm:x@1, bar: npm:y@1` →
// `foo: npm:y@1, bar: npm:x@1`) reached the same packages and kept the
// key, while `require('foo')` now loads y. The root's swap kept every
// project's key (its tools are on every task's path); a workspace's kept
// the key of each project linking it.
import { describe, expect, it } from 'bun:test'
import * as pnpmLock from '../src/pnpm.js'
import * as yarnLock from '../src/yarn.js'

const pnpmText = (foo: string, bar: string): string => `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      foo:
        specifier: npm:${foo}@1.0.0
        version: ${foo}@1.0.0
      bar:
        specifier: npm:${bar}@1.0.0
        version: ${bar}@1.0.0

  packages/a: {}

packages:

  x@1.0.0:
    resolution: {integrity: sha512-x}

  y@1.0.0:
    resolution: {integrity: sha512-y}

snapshots:

  x@1.0.0: {}

  y@1.0.0: {}
`

const yarnText = (foo: string, bar: string): string => `__metadata:
  version: 8
  cacheKey: 10c0

"a@workspace:packages/a":
  version: 0.0.0-use.local
  resolution: "a@workspace:packages/a"
  dependencies:
    bar: "npm:${bar}@1.0.0"
    foo: "npm:${foo}@1.0.0"
  languageName: unknown
  linkType: soft

"bar@npm:${bar}@1.0.0":
  version: 1.0.0
  resolution: "${bar}@npm:1.0.0"
  checksum: 10c0/${bar}
  languageName: node
  linkType: hard

"foo@npm:${foo}@1.0.0":
  version: 1.0.0
  resolution: "${foo}@npm:1.0.0"
  checksum: 10c0/${foo}
  languageName: node
  linkType: hard

"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  languageName: unknown
  linkType: soft
`

describe('a swap of two aliases moves the key', () => {
  it('pnpm(): the root importer', () => {
    const d = (foo: string, bar: string) =>
      pnpmLock.importerDigests(pnpmLock.parseLockfile(pnpmText(foo, bar)))
    expect(d('y', 'x').get('.')).not.toBe(d('x', 'y').get('.'))
    // CONTROL: a project that names neither keeps its own reach.
    expect(d('y', 'x').get('packages/a')).toBe(d('x', 'y').get('packages/a'))
  })

  it('yarn() berry: a workspace', () => {
    const d = (foo: string, bar: string) =>
      yarnLock.importerDigests(yarnLock.parseLockfile(yarnText(foo, bar)))
    expect(d('y', 'x').get('packages/a')).not.toBe(d('x', 'y').get('packages/a'))
    // CONTROL: the root names neither.
    expect(d('y', 'x').get('.')).toBe(d('x', 'y').get('.'))
  })
})
