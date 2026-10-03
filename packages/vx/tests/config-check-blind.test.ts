// The built-ins check read through what a config could replace: a config
// that set `Reflect.ownKeys = () => []` (or `Array.prototype.forEach`)
// blinded it, and its `Object.prototype.exec` ran in another project's
// task. Nor did it watch `RegExp.prototype`, `Date`, `Reflect` or `Object`,
// which vx's own matching and timing read through (D-124).
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { loadProjectConfigs } from '../src/workspace/project-loader.js'

async function load(source: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-blind-'))
  try {
    const file = path.join(dir, 'p', 'vx.config.mjs')
    await Bun.write(file, source)
    return await loadProjectConfigs([file]).then(
      () => 'loaded',
      (err: Error) => err.message.replace(/^.*? changed (.*?) while it was evaluated.*$/s, '$1'),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const innocent = 'export default { tasks: {} }\n'
const pollutes = "Object.prototype.exec = { command: 'echo PWNED' }\n"

it('a config cannot blind the check before polluting a prototype', async () => {
  const ownKeys = Reflect.ownKeys
  expect(await load(`Reflect.ownKeys = () => []\n${pollutes}${innocent}`)).toBe(
    'Object.prototype.exec, Reflect.ownKeys',
  )
  expect(Reflect.ownKeys).toBe(ownKeys)
  expect('exec' in {}).toBe(false)
  const forEach = Array.prototype.forEach
  expect(await load(`Array.prototype.forEach = () => {}\n${pollutes}${innocent}`)).toBe(
    'Object.prototype.exec, Array.prototype.forEach',
  )
  expect(Array.prototype.forEach).toBe(forEach)
})

it('RegExp.prototype, Date, Object and Function.prototype are watched', async () => {
  const test = RegExp.prototype.test
  const now = Date.now
  expect(await load(`RegExp.prototype.test = () => true\n${innocent}`)).toBe(
    'RegExp.prototype.test',
  )
  expect(await load(`Date.now = () => 0\n${innocent}`)).toBe('Date.now')
  expect(await load(`Object.keys = () => []\n${innocent}`)).toBe('Object.keys')
  expect(await load(`Function.prototype.call = Function.prototype.apply\n${innocent}`)).toBe(
    'Function.prototype.call',
  )
  expect(RegExp.prototype.test).toBe(test)
  expect(Date.now).toBe(now)
})

it('a config that only reads them loads', async () => {
  // CONTROL: matching, dates, reflection and calls, nothing replaced.
  const reads = `void /a/.test('a'), Date.now(), new Date().toISOString(), Reflect.ownKeys({}), Object.keys({}), [1].forEach(String)\n${innocent}`
  expect(await load(reads)).toBe('loaded')
})
