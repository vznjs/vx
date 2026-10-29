// Yarn berry links a plain range to a workspace of that name only under
// `enableTransparentWorkspaces` (its default); off, `b: "npm:^1.0.0"` is
// the registry's b (vercel/turborepo#14294). vx reads which one Yarn chose
// from yarn.lock, never from the setting or the manifests.
import { expect, it } from 'bun:test'
import { importerLinks, parseLockfile } from '../src/yarn.js'

const lock = (b: string) => `__metadata:
  version: 8
  cacheKey: 10c0

"a@workspace:packages/a":
  version: 0.0.0-use.local
  resolution: "a@workspace:packages/a"
  dependencies:
    b: "npm:^1.0.0"
  languageName: unknown
  linkType: soft

${b}
`

const workspaceB = `"b@npm:^1.0.0, b@workspace:packages/b":
  version: 0.0.0-use.local
  resolution: "b@workspace:packages/b"
  languageName: unknown
  linkType: soft`

const registryB = `"b@npm:^1.0.0":
  version: 1.2.0
  resolution: "b@npm:1.2.0"
  checksum: 10c0/abc
  languageName: node
  linkType: hard

"b@workspace:packages/b":
  version: 0.0.0-use.local
  resolution: "b@workspace:packages/b"
  languageName: unknown
  linkType: soft`

it('an npm: range Yarn linked to the workspace is an edge to it', () => {
  expect(importerLinks(parseLockfile(lock(workspaceB))).get('packages/a')?.deps).toEqual({
    b: 'packages/b',
  })
})

it('with transparent workspaces off, the same range is the registry copy: no edge', () => {
  expect(importerLinks(parseLockfile(lock(registryB))).get('packages/a')?.deps).toEqual({})
})
