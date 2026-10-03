// A misspelt option was read as unset: Bun strips a config's types, so
// the factory saw the typo and the plugin quietly declined or kept its
// default. `scheduleHistoryPlugin()` now refuse a key it does not read (stream F).
import { expect, it } from 'bun:test'
import { scheduleHistoryPlugin } from '../src/index.js'

const refusal = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('a misspelt option is refused, naming the nearest one', () => {
  expect(refusal(() => scheduleHistoryPlugin({ windw: 5 } as never))).toBe(
    'scheduleHistoryPlugin() has unknown option "windw" (allowed: assume, memory, reservations, resources, window) \u2014 did you mean window?',
  )
})

it('no options is taken', () => {
  expect(refusal(() => scheduleHistoryPlugin({}))).not.toContain('unknown option')
})
