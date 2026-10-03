// A global one config set reached every config loaded after it in the
// process: `vx run --all` read it, `--filter` of the reader alone did not,
// so one config gave two task commands by what else loaded (D-122). A
// global a config adds or replaces is put back and refused, naming it.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { loadProjectConfigs } from '../src/workspace/project-loader.js'

async function load(sources: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-global-'))
  try {
    const files = await Promise.all(
      sources.map(async (src, i) => {
        const file = path.join(dir, `p${i}`, 'vx.config.mjs')
        await Bun.write(file, src)
        return file
      }),
    )
    return await loadProjectConfigs(files).then(
      (configs) => `loaded ${JSON.stringify(configs.map((c) => c.tasks))}`,
      (err: Error) => err.message.replaceAll(dir, '<dir>'),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const refused = (n: number, key: string) =>
  `<dir>/p${n}/vx.config.mjs changed globalThis.${key} while it was evaluated — a config must not change the built-ins vx runs on: other configs are read through them and cache keys are made with them; a constant configs share goes in a module each one imports`
const innocent = 'export default { tasks: {} }\n'

it('a global a config adds is removed and refused, alone or among others', async () => {
  const adds = `globalThis.__vxLeak = 'leaked'\n${innocent}`
  expect(await load([adds])).toBe(refused(0, '__vxLeak'))
  expect(await load([innocent, adds, innocent])).toBe(refused(1, '__vxLeak'))
  expect('__vxLeak' in globalThis).toBe(false)
})

it('a global a config replaces is put back and refused', async () => {
  const fetch = globalThis.fetch
  expect(await load([`globalThis.fetch = () => 1\n${innocent}`])).toBe(refused(0, 'fetch'))
  expect(globalThis.fetch).toBe(fetch)
})

it('a config that only reads globals loads', async () => {
  // CONTROL: NaN, a lazily made global, and node built-ins read without a change.
  const reads = `import 'node:path'\nvoid fetch, crypto, navigator, performance, Buffer\nexport default { tasks: { t: { exec: { command: String(Number.isNaN(globalThis.NaN)) } } } }\n`
  expect(await load([reads, innocent])).toBe('loaded [{"t":{"exec":{"command":"true"}}},{}]')
})
