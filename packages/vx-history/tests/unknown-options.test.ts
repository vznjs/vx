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
  // JSON.stringify(NaN) is "null": the refusal named a value nobody wrote.
  expect(refusal(() => vxHistory({ resources: Number.NaN } as never))).toBe(
    'vxHistory() option "resources" must be false or an object, got NaN',
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
