// Configs load 128 at a time, so a change one config makes to a built-in
// surfaced after another's load, and the refusal named the wrong file
// (D-119). The round asks each config alone and names the one that made it.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { loadProjectConfigs } from '../src/workspace/project-loader.js'

async function refusal(sources: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-blame-'))
  try {
    const files = await Promise.all(
      sources.map(async (src, i) => {
        const file = path.join(dir, `p${i}`, 'vx.config.mjs')
        await Bun.write(file, src)
        return file
      }),
    )
    return await loadProjectConfigs(files).then(
      () => 'loaded',
      (err: Error) => err.message.replaceAll(dir, '<dir>').split(' while it was evaluated')[0]!,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const innocent = 'export default { tasks: {} }\n'

it('names the config that changed a built-in, not the one whose load saw it', async () => {
  expect(
    await refusal([
      innocent,
      'globalThis.Bun.spawn = () => { throw new Error("x") }\nexport default { tasks: {} }\n',
      innocent,
    ]),
  ).toBe('<dir>/p1/vx.config.mjs changed Bun.spawn')
  expect(
    await refusal([
      innocent,
      innocent,
      'process.env.VX_D119 = "1"\nexport default { tasks: {} }\n',
    ]),
  ).toBe('<dir>/p2/vx.config.mjs changed process.env.VX_D119')
  expect(process.env['VX_D119']).toBeUndefined()
  // CONTROL: a single config is named as before.
  expect(await refusal(['Math.max = () => 0\nexport default { tasks: {} }\n'])).toBe(
    '<dir>/p0/vx.config.mjs changed Math.max',
  )
})
