// Each format's pruner over a lockfile its package manager wrote: cut to
// the workspaces `a` and `b`, exactly `c`'s entries go, the rest of the
// text is the package manager's own, and keeping every workspace is the
// identity.
import { describe, expect, it } from 'bun:test'
import { pruneLockfile as pruneBun } from '../src/bun.js'
import { pruneLockfile as pruneNpm } from '../src/npm.js'
import { pruneLockfile as prunePnpm } from '../src/pnpm.js'
import { pruneLockfile as pruneYarn } from '../src/yarn.js'
import type { PruneScope } from '../src/scope.js'
import {
  BUN_LOCK,
  NPM_LOCK,
  PNPM_LOCK,
  YARN_BERRY_LOCK,
  YARN_CLASSIC_LOCK,
} from './helpers/prune-lockfiles.js'

const MEMBERS = new Set(['packages/a', 'packages/b', 'packages/c'])

function scope(dirs: readonly string[], workspaces = dirs.filter((d) => d !== '.')): PruneScope {
  return {
    dirs: new Set(dirs),
    members: MEMBERS,
    workspaces,
    manifests: new Map([
      ['.', new Map([['is-number', '^2.0.0']])],
      [
        'packages/a',
        new Map([
          ['is-odd', '3.0.1'],
          ['b', '1.0.0'],
        ]),
      ],
      ['packages/b', new Map([['is-number', '^7.0.0']])],
      [
        'packages/c',
        new Map([
          ['is-number', '^4.0.0'],
          ['left-pad', '1.3.0'],
        ]),
      ],
    ]),
  }
}

const AB = scope(['.', 'packages/a', 'packages/b'])
const ALL = scope(['.', 'packages/a', 'packages/b', 'packages/c'])

/** The lines of `pruned` in order are a subsequence of `source`'s: a cut, never a rewrite. */
function isCut(source: string, pruned: string): boolean {
  const from = source.split('\n')
  let i = 0
  for (const line of pruned.split('\n')) {
    while (i < from.length && from[i] !== line) i++
    if (i === from.length) return false
    i++
  }
  return true
}

const gone = (before: readonly string[], after: readonly string[]): string[] =>
  before.filter((k) => !after.includes(k)).sort()

type Doc = Record<string, Record<string, unknown>>

describe('bun.lock', () => {
  const keys = (text: string): string[] => {
    const d = Bun.JSONC.parse(text) as Doc
    return [...Object.keys(d['workspaces']!).map((k) => `ws:${k}`), ...Object.keys(d['packages']!)]
  }

  it('cuts exactly what only c reaches, in Bun’s own layout', () => {
    const pruned = pruneBun(BUN_LOCK, AB)
    expect(gone(keys(BUN_LOCK), keys(pruned))).toEqual([
      'c',
      'c/is-number',
      'left-pad',
      'ws:packages/c',
    ])
    expect(isCut(BUN_LOCK, pruned)).toBe(true)
  })

  it('keeping every workspace writes the file Bun wrote, byte for byte', () => {
    expect(pruneBun(BUN_LOCK, ALL)).toBe(BUN_LOCK)
  })

  it('a kept workspace depending on one the subset leaves out is refused', () => {
    expect(() => pruneBun(BUN_LOCK, scope(['.', 'packages/a']))).toThrow(
      'bun.lock: b is workspace packages/b, which the subset leaves out',
    )
  })
})

describe('pnpm-lock.yaml', () => {
  const keys = (text: string): string[] => {
    const d = Bun.YAML.parse(text) as Doc
    return ['importers', 'packages', 'snapshots'].flatMap((s) =>
      Object.keys(d[s]!).map((k) => `${s}:${k}`),
    )
  }

  it('cuts exactly what only c reaches, every other line as pnpm wrote it', () => {
    const pruned = prunePnpm(PNPM_LOCK, AB)
    expect(gone(keys(PNPM_LOCK), keys(pruned))).toEqual([
      'importers:packages/c',
      'packages:is-number@4.0.0',
      'packages:left-pad@1.3.0',
      'snapshots:is-number@4.0.0',
      'snapshots:left-pad@1.3.0',
    ])
    expect(isCut(PNPM_LOCK, pruned)).toBe(true)
  })

  it('keeping every workspace is the identity', () => {
    expect(prunePnpm(PNPM_LOCK, ALL)).toBe(PNPM_LOCK)
  })

  it('a multi-document lockfile keeps the env document whole and prunes the last', () => {
    const env = `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}

packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-env}

---
`
    const pruned = prunePnpm(env + PNPM_LOCK, AB)
    expect(pruned.startsWith(env)).toBe(true)
    expect(pruned.slice(env.length)).toBe(prunePnpm(PNPM_LOCK, AB))
  })

  it('a kept importer linking one the subset leaves out is refused', () => {
    expect(() => prunePnpm(PNPM_LOCK, scope(['.', 'packages/a']))).toThrow(
      'pnpm-lock.yaml: packages/a links packages/b, which the subset leaves out',
    )
  })
})

describe('package-lock.json', () => {
  const keys = (text: string): string[] => Object.keys((JSON.parse(text) as Doc)['packages']!)

  it('cuts exactly what only c reaches, and the root entry lists the subset', () => {
    const pruned = pruneNpm(NPM_LOCK, AB)
    expect(gone(keys(NPM_LOCK), keys(pruned))).toEqual([
      'node_modules/c',
      'node_modules/left-pad',
      'packages/c',
      'packages/c/node_modules/is-number',
    ])
    const root = (JSON.parse(pruned) as Doc)['packages']!['']!
    expect((root as Record<string, unknown>)['workspaces']).toEqual(['packages/a', 'packages/b'])
  })

  it('keeping every workspace under the same list is the identity', () => {
    expect(pruneNpm(NPM_LOCK, scope([...ALL.dirs], ['packages/*']))).toBe(NPM_LOCK)
  })

  it('version 2 cuts its legacy dependencies tree to the same paths', () => {
    const v2 = JSON.parse(NPM_LOCK) as Record<string, unknown>
    v2['lockfileVersion'] = 2
    v2['dependencies'] = {
      'is-number': { version: '2.1.0' },
      'left-pad': { version: '1.3.0' },
      c: { version: 'file:packages/c', requires: { 'is-number': '^4.0.0' } },
      'is-odd': { version: '3.0.1', dependencies: { 'is-number': { version: '6.0.0' } } },
    }
    const pruned = JSON.parse(pruneNpm(JSON.stringify(v2, null, 2), AB)) as Doc
    expect(pruned['dependencies']).toEqual({
      'is-number': { version: '2.1.0' },
      'is-odd': { version: '3.0.1', dependencies: { 'is-number': { version: '6.0.0' } } },
    })
  })
})

describe('yarn.lock', () => {
  const entries = (text: string): string[] =>
    text.split('\n').filter((l) => /^[^\s#]/.test(l) && !l.startsWith('__metadata'))

  it('berry: cuts exactly what only c reaches', () => {
    const pruned = pruneYarn(YARN_BERRY_LOCK, AB)
    expect(gone(entries(YARN_BERRY_LOCK), entries(pruned))).toEqual([
      '"c@workspace:packages/c":',
      '"is-number@npm:^4.0.0":',
      '"left-pad@npm:1.3.0":',
    ])
    expect(isCut(YARN_BERRY_LOCK, pruned)).toBe(true)
    expect(pruneYarn(YARN_BERRY_LOCK, ALL)).toBe(YARN_BERRY_LOCK)
  })

  it('classic: walks from the kept manifests and cuts exactly what only c reaches', () => {
    const pruned = pruneYarn(YARN_CLASSIC_LOCK, AB)
    expect(gone(entries(YARN_CLASSIC_LOCK), entries(pruned))).toEqual([
      'is-number@^4.0.0:',
      'left-pad@1.3.0:',
    ])
    expect(isCut(YARN_CLASSIC_LOCK, pruned)).toBe(true)
    expect(pruneYarn(YARN_CLASSIC_LOCK, ALL)).toBe(YARN_CLASSIC_LOCK)
  })

  it('berry: a kept workspace depending on one the subset leaves out is refused', () => {
    expect(() => pruneYarn(YARN_BERRY_LOCK, scope(['.', 'packages/a']))).toThrow(
      'yarn.lock: b@workspace:packages/b is a workspace the subset leaves out',
    )
  })
})
