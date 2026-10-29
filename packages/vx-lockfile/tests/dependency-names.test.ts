// What a package resolves is the NAME it asks for and the package that
// name installs. pnpm folded only where each dependency
// lands, so a swap of two aliases (`foo: npm:x@1, bar: npm:y@1` →
// `foo: npm:y@1, bar: npm:x@1`) reached the same packages and kept the
// key, while `require('foo')` now loads y. The root's swap kept every
// project's key (its tools are on every task's path); a workspace's kept
// the key of each project linking it.
import { describe, expect, it } from 'bun:test'
import * as pnpmLock from '../src/pnpm.js'

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

describe('a swap of two aliases moves the key', () => {
  it('pnpm(): the root importer', () => {
    const d = (foo: string, bar: string) =>
      pnpmLock.importerDigests(pnpmLock.parseLockfile(pnpmText(foo, bar)))
    expect(d('y', 'x').get('.')).not.toBe(d('x', 'y').get('.'))
    // CONTROL: a project that names neither keeps its own reach.
    expect(d('y', 'x').get('packages/a')).toBe(d('x', 'y').get('packages/a'))
  })
})
