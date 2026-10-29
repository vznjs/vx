// A misspelt option was read as unset: Bun strips a config's types, so
// the factory saw the typo and the plugin quietly declined or kept its
// default. `vxHistory()` now refuse a key it does not read (stream F).
import { expect, it } from 'bun:test'
import { vxHistory } from '../src/index.js'

const refusal = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('a misspelt option is refused, naming the nearest one', () => {
  expect(refusal(() => vxHistory({ windw: 5 } as never))).toBe(
    'vxHistory() has unknown option "windw" (allowed: assume, defaultBranch, file, headers, issuer, memory, repository, reservations, resources, url, window) \u2014 did you mean window?',
  )
})

it('no options is taken', () => {
  expect(refusal(() => vxHistory({}))).not.toContain('unknown option')
})

it('a resources value that is neither false nor an object is refused', () => {
  expect(refusal(() => vxHistory({ resources: null } as never))).toBe(
    'vxHistory() option "resources" must be false or an object, got null',
  )
  expect(refusal(() => vxHistory({ resources: true } as never))).toBe(
    'vxHistory() option "resources" must be false or an object, got true',
  )
  expect(refusal(() => vxHistory({ resources: false }))).toBe('taken')
  expect(refusal(() => vxHistory({ resources: { headroom: 1.2 } }))).toBe('taken')
})

it('an empty file is refused: it named the workspace root', () => {
  expect(refusal(() => vxHistory({ file: '' }))).toBe(
    'vxHistory() option "file" must be a path, got ""',
  )
  expect(refusal(() => vxHistory({ file: '.vx/timings.json' }))).toBe('taken')
})

// `''` read `refs/heads/`, a name with a space was refused by the server
// on every run, and `refs/heads/main` read `refs/heads/refs/heads/main`:
// each run read no trunk's numbers.
it('a defaultBranch that is no branch name is refused', () => {
  for (const bad of ['', ' ', 'main dev', 'refs/heads/main'])
    expect(refusal(() => vxHistory({ defaultBranch: bad }))).toBe(
      `vxHistory() option "defaultBranch" must be a branch name (main), got ${JSON.stringify(bad)}`,
    )
  expect(refusal(() => vxHistory({ defaultBranch: 'release/1.x' }))).toBe('taken')
})

// Only the top level was checked: `resources: { headrom }` packed on the
// default headroom, and `{ cpu: 2 }` reserved no cores, both unsaid.
it('a misspelt key inside resources or a reservation is refused', () => {
  expect(refusal(() => vxHistory({ resources: { headrom: 1.5 } as never }))).toBe(
    'vxHistory() option "resources" has unknown option "headrom" (allowed: headroom) — did you mean headroom?',
  )
  expect(refusal(() => vxHistory({ reservations: { 'a#b': { cpu: 2 } as never } }))).toBe(
    'vxHistory() option "reservations["a#b"]" has unknown option "cpu" (allowed: cpus, memory) — did you mean cpus?',
  )
  expect(
    refusal(() => vxHistory({ reservations: { 'a#b': { cpus: 2, memory: Number('x') } } })),
  ).toBe('taken')
})

// A header it cannot send was refused once a server was named, so a
// laptop passed what failed the first CI run. A value is never printed.
it('a header it cannot send is refused at the call, with no url named', () => {
  expect(refusal(() => vxHistory({ headers: { Authorization: 'x' } }))).toBe(
    'vxHistory() option "headers" cannot set "Authorization"',
  )
  expect(refusal(() => vxHistory({ headers: { 'a b': 'x' } }))).toBe(
    'vxHistory() option "headers" cannot set "a b"',
  )
  expect(refusal(() => vxHistory({ headers: { a: 'x\ny' } }))).toBe(
    'vxHistory() option "headers.a" must be one line of text (its value is not printed)',
  )
  expect(refusal(() => vxHistory({ headers: { a: 'x', b: undefined } }))).toBe('taken')
})
