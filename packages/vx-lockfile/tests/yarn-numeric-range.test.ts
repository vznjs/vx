// Yarn berry writes a range unquoted when it is a plain scalar
// (`stream-source: 0.10`). A YAML parser reads it as the number 0.1, so
// the range looked up `stream-source@npm:0.1`, a sibling's entry, and a
// bump of the 0.10 entry it installs moved nothing (turborepo#6296).
import { expect, it } from 'bun:test'
import { importerDigests, parseLockfile } from '../src/yarn.js'

const lock = (
  ten: string,
  ranges: { a: string; b: string } = { a: '0.10', b: '0.1' },
) => `# yarn lockfile

__metadata:
  version: 8
  cacheKey: 10

"a@workspace:packages/a":
  version: 0.0.0-use.local
  resolution: "a@workspace:packages/a"
  dependencies:
    stream-source: ${ranges.a}
  languageName: unknown
  linkType: soft

"b@workspace:packages/b":
  version: 0.0.0-use.local
  resolution: "b@workspace:packages/b"
  dependencies:
    stream-source: ${ranges.b}
  languageName: unknown
  linkType: soft

"stream-source@npm:${ranges.b}":
  version: 0.1.0
  resolution: "stream-source@npm:0.1.0"
  checksum: 10/aaaa
  languageName: node
  linkType: hard

"stream-source@npm:${ranges.a}":
  version: ${ten}
  resolution: "stream-source@npm:${ten}"
  checksum: 10/${ten}
  languageName: node
  linkType: hard
`

const moved = (one: string, two: string) => {
  const a = importerDigests(parseLockfile(one))
  const b = importerDigests(parseLockfile(two))
  return [...a.keys()].filter((d) => a.get(d) !== b.get(d)).sort()
}

it('an unquoted `0.10` range reaches its own entry, not `0.1`', () => {
  expect(moved(lock('0.10.12'), lock('0.10.13'))).toEqual(['packages/a'])
})

it('an unquoted `1.0` range reaches its own entry, not `1`', () => {
  const r = { a: '1.0', b: '1' }
  expect(moved(lock('1.0.1', r), lock('1.0.2', r))).toEqual(['packages/a'])
})

it('every unquoted range reads as its source text', () => {
  const ranges = ['0.10', '1.0', '010', '0x1F', '1e3', '.5', 'true', 'null', '~', '1_000']
  const text = `__metadata:\n  version: 8\n  cacheKey: 10\n\n"a@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "a@workspace:."\n  dependencies:\n${ranges.map((r, i) => `    p${i}: ${r}`).join('\n')}\n  languageName: unknown\n  linkType: soft\n`
  const deps = parseLockfile(text).entries.get('a@workspace:.')!.deps
  expect([...deps.values()]).toEqual(ranges)
})

it('a shape Yarn does not write (a hand edit) is still read as YAML', () => {
  const text = `__metadata:\n  version: 8\n  cacheKey: 10\n\n"a@workspace:.":\n  resolution: "a@workspace:."\n  dependencies: { foo: "npm:^1" }\n`
  const deps = parseLockfile(text).entries.get('a@workspace:.')!.deps
  expect([...deps]).toEqual([['foo', 'npm:^1']])
})
