// A kept mapping is keyed on what it read AND on the code that mapped it
// (`codeId`: core's VERSION and this package's sources). Keyed on the
// reads alone, a new vx-migrate or vx served the old mapping.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { type AdoptionMapping, cachedMapping, codeId } from '../src/mapping-cache.js'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-mapping-cache-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const hex = (s: string) => Bun.hash.xxHash3(s).toString(16).padStart(16, '0')
const mapping = (tag: string): AdoptionMapping => ({
  byName: new Map([['a', { tasks: [{ name: tag, task: null }] }]]),
  gaps: { notes: [], todos: new Map(), live: [] },
})
const held = (key: string) =>
  Bun.write(
    path.join(dir, 'vx-migrate-t-mapping.json'),
    JSON.stringify({
      key,
      byName: [['a', { tasks: [{ name: 'kept', task: null }] }]],
      notes: [],
      todos: [],
      live: [],
    }),
  )
const served = async (parts: string[]) =>
  (await cachedMapping(dir, 't', parts, async () => mapping('fresh'))).byName.get('a')!.tasks[0]!
    .name

it('a mapping kept under the reads alone, by other code, is mapped afresh', async () => {
  await held(hex(['graph-v1'].join('\0')))
  expect(await served(['graph-v1'])).toBe('fresh')
})

it('CONTROL: one kept under this code and these reads is served', async () => {
  await held(hex([await codeId(), 'graph-v1'].join('\0')))
  expect(await served(['graph-v1'])).toBe('kept')
  expect(await served(['graph-v2'])).toBe('fresh')
})
