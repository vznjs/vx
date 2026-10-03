// A synchronous loop in a config holds the thread it runs on. On a first
// load that is vx's own, so the deadline cannot fire (documented); a repeat
// load runs in its Worker, and there the budget still ends it.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { evaluateConfigFresh } from '../src/workspace/config-eval.js'

const BUDGET = 'VX_CONFIG_WORKER_TIMEOUT_MS'
const saved = process.env[BUDGET]
let dir: string | undefined

afterEach(async () => {
  if (saved === undefined) delete process.env[BUDGET]
  else process.env[BUDGET] = saved
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

const settle = async (body: string) => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-sync-loop-'))
  const file = path.join(dir, 'vx.config.mjs')
  await writeFile(file, body)
  process.env[BUDGET] = '300'
  return evaluateConfigFresh(file).then(
    () => 'settled',
    (err: Error) => err.message,
  )
}

it("a repeat load's Worker ends a synchronous loop at the budget", async () => {
  expect(await settle('while (true) {}\nexport default {}\n')).toBe(
    'config worker did not answer within 300ms',
  )
})

it('CONTROL: a config that returns settles within the same budget', async () => {
  expect(await settle('export default { tasks: {} }\n')).toBe('settled')
})
