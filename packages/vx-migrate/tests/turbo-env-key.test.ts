// G-147: the kept turbo() mapping keyed on every env var name, so a
// variable that came or went (a CI step's, `VX_TIMING`) remapped the
// workspace (~330 ms a run on vercel/ai). It keys on the names a wildcard
// can match, and on those core cannot key.
import { describe, expect, it } from 'bun:test'
import { planRun } from '@vzn/vx'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'
import { tamperMapping } from './helpers/tamper-mapping.js'

const ws = useTurboWorkspace({ tasks: { build: { env: ['MY_*'], outputs: ['dist/**'] } } })

const command = async (): Promise<string | undefined> =>
  (await planRun({ cwd: ws.root, tasks: ['lib#build'], log: silent() })).tasks.find(
    (t) => t.node.id === 'lib#build',
  )!.node.config.exec?.command

const MAPPED = 'mkdir -p dist && echo lib > dist/lib.js'

describe('turbo(): the mapping cache and the environment', () => {
  it.each([
    ['an unrelated name serves the kept mapping', 'VX_G147_UNRELATED', 'echo from-cache'],
    ['a name a turbo.json wildcard matches maps afresh', 'MY_G147', MAPPED],
    ['a name a framework wildcard matches maps afresh', 'NEXT_PUBLIC_G147', MAPPED],
    ['a name core cannot key maps afresh', 'G147*NAME', MAPPED],
  ])('%s', async (_, name, expected) => {
    expect(await command()).toBe(MAPPED)
    await tamperMapping(ws.root, 'turbo')
    process.env[name] = '1'
    try {
      expect(await command()).toBe(expected)
    } finally {
      delete process.env[name]
    }
  })
})
