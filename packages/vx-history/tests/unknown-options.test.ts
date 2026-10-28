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
