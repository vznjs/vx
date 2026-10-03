// A Bun catalog is how a range was written; what it resolved to is the
// `packages` entry a workspace naming `catalog:` already reaches. Folded
// into every workspace, one catalog bump re-keyed them all, `b` that never
// names it included (probed on a real bun 1.4 install; pnpm keys it per
// importer). Only the resolution moves a workspace now (D-141).
import { expect, it } from 'bun:test'
import { importerDigests, parseLockfile } from '../src/bun.js'

const doc = (catalogs: string, isNumber: string) => `{
  "lockfileVersion": 1,
  ${catalogs}
  "workspaces": {
    "": { "name": "ws" },
    "packages/a": { "name": "a", "dependencies": { "is-number": "catalog:" } },
    "packages/b": { "name": "b", "dependencies": { "is-odd": "3.0.1" } },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],
    "b": ["b@workspace:packages/b"],
    "is-number": ["is-number@${isNumber}", "", {}, "sha512-${isNumber}"],
    "is-odd": ["is-odd@3.0.1", "", {}, "sha512-odd"],
  }
}`

const moved = (before: string, after: string) => {
  const b = importerDigests(parseLockfile(before))
  const a = importerDigests(parseLockfile(after))
  return [...a.keys()].filter((k) => a.get(k) !== b.get(k)).sort()
}

it.each(['catalog', 'catalogs'])(
  'a `%s` edit that resolves the same version moves no workspace',
  (field) => {
    const block = (range: string) =>
      field === 'catalog'
        ? `"catalog": { "is-number": "${range}" },`
        : `"catalogs": { "n": { "is-number": "${range}" } },`
    expect(moved(doc(block('^7.0.0'), '7.0.0'), doc(block('~7.0.0'), '7.0.0'))).toEqual([])
  },
)

it('CONTROL: a catalog bump that resolves anew moves the workspace that names it', () => {
  const block = (range: string) => `"catalog": { "is-number": "${range}" },`
  expect(moved(doc(block('^6.0.0'), '6.0.0'), doc(block('^7.0.0'), '7.0.0'))).toContain(
    'packages/a',
  )
})
