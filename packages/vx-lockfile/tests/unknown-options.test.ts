// A misspelt option was read as unset: Bun strips a config's types, so
// the factory saw the typo and the plugin quietly declined or kept its
// default. `pnpm()`, `bun()`, `npm()`, `yarn()` now refuse a key they do not read (stream F).
import { expect, it } from 'bun:test'
import { pnpm, bun, npm, yarn } from '../src/index.js'

const refusal = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('a misspelt option is refused, naming the nearest one', () => {
  expect(refusal(() => pnpm({ scoep: 'x' } as never))).toBe(
    'pnpm() has unknown option "scoep" (allowed: scope) \u2014 did you mean scope?',
  )
  expect(refusal(() => bun({ scoep: 'x' } as never))).toBe(
    'bun() has unknown option "scoep" (allowed: scope) \u2014 did you mean scope?',
  )
  expect(refusal(() => npm({ scoep: 'x' } as never))).toBe(
    'npm() has unknown option "scoep" (allowed: scope) \u2014 did you mean scope?',
  )
  expect(refusal(() => yarn({ scoep: 'x' } as never))).toBe(
    'yarn() has unknown option "scoep" (allowed: scope) \u2014 did you mean scope?',
  )
})

it('no options is taken', () => {
  expect(refusal(() => pnpm({}))).not.toContain('unknown option')
  expect(refusal(() => bun({}))).not.toContain('unknown option')
  expect(refusal(() => npm({}))).not.toContain('unknown option')
  expect(refusal(() => yarn({}))).not.toContain('unknown option')
})
