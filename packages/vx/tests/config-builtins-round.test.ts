// Several configs loading at once are checked for a changed built-in in two
// steps: after each load, the ones the loader itself runs on; at the round's
// end, all of them. A change caught at the end is refused with its config
// named, and nothing the round evaluated is stored: another config may have
// been evaluated through the changed built-in.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { ConfigEvalStore } from '../src/workspace/index.js'
import { loadProjectConfigs } from '../src/workspace/project-loader.js'

class Store implements ConfigEvalStore {
  rows = new Map<string, string>()
  getConfigEval(key: string): string | null {
    return this.rows.get(key) ?? null
  }
  putConfigEval(key: string, json: string): void {
    this.rows.set(key, json)
  }
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-round-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function load(sources: string[], store: Store): Promise<string> {
  const files = await Promise.all(
    sources.map(async (src, i) => {
      const file = path.join(dir, `p${i}`, 'vx.config.mjs')
      await Bun.write(file, src)
      return file
    }),
  )
  return loadProjectConfigs(files, { evalCache: { store, workspaceFingerprint: 'fp' } }).then(
    () => 'loaded',
    (err: Error) => err.message.replaceAll(dir, '<dir>').split(' while it was evaluated')[0]!,
  )
}

const innocent = (n: number): string =>
  `export default { tasks: { t${n}: { exec: { command: "echo ${n}" } } } }\n`

it('a built-in checked at the round end is refused, named, put back, and nothing is stored', async () => {
  const trim = String.prototype.trim
  const store = new Store()
  expect(
    await load(
      [
        innocent(0),
        'String.prototype.trim = () => "x"\nexport default { tasks: {} }\n',
        innocent(2),
      ],
      store,
    ),
  ).toBe('<dir>/p1/vx.config.mjs changed String.prototype.trim')
  expect(String.prototype.trim).toBe(trim)
  expect(store.rows.size).toBe(0)
})

it('CONTROL: a round that changes nothing stores every evaluation', async () => {
  const store = new Store()
  expect(await load([innocent(0), innocent(1), innocent(2)], store)).toBe('loaded')
  expect(store.rows.size).toBe(3)
})
