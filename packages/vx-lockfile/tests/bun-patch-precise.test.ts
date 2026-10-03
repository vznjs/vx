// A bun patch keys through the entry it patches (D-143). From a real
// `bun patch is-number@7.0.0` on Bun 1.4: only `b` reaches is-number@7.0.0
// (`a` reaches 3.0.0 under is-odd), and a patch edit re-keyed `a` and the
// root too while `patchedDependencies` and the patch bytes were install-wide.
import { expect, it } from 'bun:test'
import { importerDigests, parseLockfile } from '../src/bun.js'

const PATCH = 'patches/is-number@7.0.0.patch'

const lock = (key = 'is-number@7.0.0') => `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": { "name": "root" },
    "packages/a": { "name": "a", "dependencies": { "is-even": "1.0.0" } },
    "packages/b": { "name": "b", "dependencies": { "is-number": "7.0.0" } },
  },
  "patchedDependencies": { "${key}": "${PATCH}" },
  "packages": {
    "a": ["a@workspace:packages/a"],
    "b": ["b@workspace:packages/b"],
    "is-buffer": ["is-buffer@1.1.6", "", {}, "sha512-buf"],
    "is-even": ["is-even@1.0.0", "", { "dependencies": { "is-odd": "^0.1.2" } }, "sha512-even"],
    "is-number": ["is-number@7.0.0", "", {}, "sha512-n7"],
    "is-odd": ["is-odd@0.1.2", "", { "dependencies": { "is-number": "^3.0.0" } }, "sha512-odd"],
    "kind-of": ["kind-of@3.2.2", "", { "dependencies": { "is-buffer": "^1.1.5" } }, "sha512-kind"],
    "is-odd/is-number": ["is-number@3.0.0", "", { "dependencies": { "kind-of": "^3.0.2" } }, "sha512-n3"],
  }
}`

const moved = (one: string, two: string, h1: string, h2: string) => {
  const a = importerDigests(parseLockfile(one), new Map([[PATCH, h1]]))
  const b = importerDigests(parseLockfile(two), new Map([[PATCH, h2]]))
  expect([...a.keys()].sort()).toEqual(['.', 'packages/a', 'packages/b'])
  return [...a.keys()].filter((d) => a.get(d) !== b.get(d)).sort()
}

it("a patch file's edit moves only the workspaces reaching the patched entry", () => {
  expect(moved(lock(), lock(), 'h1', 'h2')).toEqual(['packages/b'])
})

it('a patch keyed by bare name reaches every version of it', () => {
  expect(moved(lock('is-number'), lock('is-number'), 'h1', 'h2')).toEqual([
    'packages/a',
    'packages/b',
  ])
})

it('adding a patch moves only the workspaces reaching the patched entry', () => {
  const none = lock().replace(/"patchedDependencies": \{[^}]*\},\n/, '')
  expect(none).not.toBe(lock())
  expect(moved(none, lock(), 'h1', 'h1')).toEqual(['packages/b'])
})

it('CONTROL: a patch naming no entry still moves every workspace', () => {
  expect(moved(lock('left-pad@1.0.0'), lock('left-pad@1.0.0'), 'h1', 'h2')).toEqual([
    '.',
    'packages/a',
    'packages/b',
  ])
})
