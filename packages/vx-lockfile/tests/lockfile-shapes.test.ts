// Lockfile shapes the package managers write that a parser keyed on the
// common case misreads: an `npm:` alias, a manifest with no dependency
// field, a pnpm lockfile with no `packages:` block or written with CRLF,
// pnpm 11's string patch hashes, every bun.lock version. Each case keys
// the importer that reaches the entry and no other.
import { describe, expect, it } from 'bun:test'
import * as bunLock from '../src/bun.js'
import * as npmLock from '../src/npm.js'
import * as pnpmLock from '../src/pnpm.js'
import * as yarnLock from '../src/yarn.js'

const npmDigests = (t: string) => npmLock.importerDigests(npmLock.parseLockfile(t))
const bunDigests = (t: string) => bunLock.importerDigests(bunLock.parseLockfile(t))
const pnpmDigests = (t: string) => pnpmLock.importerDigests(pnpmLock.parseLockfile(t))
const yarnDigests = (t: string) => yarnLock.importerDigests(yarnLock.parseLockfile(t))

/** The dirs whose digest differs between two digest maps, sorted. */
function moved(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): string[] {
  expect([...b.keys()].sort()).toEqual([...a.keys()].sort())
  return [...a.keys()].filter((d) => a.get(d) !== b.get(d)).sort()
}

describe('an npm: alias keys the importer that names it', () => {
  // `a` → `isnum: npm:is-number@6.0.0`; `b` → is-number@7.
  const npm = (alias: string) =>
    JSON.stringify({
      name: 'ws',
      lockfileVersion: 3,
      packages: {
        '': { name: 'ws', workspaces: ['packages/*'] },
        'node_modules/a': { resolved: 'packages/a', link: true },
        'node_modules/b': { resolved: 'packages/b', link: true },
        'node_modules/isnum': {
          name: 'is-number',
          version: '6.0.0',
          resolved: 'https://r/is-number-6.0.0.tgz',
          integrity: `sha512-${alias}`,
        },
        'node_modules/is-number': {
          version: '7.0.0',
          resolved: 'https://r/is-number-7.0.0.tgz',
          integrity: 'sha512-seven',
        },
        'packages/a': {
          name: 'a',
          version: '1.0.0',
          dependencies: { isnum: 'npm:is-number@6.0.0' },
        },
        'packages/b': { name: 'b', version: '1.0.0', dependencies: { 'is-number': '^7' } },
      },
    })
  const bun = (alias: string) => `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "ws" },
    "packages/a": { "name": "a", "dependencies": { "isnum": "npm:is-number@6.0.0" } },
    "packages/b": { "name": "b", "dependencies": { "is-number": "^7" } },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],
    "b": ["b@workspace:packages/b"],
    "isnum": ["is-number@6.0.0", "", {}, "sha512-${alias}"],
    "is-number": ["is-number@7.0.0", "", {}, "sha512-seven"],
  }
}
`
  // Yarn berry records the alias under its own descriptor.
  const berry = (alias: string) => `__metadata:
  version: 8
  cacheKey: 10c0

"a@workspace:packages/a":
  version: 0.0.0-use.local
  resolution: "a@workspace:packages/a"
  dependencies:
    string-width-cjs: "npm:string-width@^4.2.0"
  languageName: unknown
  linkType: soft

"b@workspace:packages/b":
  version: 0.0.0-use.local
  resolution: "b@workspace:packages/b"
  dependencies:
    string-width: "npm:^5"
  languageName: unknown
  linkType: soft

"string-width-cjs@npm:string-width@^4.2.0":
  version: 4.2.3
  resolution: "string-width@npm:4.2.3"
  checksum: 10c0/${alias}
  languageName: node
  linkType: hard

"string-width@npm:^5":
  version: 5.1.2
  resolution: "string-width@npm:5.1.2"
  checksum: 10c0/five
  languageName: node
  linkType: hard

"ws@workspace:.":
  version: 0.0.0-use.local
  resolution: "ws@workspace:."
  languageName: unknown
  linkType: soft
`
  it('npm', () => {
    expect(moved(npmDigests(npm('one')), npmDigests(npm('two')))).toEqual(['packages/a'])
  })
  it('bun', () => {
    expect(moved(bunDigests(bun('one')), bunDigests(bun('two')))).toEqual(['packages/a'])
  })
  it('yarn berry', () => {
    expect(moved(yarnDigests(berry('one')), yarnDigests(berry('two')))).toEqual(['packages/a'])
  })
})

describe('a manifest with no dependency field is an importer all the same', () => {
  it('npm and bun digest every workspace, and a bump moves the one that reaches it', () => {
    const npm = (v: string) =>
      JSON.stringify({
        name: 'ws',
        lockfileVersion: 3,
        packages: {
          '': { name: 'ws', workspaces: ['packages/*'] },
          'node_modules/a': { resolved: 'packages/a', link: true },
          'node_modules/b': { resolved: 'packages/b', link: true },
          'node_modules/x': { version: v, resolved: 'https://r/x.tgz', integrity: `sha512-${v}` },
          'packages/a': { name: 'a', version: '1.0.0' },
          'packages/b': { name: 'b', version: '1.0.0', dependencies: { x: '^1' } },
        },
      })
    expect([...npmDigests(npm('1.0.0')).keys()].sort()).toEqual(['.', 'packages/a', 'packages/b'])
    expect(moved(npmDigests(npm('1.0.0')), npmDigests(npm('1.0.1')))).toEqual(['packages/b'])
    const bun = (v: string) => `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "ws" },
    "packages/a": { "name": "a" },
    "packages/b": { "name": "b", "dependencies": { "x": "^1" } },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],
    "b": ["b@workspace:packages/b"],
    "x": ["x@${v}", "", {}, "sha512-${v}"],
  }
}
`
    expect([...bunDigests(bun('1.0.0')).keys()].sort()).toEqual(['.', 'packages/a', 'packages/b'])
    expect(moved(bunDigests(bun('1.0.0')), bunDigests(bun('1.0.1')))).toEqual(['packages/b'])
  })
})

/** pnpm v9: `a` has no dependencies at all, `b` → x. */
const pnpm9 = (x: string, packagesBlock = true) => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .: {}

  packages/a: {}

  packages/b:
    dependencies:
      x:
        specifier: ^1
        version: ${x}
${
  packagesBlock
    ? `
packages:

  x@${x}:
    resolution: {integrity: sha512-${x}}
`
    : ''
}
snapshots:

  x@${x}: {}
`

describe('pnpm lockfile shapes', () => {
  it('an importer written `{}` is an importer; a bump moves only the one that reaches it', () => {
    expect([...pnpmDigests(pnpm9('1.0.0')).keys()].sort()).toEqual([
      '.',
      'packages/a',
      'packages/b',
    ])
    expect(moved(pnpmDigests(pnpm9('1.0.0')), pnpmDigests(pnpm9('1.0.1')))).toEqual(['packages/b'])
  })

  it('a lockfile with no packages block digests every importer', () => {
    const d = pnpmDigests(pnpm9('1.0.0', false))
    expect([...d.keys()].sort()).toEqual(['.', 'packages/a', 'packages/b'])
    expect(moved(d, pnpmDigests(pnpm9('1.0.1', false)))).toEqual(['packages/b'])
  })

  it('a two-document lockfile with CRLF line endings keys as it does with LF', () => {
    const env = `---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    configDependencies: {}\n\n---\n`
    const lf = env + pnpm9('1.0.0')
    const crlf = lf.replaceAll('\n', '\r\n')
    expect(crlf).not.toBe(lf)
    expect(pnpmDigests(crlf)).toEqual(pnpmDigests(lf))
    expect(pnpmDigests(lf)).not.toEqual(pnpmDigests(pnpm9('1.0.0')))
  })

  it("pnpm 11's string patch hash moves the importer reaching the patched package alone", () => {
    const patched = (hash: string) =>
      pnpm9('1.0.0')
        .replace('importers:', `patchedDependencies:\n  x@1.0.0: ${hash}\n\nimporters:`)
        .replace('version: 1.0.0', `version: 1.0.0(patch_hash=${hash})`)
        .replace('\n  x@1.0.0: {}', `\n  x@1.0.0(patch_hash=${hash}): {}`)
    expect(moved(pnpmDigests(patched('aaaa')), pnpmDigests(patched('bbbb')))).toEqual([
      'packages/b',
    ])
  })
})

describe('bun.lock versions', () => {
  it.each([0, 1, 2, 3])(
    'lockfileVersion %d reads and keys the workspace that reaches a bump',
    (v) => {
      const lock = (x: string) => `{
  "lockfileVersion": ${v},
  "workspaces": {
    "": { "name": "ws" },
    "packages/a": { "name": "a", "dependencies": { "x": "^1" } },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],
    "x": ["x@${x}", "", {}, "sha512-${x}"],
  }
}
`
      expect(moved(bunDigests(lock('1.0.0')), bunDigests(lock('1.0.1')))).toEqual(['packages/a'])
    },
  )
})
