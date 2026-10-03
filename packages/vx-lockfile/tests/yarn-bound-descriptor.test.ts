// Berry descriptors the plain `name@range` lookup missed, so the edge fell
// back to every entry of the name (D-144). Shapes from real lockfiles:
// a path range keyed bound to its depender (forge's `portal:`, babel's
// `link:`), and a range with a trailing space (forge's `p-limit`).
import { expect, it } from 'bun:test'
import { importerDigests, parseLockfile } from '../src/yarn.js'

const META = `__metadata:\n  version: 8\n  cacheKey: 10c0\n`

const ws = (name: string, dir: string, deps: Record<string, string>) => `"${name}@workspace:${dir}":
  version: 0.0.0-use.local
  resolution: "${name}@workspace:${dir}"
  dependencies:
${Object.entries(deps)
  .map(([k, v]) => `    ${k}: "${v}"`)
  .join('\n')}
  languageName: unknown
  linkType: soft
`

const npm = (key: string, v: string, deps: Record<string, string> = {}) => `"${key}":
  version: ${v}
  resolution: "${key.slice(0, key.indexOf('@', 1))}@npm:${v}"
${
  Object.keys(deps).length === 0
    ? ''
    : `  dependencies:\n${Object.entries(deps)
        .map(([k, r]) => `    ${k}: "${r}"`)
        .join('\n')}\n`
}  checksum: 10c0/${key.replace(/\W/g, '')}${v}
  languageName: node
  linkType: hard
`

const portal = (
  owner: string,
  dep: string,
) => `"fx@portal:./fx::locator=${encodeURIComponent(owner)}":
  version: 0.0.0-use.local
  resolution: "fx@portal:./fx::locator=${encodeURIComponent(owner)}"
  dependencies:
    is-number: "${dep}"
  languageName: node
  linkType: soft
`

const moved = (one: string, two: string) => {
  const a = importerDigests(parseLockfile(one))
  const b = importerDigests(parseLockfile(two))
  expect([...a.keys()].sort()).toEqual(['packages/a', 'packages/b'])
  return [...a.keys()].filter((d) => a.get(d) !== b.get(d)).sort()
}

it("a bound `portal:` reaches its own depender's entry, not another workspace's", () => {
  const text = (six: string) =>
    [
      META,
      ws('a', 'packages/a', { fx: 'portal:./fx' }),
      ws('b', 'packages/b', { fx: 'portal:./fx' }),
      portal('a@workspace:packages/a', 'npm:^7.0.0'),
      portal('b@workspace:packages/b', 'npm:^6.0.0'),
      npm('is-number@npm:^7.0.0', '7.0.0'),
      npm('is-number@npm:^6.0.0', six),
    ].join('\n')
  expect(moved(text('6.0.0'), text('6.0.1'))).toEqual(['packages/b'])
})

it('a range with a trailing space reaches its own entry, not every entry of the name', () => {
  const text = (one: string) =>
    [
      META,
      ws('a', 'packages/a', { 'p-limit': 'npm:^3.1.0 ' }),
      ws('b', 'packages/b', { 'p-limit': 'npm:^1.0.0' }),
      npm('p-limit@npm:^3.0.1, p-limit@npm:^3.1.0 ', '3.1.0'),
      npm('p-limit@npm:^1.0.0', one),
    ].join('\n')
  expect(moved(text('1.0.0'), text('1.0.1'))).toEqual(['packages/b'])
})

it('CONTROL: a bound entry moves its depender', () => {
  const text = (seven: string) =>
    [
      META,
      ws('a', 'packages/a', { fx: 'portal:./fx' }),
      ws('b', 'packages/b', { fx: 'portal:./fx' }),
      portal('a@workspace:packages/a', 'npm:^7.0.0'),
      portal('b@workspace:packages/b', 'npm:^6.0.0'),
      npm('is-number@npm:^7.0.0', seven),
      npm('is-number@npm:^6.0.0', '6.0.0'),
    ].join('\n')
  // Contains, not equals: the coarse fallback moves `b` as well.
  expect(moved(text('7.0.0'), text('7.0.1'))).toContain('packages/a')
})
