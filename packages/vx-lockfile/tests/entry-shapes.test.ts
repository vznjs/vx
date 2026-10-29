// Lockfile entries of the shapes graph builders tripped on: a git
// dependency, an `npm:` alias, an entry missing its version, a GitHub
// tarball, one entry two names reach (a "ghost" alias), and a pnpm
// lockfileVersion with a minor part. Each parses, and a change to the
// entry moves exactly the workspaces that reach it.
import { describe, expect, it } from 'bun:test'
import * as npm from '../src/npm.js'
import * as pnpm from '../src/pnpm.js'
import * as yarn from '../src/yarn.js'

type Parser = {
  parseLockfile(text: string): never
  importerDigests(lock: never): ReadonlyMap<string, string>
}

/** The workspace dirs whose digest differs between the two lockfiles. */
function moved(p: Parser, before: string, after: string): string[] {
  const a = p.importerDigests(p.parseLockfile(before))
  const b = p.importerDigests(p.parseLockfile(after))
  return [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort()
}

const npmLock = (extra: Record<string, unknown>, aDeps: Record<string, string>) =>
  JSON.stringify({
    name: 'ws',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'ws', workspaces: ['packages/*'] },
      'node_modules/a': { resolved: 'packages/a', link: true },
      'node_modules/b': { resolved: 'packages/b', link: true },
      'packages/a': { name: 'a', version: '1.0.0', dependencies: aDeps },
      'packages/b': { name: 'b', version: '1.0.0' },
      ...extra,
    },
  })

describe('npm', () => {
  it('a git dependency: its commit moves the workspace reaching it', () => {
    const lock = (sha: string) =>
      npmLock(
        {
          'node_modules/g': {
            version: '1.0.0',
            resolved: `git+ssh://git@github.com/o/g.git#${sha}`,
          },
        },
        { g: 'github:o/g' },
      )
    expect(moved(npm as never, lock('aaa'), lock('bbb'))).toEqual(['packages/a'])
  })

  it('an `npm:` alias resolves to the entry installed under the alias', () => {
    const lock = (v: string) =>
      npmLock(
        {
          'node_modules/sw': {
            name: 'real',
            version: v,
            resolved: `https://r/real-${v}.tgz`,
            integrity: `sha512-${v}`,
          },
        },
        { sw: 'npm:real@^1' },
      )
    expect(moved(npm as never, lock('1.0.0'), lock('1.0.1'))).toEqual(['packages/a'])
  })

  it('workspaces listed by path, with no `*`, are workspaces as a glob names them', () => {
    const lock = (v: string) =>
      npmLock({ 'node_modules/x': { version: v, integrity: `sha512-${v}` } }, { x: '^1' }).replace(
        '"workspaces":["packages/*"]',
        '"workspaces":["packages/a","packages/b"]',
      )
    expect(lock('1.0.0')).toContain('"packages/a","packages/b"')
    const digests = npm.importerDigests(npm.parseLockfile(lock('1.0.0')))
    expect([...digests.keys()].sort()).toEqual(['.', 'packages/a', 'packages/b'])
    expect(moved(npm as never, lock('1.0.0'), lock('1.0.1'))).toEqual(['packages/a'])
  })

  it('an entry with no version or resolution parses, and gaining one moves its reacher', () => {
    const bare = npmLock({ 'node_modules/x': {} }, { x: '*' })
    const full = npmLock(
      { 'node_modules/x': { version: '1.0.0', integrity: 'sha512-x' } },
      { x: '*' },
    )
    expect(moved(npm as never, bare, full)).toEqual(['packages/a'])
  })
})

describe('yarn', () => {
  const berry = (body: string) => `__metadata:
  version: 8
  cacheKey: 10c0

"a@workspace:packages/a":
  version: 0.0.0-use.local
  resolution: "a@workspace:packages/a"
  dependencies:
    sw-cjs: "npm:string-width@^4.2.0"
    g: "https://github.com/o/g.git"
  languageName: unknown
  linkType: soft

"b@workspace:packages/b":
  version: 0.0.0-use.local
  resolution: "b@workspace:packages/b"
  dependencies:
    string-width: "npm:^4.1.0"
  languageName: unknown
  linkType: soft
${body}`
  const entries = (checksum: string, commit: string) => `
"sw-cjs@npm:string-width@^4.2.0, string-width@npm:^4.1.0":
  version: 4.2.3
  resolution: "string-width@npm:4.2.3"
  checksum: 10c0/${checksum}
  languageName: node
  linkType: hard

"g@https://github.com/o/g.git":
  version: 1.0.0
  resolution: "g@https://github.com/o/g.git#commit=${commit}"
  languageName: node
  linkType: hard
`

  it('berry: one entry keyed by an alias and a plain descriptor moves both askers', () => {
    expect(moved(yarn as never, berry(entries('s1', 'c1')), berry(entries('s2', 'c1')))).toEqual([
      'packages/a',
      'packages/b',
    ])
  })

  it('berry: a git entry’s commit moves the workspace reaching it alone', () => {
    expect(moved(yarn as never, berry(entries('s1', 'c1')), berry(entries('s1', 'c2')))).toEqual([
      'packages/a',
    ])
  })

  it('berry: an entry with no version parses and keys by its resolution', () => {
    const noVersion = (r: string) =>
      berry(entries('s1', 'c1').replace('  version: 1.0.0\n', '')).replace('commit=c1', r)
    expect(moved(yarn as never, noVersion('commit=c1'), noVersion('commit=c3'))).toEqual([
      'packages/a',
    ])
  })

  it('classic: a git entry and one with no version parse, and the commit moves the root', () => {
    const classic = (
      sha: string,
    ) => `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"g@github:o/g":
  version "1.0.0"
  resolved "https://codeload.github.com/o/g/tar.gz/${sha}"

"x@*":
  resolved "https://r/x.tgz"
`
    expect(moved(yarn as never, classic('aaa'), classic('bbb'))).toEqual(['.'])
  })
})

describe('pnpm', () => {
  it('v9: a GitHub tarball dependency’s commit moves the importer reaching it alone', () => {
    const lock = (sha: string) => `lockfileVersion: '9.0'
importers:
  packages/a:
    dependencies:
      g:
        specifier: github:o/g
        version: https://codeload.github.com/o/g/tar.gz/${sha}
  packages/b:
    dependencies: {}
packages:
  g@https://codeload.github.com/o/g/tar.gz/${sha}:
    resolution: {tarball: https://codeload.github.com/o/g/tar.gz/${sha}}
    version: 1.0.0
snapshots:
  g@https://codeload.github.com/o/g/tar.gz/${sha}: {}
`
    expect(moved(pnpm as never, lock('aaa'), lock('bbb'))).toEqual(['packages/a'])
  })

  it('v6.1: a GitHub dependency’s commit moves the importer reaching it alone', () => {
    const lock = (sha: string) => `lockfileVersion: '6.1'
importers:
  packages/a:
    dependencies:
      g:
        specifier: github:o/g
        version: github.com/o/g/${sha}
  packages/b: {}
packages:
  github.com/o/g/${sha}:
    resolution: {tarball: https://codeload.github.com/o/g/tar.gz/${sha}}
    name: g
    version: 1.0.0
    dev: false
`
    expect(moved(pnpm as never, lock('aaa'), lock('bbb'))).toEqual(['packages/a'])
  })
})
