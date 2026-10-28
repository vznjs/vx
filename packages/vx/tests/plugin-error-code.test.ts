// A plugin's refusal keeps the code it gave (cli.md: "A plugin can give its
// refusal a code"). A hook's throw was rewrapped as a codeless UserError, so
// an agent read VX_E_REFUSED where the same refusal from the plugin's verb
// said its own code (2026-10-28).
import { expect, it } from 'bun:test'
import { applyConfigHooks } from '../src/orchestrator/plugin-host.js'
import { installPlugins } from '../src/orchestrator/index.js'
import { createEventBus } from '../src/report/index.js'
import { errorCode, UserError } from '../src/util/index.js'
import { testPlugin } from './helpers/plugin.js'

const refusing = (hook: 'config' | 'setup') =>
  testPlugin('org/p', {
    [hook]: () => {
      throw new UserError('the token was refused', 'ORG_E_TOKEN')
    },
  })

const codeOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => 'resolved',
    (err: unknown) => [errorCode(err), (err as Error).message],
  )

it('a hook and setup keep the code a plugin refused with', async () => {
  expect([
    await codeOf(applyConfigHooks([refusing('config')], { plugins: [] }, {} as never)),
    await codeOf(
      installPlugins({
        plugins: [refusing('setup')],
        bus: createEventBus(),
        workspaceRoot: '/ws',
        cacheDir: '/ws/.vx/cache',
      }),
    ),
  ]).toEqual([
    ['ORG_E_TOKEN', "plugin 'org/p' failed in config: the token was refused"],
    ['ORG_E_TOKEN', "plugin 'org/p' failed in setup: the token was refused"],
  ])
})

it('CONTROL: a plain throw is VX_E_REFUSED', async () => {
  const p = testPlugin('org/p', {
    config: () => {
      throw new Error('boom')
    },
  })
  expect(await codeOf(applyConfigHooks([p], { plugins: [] }, {} as never))).toEqual([
    'VX_E_REFUSED',
    "plugin 'org/p' failed in config: boom",
  ])
})
