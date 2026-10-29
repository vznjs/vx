// A plugin's `ctx.cache` (design docs/design/shared-timings-2026-10.md):
// its own entries in the cache the workspace declares, the local store
// first, then each remote, under the run's policy and scope; written once,
// every failure an absent answer.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  indexDb,
  Cache,
  pluginCache,
  PLUGIN_ENTRY_MAX_BYTES,
  type ResolvedRemote,
  type RemoteCacheLayer,
} from '../src/cache/index.js'
import { xxh3hex } from '../src/util/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { gitInitCommit } from './helpers/workspace.js'
import { run } from './helpers/orchestrator.js'
import { pluginSource } from './helpers/plugin.js'

const FULL = { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true }
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array | null): string | null =>
  b === null ? null : new TextDecoder().decode(b)

interface Wire extends RemoteCacheLayer {
  store: Map<string, Uint8Array>
  calls: string[]
}

function wire(opts: { batch?: boolean; fail?: boolean } = {}): Wire {
  const store = new Map<string, Uint8Array>()
  const calls: string[] = []
  const boom = (): void => {
    if (opts.fail) throw new Error('remote down')
  }
  const w: Wire = {
    store,
    calls,
    async has(h) {
      calls.push(`has ${h}`)
      boom()
      return store.has(h) ? {} : null
    },
    async get(h) {
      calls.push(`get ${h}`)
      boom()
      const b = store.get(h)
      return b === undefined ? null : { body: new Blob([b]), durationMs: undefined }
    },
    // The seam's contract: a put of a stored key keeps the stored bytes.
    async put(h, body) {
      calls.push(`put ${h}`)
      boom()
      if (!store.has(h)) store.set(h, new Uint8Array(await body.arrayBuffer()))
    },
  }
  if (opts.batch) {
    w.hasMany = async (hs) => {
      calls.push(`hasMany ${hs.length}`)
      boom()
      return new Map(hs.filter((h) => store.has(h)).map((h) => [h, {}]))
    }
  }
  return w
}

const dirs: string[] = []
const caches: Cache[] = []
afterEach(() => {
  for (const c of caches.splice(0)) c.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function localStore(): Cache {
  const dir = mkdtempSync(path.join(tmpdir(), 'vx-plugin-cache-'))
  dirs.push(dir)
  const c = new Cache(dir, { read: true, write: true })
  caches.push(c)
  return c
}

const remoteOf = (remote: RemoteCacheLayer, read = true, write = true): ResolvedRemote => ({
  remote,
  read,
  write,
})

describe('ctx.cache', () => {
  it('has answers true after a put and false for an absent key, through the local store', async () => {
    const c = pluginCache('org/a', {
      db: indexDb(localStore()),
      policy: FULL,
      remotes: [],
      scope: undefined,
    })
    expect(await c.has('x')).toBe(false)
    await c.put('x', bytes('one'))
    expect(await c.has('x')).toBe(true)
    expect(text(await c.get('x'))).toBe('one')
    expect(await c.get('y')).toBeNull()
  })

  it('has answers through a remote layer, and a remote hit is kept locally', async () => {
    const remote = wire()
    const db = indexDb(localStore())
    const writer = pluginCache('org/a', {
      db: indexDb(localStore()),
      policy: FULL,
      remotes: [remoteOf(remote)],
      scope: undefined,
    })
    await writer.put('x', bytes('one'))
    expect(remote.store.size).toBe(1)
    const reader = pluginCache('org/a', {
      db,
      policy: FULL,
      remotes: [remoteOf(remote)],
      scope: undefined,
    })
    expect(await reader.has('x')).toBe(true)
    expect(await reader.has('nope')).toBe(false)
    expect(text(await reader.get('x'))).toBe('one')
    remote.calls.length = 0
    expect(text(await reader.get('x'))).toBe('one')
    expect(remote.calls).toEqual([])
  })

  it('a put never replaces an entry, locally or remotely', async () => {
    const remote = wire()
    const c = pluginCache('org/a', {
      db: indexDb(localStore()),
      policy: FULL,
      remotes: [remoteOf(remote)],
      scope: undefined,
    })
    await c.put('x', bytes('first'))
    await c.put('x', bytes('second'))
    expect(text(await c.get('x'))).toBe('first')
    // Core asks no `has` before a put (2026-10-15): the remote keeps
    // what it holds.
    expect(remote.calls.filter((k) => !k.startsWith('get'))).toEqual([
      `put ${[...remote.store.keys()][0]}`,
      `put ${[...remote.store.keys()][0]}`,
    ])
    expect(text([...remote.store.values()][0]!)).toBe('first')
  })

  it('reads a remote the policy reads no artifact from, one it may write', async () => {
    const remote = wire()
    remote.store.set(xxh3hex('vx-plugin\0org/a\0x'), bytes('timings'))
    const c = pluginCache('org/a', {
      db: indexDb(localStore()),
      policy: { ...FULL, remoteRead: false },
      remotes: [remoteOf(remote, false, true)],
      scope: undefined,
    })
    expect(text(await c.get('x'))).toBe('timings')
  })

  // A cold CI run (`local:w,remote:w`) still reads a plugin's entries:
  // only artifacts are cold (2026-10-24).
  it('a cold policy, writing only, still reads and probes a remote entry', async () => {
    const remote = wire({ batch: true })
    remote.store.set(xxh3hex('vx-plugin\0org/a\0x'), bytes('timings'))
    const c = pluginCache('org/a', {
      db: indexDb(localStore()),
      policy: { localRead: false, localWrite: true, remoteRead: false, remoteWrite: true },
      remotes: [remoteOf(remote, false, true)],
      scope: undefined,
    })
    expect([...((await c.hasMany(['x', 'y'])) ?? [])]).toEqual(['x'])
    expect(text(await c.get('x'))).toBe('timings')
  })

  it('a read-only policy keeps a put out of the remote', async () => {
    const remote = wire()
    const c = pluginCache('org/a', {
      db: indexDb(localStore()),
      policy: { ...FULL, remoteWrite: false },
      remotes: [remoteOf(remote, true, false)],
      scope: undefined,
    })
    await c.put('x', bytes('one'))
    expect(remote.store.size).toBe(0)
    expect(await c.has('x')).toBe(true)
  })

  it('names are the plugin own: another plugin reads none of them', async () => {
    const db = indexDb(localStore())
    const remote = wire()
    await pluginCache('org/a', {
      db,
      policy: FULL,
      remotes: [remoteOf(remote)],
      scope: undefined,
    }).put('x', bytes('a'))
    const b = pluginCache('org/b', {
      db,
      policy: FULL,
      remotes: [remoteOf(remote)],
      scope: undefined,
    })
    expect(await b.get('x')).toBeNull()
    expect(await b.has('x')).toBe(false)
    expect([...remote.store.keys()]).toEqual([xxh3hex('vx-plugin\0org/a\0x')])
  })

  it('a scoped run reads the default entry when asked and writes only its own', async () => {
    const remote = wire()
    const plain = pluginCache('org/a', {
      db: indexDb(localStore()),
      policy: FULL,
      remotes: [remoteOf(remote)],
      scope: undefined,
    })
    await plain.put('shared', bytes('main'))
    const scoped = pluginCache('org/a', {
      db: indexDb(localStore()),
      policy: FULL,
      remotes: [remoteOf(remote)],
      scope: 'pr-1',
    })
    expect(text(await scoped.get('shared', false))).toBe('main')
    await scoped.put('mine', bytes('pr'))
    const other = pluginCache('org/a', {
      db: indexDb(localStore()),
      policy: FULL,
      remotes: [remoteOf(remote)],
      scope: undefined,
    })
    expect(await other.get('mine')).toBeNull()
  })

  it("a scoped run asks one key per read: the scope's, or the default with scoped false", async () => {
    const remote = wire({ batch: true })
    const scoped = pluginCache('org/a', {
      db: indexDb(localStore()),
      policy: { ...FULL, localRead: false },
      remotes: [remoteOf(remote)],
      scope: 'pr-1',
    })
    const plain = xxh3hex('vx-plugin\0org/a\0x')
    const own = xxh3hex(`vx-cache-scope\0pr-1\0${plain}`)
    await scoped.get('x')
    await scoped.has('x')
    await scoped.hasMany(['x'])
    await scoped.get('x', false)
    await scoped.has('x', false)
    await scoped.hasMany(['x'], false)
    expect(remote.calls).toEqual([
      `get ${own}`,
      `has ${own}`,
      'hasMany 1',
      `get ${plain}`,
      `has ${plain}`,
      'hasMany 1',
    ])
  })

  // The local store keeps a name under its plain key, scope or not: a
  // scoped hasMany matched those against the scope's keys and found none,
  // answering absent (with an `undefined` member) for what get returns.
  it('a scoped hasMany finds what the local store holds, as get does', async () => {
    const remote = wire({ batch: true })
    const c = pluginCache('org/a', {
      db: indexDb(localStore()),
      policy: FULL,
      remotes: [remoteOf(remote)],
      scope: 'pr-1',
    })
    await c.put('x', bytes('mine'))
    remote.store.clear()
    remote.calls.length = 0
    expect(text(await c.get('x'))).toBe('mine')
    expect(await c.has('x')).toBe(true)
    expect(await c.hasMany(['x', 'y'])).toEqual(new Set(['x']))
    expect(await c.hasMany(['x', 'y'], false)).toEqual(new Set(['x']))
    expect(remote.calls).toEqual(['hasMany 1', 'hasMany 1'])
  })

  it('hasMany is one probe per layer, and null when a remote cannot batch', async () => {
    const remote = wire({ batch: true })
    const c = pluginCache('org/a', {
      db: indexDb(localStore()),
      policy: FULL,
      remotes: [remoteOf(remote)],
      scope: undefined,
    })
    await c.put('b', bytes('2'))
    const fresh = pluginCache('org/a', {
      db: indexDb(localStore()),
      policy: FULL,
      remotes: [remoteOf(remote)],
      scope: undefined,
    })
    remote.calls.length = 0
    expect(await fresh.hasMany(['a', 'b', 'c'])).toEqual(new Set(['b']))
    expect(remote.calls).toEqual(['hasMany 3'])
    const noBatch = pluginCache('org/a', {
      db: indexDb(localStore()),
      policy: FULL,
      remotes: [remoteOf(wire())],
      scope: undefined,
    })
    expect(await noBatch.hasMany(['a'])).toBeNull()
  })

  // Said, as a task artifact's remote fault is: dropped unsaid, a remote
  // down left DTE planning on no timings with no line saying why.
  it('a failing remote is an absent answer, never a throw, and said once per kind', async () => {
    const said: string[] = []
    const c = pluginCache('org/a', {
      db: indexDb(localStore()),
      policy: FULL,
      remotes: [
        { ...remoteOf(wire({ fail: true, batch: true })), onError: (e) => said.push(e.message) },
      ],
      scope: undefined,
    })
    expect(await c.get('x')).toBeNull()
    expect(await c.get('y')).toBeNull()
    expect(await c.has('x')).toBe(false)
    expect(await c.hasMany(['x'])).toBeNull()
    await c.put('x', bytes('kept here'))
    expect(text(await c.get('x'))).toBe('kept here')
    expect(said).toEqual([
      "get of org/a's x failed: remote down",
      "has of org/a's x failed: remote down",
      "hasMany of org/a's 1 entries failed: remote down",
      "put of org/a's x failed: remote down",
    ])
  })

  it('a remote body over the cap is a miss, and a put over it stores nothing', async () => {
    const remote = wire()
    const key = xxh3hex('vx-plugin\0org/a\0big')
    remote.store.set(key, new Uint8Array(PLUGIN_ENTRY_MAX_BYTES + 1))
    const c = pluginCache('org/a', {
      db: indexDb(localStore()),
      policy: FULL,
      remotes: [remoteOf(remote)],
      scope: undefined,
    })
    expect(await c.get('big')).toBeNull()
    await c.put('huge', new Uint8Array(PLUGIN_ENTRY_MAX_BYTES + 1))
    expect(await c.has('huge')).toBe(false)
  })

  it('an empty or odd remote body is a miss and is not kept, so a later good body is read', async () => {
    // Security on #3580: an odd body read as empty bytes was kept locally,
    // and write-once then hid every later good body on this machine.
    const key = xxh3hex('vx-plugin\0org/a\0x')
    const db = indexDb(localStore())
    for (const body of [
      new Blob([]),
      new Response(null),
      new Response(new Uint8Array(0)),
      'not a body' as unknown as Blob,
    ]) {
      const odd: RemoteCacheLayer = {
        has: async () => ({}),
        get: async () => ({ body, durationMs: undefined }),
        put: async () => {},
      }
      const c = pluginCache('org/a', {
        db,
        policy: FULL,
        remotes: [remoteOf(odd)],
        scope: undefined,
      })
      expect(await c.get('x')).toBeNull()
    }
    const good = wire()
    good.store.set(key, bytes('one'))
    const c = pluginCache('org/a', {
      db,
      policy: FULL,
      remotes: [remoteOf(good)],
      scope: undefined,
    })
    expect(text(await c.get('x'))).toBe('one')
    await c.put('empty', new Uint8Array(0))
    expect(await c.has('empty')).toBe(false)
  })

  it('a run hands schedule and setup the cache, behind a declared remote', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vx-plugin-cache-run-'))
    dirs.push(root)
    await Bun.write(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['pkg-a'] }),
    )
    await Bun.write(path.join(root, 'pkg-a/package.json'), JSON.stringify({ name: 'pkg-a' }))
    await Bun.write(
      path.join(root, 'pkg-a/vx.config.mjs'),
      `export default { tasks: { hello: { exec: { command: 'echo hi' } } } }`,
    )
    const box = globalThis as unknown as { __vxWire: Map<string, Uint8Array>; __vxSeen: string[] }
    box.__vxWire = new Map([[xxh3hex('vx-plugin\0org/user\0seed'), bytes('from-remote')]])
    box.__vxSeen = []
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource([
        pluginSource(
          'org/wire',
          `{ cache: () => ({
              has: async (h) => globalThis.__vxWire.has(h),
              get: async (h) => globalThis.__vxWire.has(h) ? { body: new Blob([globalThis.__vxWire.get(h)]), durationMs: undefined } : null,
              put: async (h, b) => { globalThis.__vxWire.set(h, new Uint8Array(await b.arrayBuffer())) },
            }) }`,
        ),
        pluginSource(
          'org/user',
          `{ async schedule(nodes, ctx) {
               const got = await ctx.cache.get('seed')
               globalThis.__vxSeen.push('schedule:' + (got && new TextDecoder().decode(got)))
               return undefined
             },
             async setup(ctx) {
               await ctx.cache.put('written', new TextEncoder().encode('w'))
               globalThis.__vxSeen.push('setup:' + (await ctx.cache.has('written')) + ':' + typeof ctx.ci)
             } }`,
        ),
      ]),
    )
    gitInitCommit(root)
    const summary = await run({
      cwd: root,
      projects: ['pkg-a'],
      tasks: ['hello'],
      handleSignals: false,
      cache: { ...FULL, remoteWrite: false },
    })
    expect(summary.ok).toBe(true)
    expect(box.__vxSeen.toSorted()).toEqual(['schedule:from-remote', 'setup:true:boolean'])
    // A read-only policy reads the remote and never writes it.
    expect(box.__vxWire.has(xxh3hex('vx-plugin\0org/user\0written'))).toBe(false)
  })
})
