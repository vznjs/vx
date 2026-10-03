// One row across the four parsers: a bump in one project's closure
// re-keys that project alone. `a` → x, `b` → y, `c` → x and the
// workspace `b`; the root depends on nothing. Shapes as each manager
// writes them (pnpm 9, bun 1.4, npm 10, yarn 4).
import { expect, it } from 'bun:test'
import * as bun from '../src/bun.js'
import * as npm from '../src/npm.js'
import * as pnpm from '../src/pnpm.js'
import * as yarn from '../src/yarn.js'

type V = { x: string; y: string }

const pnpmLock = ({ x, y }: V) => `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .: {}
  packages/a:
    dependencies:
      x:
        specifier: ^1.0.0
        version: ${x}
  packages/b:
    dependencies:
      y:
        specifier: ^1.0.0
        version: ${y}
  packages/c:
    dependencies:
      b:
        specifier: workspace:*
        version: link:../b
      x:
        specifier: ^1.0.0
        version: ${x}
packages:
  x@${x}:
    resolution: {integrity: sha512-x${x}}
  y@${y}:
    resolution: {integrity: sha512-y${y}}
snapshots:
  x@${x}: {}
  y@${y}: {}
`

const bunLock = ({ x, y }: V) => `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "root" },
    "packages/a": { "name": "a", "dependencies": { "x": "^1.0.0" } },
    "packages/b": { "name": "b", "dependencies": { "y": "^1.0.0" } },
    "packages/c": { "name": "c", "dependencies": { "b": "workspace:*", "x": "^1.0.0" } },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],
    "b": ["b@workspace:packages/b"],
    "c": ["c@workspace:packages/c"],
    "x": ["x@${x}", "", {}, "sha512-x${x}"],
    "y": ["y@${y}", "", {}, "sha512-y${y}"],
  }
}`

const npmLock = ({ x, y }: V) =>
  JSON.stringify({
    name: 'root',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'root', workspaces: ['packages/*'] },
      'node_modules/a': { resolved: 'packages/a', link: true },
      'node_modules/b': { resolved: 'packages/b', link: true },
      'node_modules/c': { resolved: 'packages/c', link: true },
      'node_modules/x': { version: x, resolved: `https://r/x-${x}.tgz`, integrity: `sha512-x${x}` },
      'node_modules/y': { version: y, resolved: `https://r/y-${y}.tgz`, integrity: `sha512-y${y}` },
      'packages/a': { name: 'a', version: '1.0.0', dependencies: { x: '^1.0.0' } },
      'packages/b': { name: 'b', version: '1.0.0', dependencies: { y: '^1.0.0' } },
      'packages/c': { name: 'c', version: '1.0.0', dependencies: { b: '*', x: '^1.0.0' } },
    },
  })

const yarnLock = ({ x, y }: V) => `__metadata:
  version: 8
  cacheKey: 10c0

"a@workspace:packages/a":
  version: 0.0.0-use.local
  resolution: "a@workspace:packages/a"
  dependencies:
    x: "npm:^1.0.0"
  languageName: unknown
  linkType: soft

"b@workspace:*, b@workspace:packages/b":
  version: 0.0.0-use.local
  resolution: "b@workspace:packages/b"
  dependencies:
    y: "npm:^1.0.0"
  languageName: unknown
  linkType: soft

"c@workspace:packages/c":
  version: 0.0.0-use.local
  resolution: "c@workspace:packages/c"
  dependencies:
    b: "workspace:*"
    x: "npm:^1.0.0"
  languageName: unknown
  linkType: soft

"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  languageName: unknown
  linkType: soft

"x@npm:^1.0.0":
  version: ${x}
  resolution: "x@npm:${x}"
  checksum: 10c0/x${x}
  languageName: node
  linkType: hard

"y@npm:^1.0.0":
  version: ${y}
  resolution: "y@npm:${y}"
  checksum: 10c0/y${y}
  languageName: node
  linkType: hard
`

const PARSERS: [string, (v: V) => ReadonlyMap<string, string>][] = [
  ['pnpm', (v) => pnpm.importerDigests(pnpm.parseLockfile(pnpmLock(v)))],
  ['bun', (v) => bun.importerDigests(bun.parseLockfile(bunLock(v)))],
  ['npm', (v) => npm.importerDigests(npm.parseLockfile(npmLock(v)))],
  ['yarn', (v) => yarn.importerDigests(yarn.parseLockfile(yarnLock(v)))],
]

const BASE: V = { x: '1.0.0', y: '1.0.0' }

const moved = (digest: (v: V) => ReadonlyMap<string, string>, bump: Partial<V>) => {
  const a = digest(BASE)
  const b = digest({ ...BASE, ...bump })
  expect([...a.keys()].sort()).toEqual(['.', 'packages/a', 'packages/b', 'packages/c'])
  return [...a.keys()].filter((d) => a.get(d) !== b.get(d)).sort()
}

it.each(PARSERS)('%s: a bump re-keys only the projects whose closure holds it', (_, digest) => {
  expect(moved(digest, { y: '1.0.1' })).toEqual(['packages/b', 'packages/c'])
  expect(moved(digest, { x: '1.0.1' })).toEqual(['packages/a', 'packages/c'])
})

it.each(PARSERS)('%s: CONTROL: no bump moves nothing', (_, digest) => {
  expect(moved(digest, {})).toEqual([])
})
