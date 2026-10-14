// Several configs loading at once are checked for a changed built-in in two
// steps: after each load, the ones the loader itself runs on; at the round's
// end, all of them. A change caught at the end is refused with its config
// named.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { loadProjectConfigs } from '../src/workspace/project-loader.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-round-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function load(sources: string[]): Promise<string> {
  const files = await Promise.all(
    sources.map(async (src, i) => {
      const file = path.join(dir, `p${i}`, 'vx.config.mjs')
      await Bun.write(file, src)
      return file
    }),
  )
  return loadProjectConfigs(files).then(
    () => 'loaded',
    (err: Error) => err.message.replaceAll(dir, '<dir>').split(' while it was evaluated')[0]!,
  )
}

const innocent = (n: number): string =>
  `export default { tasks: { t${n}: { exec: { command: "echo ${n}" } } } }\n`

it('a built-in checked at the round end is refused, named, and put back', async () => {
  const trim = String.prototype.trim
  expect(
    await load([
      innocent(0),
      'String.prototype.trim = () => "x"\nexport default { tasks: {} }\n',
      innocent(2),
    ]),
  ).toBe('<dir>/p1/vx.config.mjs changed String.prototype.trim')
  expect(String.prototype.trim).toBe(trim)
})

it('CONTROL: a round that changes nothing loads', async () => {
  expect(await load([innocent(0), innocent(1), innocent(2)])).toBe('loaded')
})
