// A link a lockfile records to a path above the workspace root is no edge.
// The path join dropped each `..` past the root, so `link:../ext` from the
// root read as `ext`, and an importer there got an edge it never installed.
import { expect, it } from 'bun:test'
import * as bunLock from '../src/bun.js'
import * as pnpmLock from '../src/pnpm.js'
import * as yarnLock from '../src/yarn.js'

it('pnpm: link:../ext from the root names no importer at ext', () => {
  const links = pnpmLock.importerLinks(
    pnpmLock.parseLockfile(`lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      ext:
        specifier: link:../ext
        version: link:../ext

  ext: {}
`),
  )
  expect(links.get('.')?.deps).toEqual({})
})

it('bun: workspace:../ext from the root names no workspace at ext', () => {
  const links = bunLock.importerLinks(
    bunLock.parseLockfile(`{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "root", "dependencies": { "ext": "workspace:../ext" } },
    "ext": { "name": "other" },
  },
  "packages": {
    "ext": ["ext@workspace:../ext"],
    "other": ["other@workspace:ext"],
  }
}
`),
  )
  expect(links.get('.')?.deps).toEqual({})
})

it('yarn: a portal to ../../ext from packages/a names no workspace at ext', () => {
  const owner = 'a@workspace:packages/a'
  const links = yarnLock.importerLinks(
    yarnLock.parseLockfile(`__metadata:
  version: 8
  cacheKey: 10c0

"a@workspace:packages/a":
  version: 0.0.0-use.local
  resolution: "a@workspace:packages/a"
  dependencies:
    x: "portal:../../../ext"
  languageName: unknown
  linkType: soft

"ext@workspace:ext":
  version: 0.0.0-use.local
  resolution: "ext@workspace:ext"
  languageName: unknown
  linkType: soft

"x@portal:../../../ext::locator=${encodeURIComponent(owner)}":
  version: 0.0.0-use.local
  resolution: "x@portal:../../../ext::locator=${encodeURIComponent(owner)}"
  languageName: node
  linkType: soft
`),
  )
  expect(links.get('packages/a')?.deps).toEqual({})
})
