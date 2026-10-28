// A plugin may throw anything, not only an Error. Every seam names the
// plugin and the hook, then what was thrown: `String(err)` read
// `[object Object]` for an error-like `{ message }`, and threw itself on an
// object with no prototype, so the plugin's failure surfaced as vx's own
// `Cannot convert object to primitive value`.
import { expect, it } from 'bun:test'
import type { TaskNode } from '../src/graph/index.js'
import type { WorkspaceConfig } from '../src/config.js'
import {
  applyConfigHooks,
  buildAdmission,
  teardownPlugins,
} from '../src/orchestrator/plugin-host.js'
import { thrownMessage } from '../src/util/index.js'
import { testPlugin } from './helpers/plugin.js'

const THROWN: [string, () => unknown][] = [
  ['error-like', () => ({ message: 'pool down', status: 503 })],
  ['bare', () => undefined],
  ['no prototype', () => Object.create(null) as unknown],
  ['record', () => ({ status: 503 })],
  ['empty Error', () => new Error()],
  ['string', () => 'quota'],
]
const SAID = [
  'pool down',
  'threw undefined',
  'threw {}',
  'threw {"status":503}',
  'threw Error with no message',
  'quota',
]

it('thrownMessage says each thrown value, never throwing itself', () => {
  expect(THROWN.map(([, make]) => thrownMessage(make()))).toEqual(SAID)
})

it('a stage names the plugin, the hook and what it threw', async () => {
  const said: string[] = []
  for (const [, make] of THROWN) {
    const plugin = testPlugin('org/odd', {
      config: () => {
        throw make()
      },
    })
    try {
      await applyConfigHooks([plugin], {} as WorkspaceConfig, {} as never)
    } catch (err) {
      said.push((err as Error).message)
    }
  }
  expect(said).toEqual(SAID.map((m) => `plugin 'org/odd' failed in config: ${m}`))
})

it('admit and teardown name what was thrown', async () => {
  const said: string[] = []
  const admit = buildAdmission(
    [
      testPlugin('org/odd', {
        admit: () => {
          throw Object.create(null)
        },
      }),
    ],
    new Map([['a#t', { id: 'a#t' } as TaskNode]]),
    1,
    (m) => said.push(m),
  )!
  expect(admit('a#t', new Set())).toBe(true)
  await teardownPlugins(
    [
      testPlugin('org/odd', {
        teardown: () => {
          throw { message: 'socket gone' }
        },
      }),
    ],
    (m) => said.push(m),
  )
  expect(said).toEqual([
    "[vx] plugin 'org/odd' failed in admit: threw {}; admitting every task from here on",
    "[vx] plugin 'org/odd' failed in teardown: socket gone",
  ])
})
