// A re-hoist installs the same bytes at another path: bun moved
// `is-odd/is-number@6.0.0` up to `is-number@6.0.0` when project `a` took
// 6.0.0 too, and every project reaching it re-keyed (`b`, whose `is-odd`
// still resolves 6.0.0). A package folds the name it installs under and
// what it is, not where it sits (D-140). npm folded the path the same way.
import { expect, it } from 'bun:test'
import * as bunLock from '../src/bun.js'
import * as npmLock from '../src/npm.js'

const moved = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>) =>
  [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort()

/** bun 1.4's bun.lock for `a` → is-number@`aNumber`, `b` → is-odd@3.0.1 (is-number ^6). */
function bunLockText(aNumber: '7.0.0' | '6.0.0'): string {
  const n = (v: string) => `["is-number@${v}", "", {}, "sha512-n${v}"]`
  const nested = aNumber === '7.0.0' ? `"is-odd/is-number": ${n('6.0.0')},` : ''
  return `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "r" },
    "packages/a": { "name": "a", "dependencies": { "is-number": "${aNumber}" } },
    "packages/b": { "name": "b", "dependencies": { "is-odd": "3.0.1" } },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],
    "b": ["b@workspace:packages/b"],
    "is-number": ${n(aNumber)},
    "is-odd": ["is-odd@3.0.1", "", { "dependencies": { "is-number": "^6.0.0" } }, "sha512-odd"],
    ${nested}
  }
}`
}

const bunDigests = (t: string) => bunLock.importerDigests(bunLock.parseLockfile(t))

it('bun: a re-hoist of one version re-keys only the project whose version moved', () => {
  expect(moved(bunDigests(bunLockText('7.0.0')), bunDigests(bunLockText('6.0.0')))).toEqual([
    'packages/a',
  ])
})

/** npm 10's layout for the same two projects. */
function npmLockText(aNumber: '7.0.0' | '6.0.0'): string {
  const pkg = (v: string, deps?: Record<string, string>) => ({
    version: v,
    resolved: `https://r/is-number-${v}.tgz`,
    integrity: `sha512-n${v}`,
    ...(deps === undefined ? {} : { dependencies: deps }),
  })
  return JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'r', workspaces: ['packages/*'] },
      'node_modules/a': { resolved: 'packages/a', link: true },
      'node_modules/b': { resolved: 'packages/b', link: true },
      'node_modules/is-number': pkg(aNumber),
      'node_modules/is-odd': {
        version: '3.0.1',
        resolved: 'https://r/is-odd-3.0.1.tgz',
        integrity: 'sha512-odd',
        dependencies: { 'is-number': '^6.0.0' },
      },
      ...(aNumber === '7.0.0'
        ? { 'node_modules/is-odd/node_modules/is-number': pkg('6.0.0') }
        : {}),
      'packages/a': { name: 'a', dependencies: { 'is-number': aNumber } },
      'packages/b': { name: 'b', dependencies: { 'is-odd': '3.0.1' } },
    },
  })
}

const npmDigests = (t: string) => npmLock.importerDigests(npmLock.parseLockfile(t))

it('npm: a re-hoist of one version re-keys only the project whose version moved', () => {
  expect(moved(npmDigests(npmLockText('7.0.0')), npmDigests(npmLockText('6.0.0')))).toEqual([
    'packages/a',
  ])
})

it('CONTROL: a version that does change under a project still re-keys it', () => {
  const before = bunLockText('6.0.0')
  const after = before.replace('"sha512-n6.0.0"', '"sha512-other"')
  expect(moved(bunDigests(before), bunDigests(after))).toEqual(['packages/a', 'packages/b'])
})
