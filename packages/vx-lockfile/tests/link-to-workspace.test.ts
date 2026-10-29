// A `link:` to a workspace's directory (`"y": "link:../b"`) symlinks the
// workspace itself, as `workspace:` does: what a can import through it is
// b's whole reach. Bun 1.4.4 records it `["b@link:./packages/b", {}]` and
// Yarn 4.9 `"y@link:../b::locator=a%40workspace%3Apackages%2Fa"`, each an
// entry with no dependencies, and the link was a leaf: b's `ms` bump
// re-keyed b and not a. The lockfiles are the ones those installs wrote
// for a → b (`link:../b`), b → ms.
import { describe, expect, it } from 'bun:test'
import * as bunLock from '../src/bun.js'
import * as yarnLock from '../src/yarn.js'

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

const yarnText = (ms: string): string => `__metadata:
  version: 8
  cacheKey: 10c0

"a@workspace:packages/a":
  version: 0.0.0-use.local
  resolution: "a@workspace:packages/a"
  dependencies:
    y: "link:../b"
  languageName: unknown
  linkType: soft

"b@workspace:packages/b":
  version: 0.0.0-use.local
  resolution: "b@workspace:packages/b"
  dependencies:
    ms: "npm:${ms}"
  languageName: unknown
  linkType: soft

"ms@npm:${ms}":
  version: ${ms}
  resolution: "ms@npm:${ms}"
  checksum: 10c0/ms${ms}
  languageName: node
  linkType: hard

"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  languageName: unknown
  linkType: soft

"y@link:../b::locator=a%40workspace%3Apackages%2Fa":
  version: 0.0.0-use.local
  resolution: "y@link:../b::locator=a%40workspace%3Apackages%2Fa"
  languageName: node
  linkType: soft
`

describe('yarn() berry: a link: to a workspace', () => {
  const digests = (text: string) => yarnLock.importerDigests(yarnLock.parseLockfile(text))

  it("folds the linked workspace's reach", () => {
    const [before, after] = [digests(yarnText('2.1.3')), digests(yarnText('2.1.2'))]
    expect(after.get('packages/b')).not.toBe(before.get('packages/b'))
    expect(after.get('packages/a')).not.toBe(before.get('packages/a'))
    // CONTROL: the root links nothing.
    expect(after.get('.')).toBe(before.get('.'))
  })

  it('a portal: to a workspace folds it too', () => {
    const portal = (ms: string) => yarnText(ms).replaceAll('link:../b', 'portal:../b')
    const [before, after] = [digests(portal('2.1.3')), digests(portal('2.1.2'))]
    expect(after.get('packages/a')).not.toBe(before.get('packages/a'))
  })
})
