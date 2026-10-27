// An uncached task that declares `inputs` has a key only so its dependants
// can fold it (2026-10-16): it always runs, and no cache layer,
// local or remote, is asked about, or handed, anything under that key.
// Whether a lookup happens follows `cache`, never a key existing.

import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { Cache, type RemoteCacheLayer } from '../src/cache/index.js'
import {
  addProject,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
  type Fixture,
} from './helpers/orchestrator-fixture.js'
import { run } from './helpers/orchestrator.js'

/** An in-memory remote recording every key it is asked about or handed. */
function remote(): { layer: RemoteCacheLayer; keys: string[] } {
  const store = new Map<string, Uint8Array>()
  const keys: string[] = []
  const layer: RemoteCacheLayer = {
    async has(h) {
      keys.push(h)
      return store.has(h) ? {} : null
    },
    async hasMany(hs) {
      keys.push(...hs)
      return new Map(hs.filter((h) => store.has(h)).map((h) => [h, {}]))
    },
    async get(h) {
      keys.push(h)
      const b = store.get(h)
      return b === undefined ? null : { body: new Blob([b]), durationMs: undefined }
    },
    async put(h, body) {
      keys.push(h)
      if (!store.has(h)) store.set(h, new Uint8Array(await body.arrayBuffer()))
    },
  }
  return { layer, keys }
}

let fixture: Fixture
const local: string[] = []
const spies: { mockRestore(): void }[] = []

beforeEach(async () => {
  fixture = await makeWorkspace('vx-uncached-no-lookup-')
  local.length = 0
  const proto = Cache.prototype
  const one = (name: 'get' | 'has' | 'prefetch' | 'getIngested' | 'restoreOutputs') => {
    const orig = proto[name] as (...a: unknown[]) => unknown
    spies.push(
      spyOn(proto, name).mockImplementation(function (this: Cache, ...a: unknown[]) {
        local.push(a[0] as string)
        return orig.apply(this, a)
      } as never),
    )
  }
  for (const name of ['get', 'has', 'prefetch', 'getIngested', 'restoreOutputs'] as const) one(name)
  for (const name of ['getMany', 'localHasMany'] as const) {
    const orig = proto[name] as (...a: unknown[]) => unknown
    spies.push(
      spyOn(proto, name).mockImplementation(function (this: Cache, ...a: unknown[]) {
        local.push(...(a[0] as string[]))
        return orig.apply(this, a)
      } as never),
    )
  }
  const save = proto.save
  spies.push(
    spyOn(proto, 'save').mockImplementation(function (
      this: Cache,
      args: Parameters<Cache['save']>[0],
    ) {
      local.push(args.hash)
      return save.call(this, args)
    }),
  )
})

afterEach(async () => {
  for (const s of spies.splice(0)) s.mockRestore()
  await rm(fixture.root, { recursive: true, force: true })
})

it(
  'runs every time, asks no cache about its key, and its dependant still hits',
  async () => {
    await addProject(fixture.root, 'app', {
      files: { 'src/in.txt': 'v1' },
      config: `export default { tasks: {
        gen: { exec: { command: 'cat src/in.txt > gen.txt' }, inputs: { files: ['src/**'] } },
        build: {
          dependsOn: ['gen'],
          exec: { command: 'cat gen.txt > out.txt' },
          inputs: { files: ['src/**'] },
          cache: { outputs: { files: ['out.txt'] } },
        },
      } }\n`,
    })
    const wire = remote()
    const once = () =>
      run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
        remoteCache: wire.layer,
      })
    const status = (r: Awaited<ReturnType<typeof once>>, id: string) =>
      r.outcomes.find((o) => o.node.id === id)!

    const first = await once()
    const second = await once()
    expect(first.ok && second.ok).toBe(true)
    // (a) it executes on both runs, under the same key.
    expect([status(first, 'app#gen').status, status(second, 'app#gen').status]).toEqual([
      'success',
      'success',
    ])
    const genKey = status(second, 'app#gen').hash!
    expect(status(first, 'app#gen').hash).toBe(genKey)
    // (c) its unchanged key lets the dependant hit.
    expect(status(second, 'app#build').status).toBe('cache-hit')
    // (b) no layer saw the key. CONTROL: the dependant's key reached both.
    const buildKey = status(second, 'app#build').hash!
    expect(local).toContain(buildKey)
    expect(wire.keys).toContain(buildKey)
    expect(local).not.toContain(genKey)
    expect(wire.keys).not.toContain(genKey)
  },
  TIMEOUT,
)
