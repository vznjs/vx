// A workspace nested in another's directory (`packages/a/packages/n`, under
// `workspaces: ["packages/*", "packages/a/packages/*"]`) resolves through
// `packages/a/node_modules`, where npm 10 nests what only `n` needs (probed:
// `is-even` and its `is-odd` landed there, and `require.resolve` from `n`
// found them). The resolver stepped from one `/node_modules/` boundary to
// the next, skipped that directory, and keyed `n` on its spec alone: a
// version change under it was a stale hit (D-139).
import { expect, it } from 'bun:test'
import { importerDigests, parseLockfile } from '../src/npm.js'

/** The layout npm 10 wrote for the probe, `odd` the nested `is-odd` version. */
function lock(odd = '0.1.2'): string {
  const pkg = (version: string, deps?: Record<string, string>) => ({
    version,
    resolved: `https://r/${version}.tgz`,
    integrity: `sha512-${version}`,
    ...(deps === undefined ? {} : { dependencies: deps }),
  })
  return JSON.stringify({
    name: 'r',
    lockfileVersion: 3,
    packages: {
      '': { name: 'r', workspaces: ['packages/*', 'packages/a/packages/*'] },
      'node_modules/a': { resolved: 'packages/a', link: true },
      'node_modules/n': { resolved: 'packages/a/packages/n', link: true },
      'node_modules/is-number': pkg('7.0.0'),
      'packages/a': { name: 'a', version: '1.0.0', dependencies: { 'is-number': '7.0.0' } },
      'packages/a/packages/n': {
        name: 'n',
        version: '1.0.0',
        dependencies: { 'is-even': '0.1.2' },
      },
      'packages/a/node_modules/is-even': pkg('0.1.2', { 'is-odd': '^0.1.2' }),
      'packages/a/node_modules/is-odd': pkg(odd),
    },
  })
}

const digests = (text: string) => importerDigests(parseLockfile(text))

it("a version under the outer workspace's node_modules re-keys the nested one alone", () => {
  const before = digests(lock())
  const after = digests(lock('0.1.3'))
  expect([...before.keys()].filter((k) => before.get(k) !== after.get(k))).toEqual([
    'packages/a/packages/n',
  ])
})

it('CONTROL: the same lockfile digests the same', () => {
  expect(digests(lock())).toEqual(digests(lock()))
})
