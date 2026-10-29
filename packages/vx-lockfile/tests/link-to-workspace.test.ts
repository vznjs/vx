// A `link:` to a workspace's directory (`"y": "link:../b"`) symlinks the
// workspace itself, as `workspace:` does: what a can import through it is
// b's whole reach. Bun 1.4.4 records it `["b@link:./packages/b", {}]` and
// Yarn 4.9 `"y@link:../b::locator=a%40workspace%3Apackages%2Fa"`, each an
// entry with no dependencies, and the link was a leaf: b's `ms` bump
// re-keyed b and not a. The lockfiles are the ones those installs wrote
// for a → b (`link:../b`), b → ms.
import { describe, expect, it } from 'bun:test'
import * as bunLock from '../src/bun.js'

const bunText = (ms: string): string => `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": { "name": "root" },
    "packages/a": { "name": "a", "version": "1.0.0", "dependencies": { "y": "link:../b" } },
    "packages/b": { "name": "b", "version": "1.0.0", "dependencies": { "ms": "${ms}" } },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],
    "b": ["b@workspace:packages/b"],
    "ms": ["ms@${ms}", "", {}, "sha512-ms${ms}"],
    "y": ["b@link:./packages/b", {}],
  }
}
`

describe('bun(): a link: to a workspace', () => {
  const digests = (ms: string) => bunLock.importerDigests(bunLock.parseLockfile(bunText(ms)))

  it("folds the linked workspace's reach", () => {
    const [before, after] = [digests('2.1.3'), digests('2.1.2')]
    expect(after.get('packages/b')).not.toBe(before.get('packages/b'))
    expect(after.get('packages/a')).not.toBe(before.get('packages/a'))
    // CONTROL: the root links nothing.
    expect(after.get('.')).toBe(before.get('.'))
  })

  it('is an edge to the workspace', () => {
    expect(
      bunLock.importerLinks(bunLock.parseLockfile(bunText('2.1.3'))).get('packages/a'),
    ).toEqual({ deps: { y: 'packages/b' }, peers: {} })
  })
})
