// Signed remote artifacts: with `trust.keys`, a downloaded artifact is taken
// only when a listed key signed exactly its storage key and bytes; anything
// else errors the body, which core's ingest turns into a miss, so the task
// runs and the planted bytes never land.
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { type RemoteCacheLayer, run } from '@vzn/vx'
import { signedRemote } from '../src/trust.js'

function keypair(): { seed: string; trusted: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16)
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12)
  return { seed: seed.toString('base64'), trusted: `ed25519:${pub.toString('base64')}` }
}

function memory(): RemoteCacheLayer & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>()
  return {
    store,
    async has(hash) {
      return store.has(hash)
    },
    async get(hash) {
      const bytes = store.get(hash)
      return bytes === undefined ? null : { body: new Blob([bytes]), durationMs: 1 }
    },
    async put(hash, body) {
      store.set(hash, new Uint8Array(await body.arrayBuffer()))
    },
  }
}

const opts = (signingKey?: string, warn: (m: string) => void = () => {}) => ({
  where: 'test',
  warn,
  signingKey,
})

/** What a get serves: its text, `miss`, or the refusal it errors with. */
async function served(layer: RemoteCacheLayer, key: string): Promise<string> {
  const got = await layer.get(key)
  if (got === null) return 'miss'
  return got.body.text().then(
    (t) => t,
    (e: Error) => e.message,
  )
}

describe('signedRemote', () => {
  it('a signed upload reads back as its bytes; anything else is refused', async () => {
    const k = keypair()
    const store = memory()
    const writer = signedRemote(store, { keys: [k.trusted] }, opts(k.seed))
    const reader = signedRemote(store, { keys: [k.trusted] }, opts())
    await writer.put('k', new Blob(['payload']), { durationMs: 1 })
    const signed = store.store.get('k')!
    // Unsigned, a flipped byte, the signed bytes under another key, a key the reader does not list.
    store.store.set('unsigned', new TextEncoder().encode('payload'))
    const flipped = signed.slice()
    flipped[0]! ^= 1
    store.store.set('flipped', flipped)
    store.store.set('replayed', signed)
    const other = keypair()
    await signedRemote(store, { keys: [other.trusted] }, opts(other.seed)).put(
      'other',
      new Blob(['payload']),
      { durationMs: 1 },
    )
    expect({
      size: signed.byteLength,
      k: await served(reader, 'k'),
      unsigned: await served(reader, 'unsigned'),
      flipped: await served(reader, 'flipped'),
      replayed: await served(reader, 'replayed'),
      other: (await served(reader, 'other')).replace(/\([0-9a-f]{16}\)/, '(id)'),
      missing: await served(reader, 'nope'),
    }).toEqual({
      size: 7 + 116,
      k: 'payload',
      unsigned: 'artifact unsigned refused: not signed',
      flipped: 'artifact flipped refused: its signature does not match its key and bytes',
      replayed: 'artifact replayed refused: its signature does not match its key and bytes',
      other: 'artifact other refused: signed by a key this workspace does not trust (id)',
      missing: 'miss',
    })
  })

  it('verifies across any chunking of the body', async () => {
    const k = keypair()
    const store = memory()
    await signedRemote(store, { keys: [k.trusted] }, opts(k.seed)).put(
      'k',
      new Blob(['x'.repeat(1000)]),
      { durationMs: 1 },
    )
    const bytes = store.store.get('k')!
    const outs: string[] = []
    for (const size of [1, 7, 115, 116, 117, 500, 2000]) {
      const chunked: RemoteCacheLayer = {
        has: async () => true,
        async get() {
          let at = 0
          const body = new ReadableStream<Uint8Array>({
            pull(c) {
              if (at >= bytes.byteLength) return c.close()
              c.enqueue(bytes.slice(at, at + size))
              at += size
            },
          })
          return { body: new Response(body), durationMs: 1 }
        },
        put: async () => {},
      }
      outs.push(await served(signedRemote(chunked, { keys: [k.trusted] }, opts()), 'k'))
    }
    expect(outs).toEqual(Array(7).fill('x'.repeat(1000)))
  })

  it('a reader without the wrapper still decodes a signed artifact', async () => {
    const k = keypair()
    const store = memory()
    const art = Bun.zstdCompressSync(new TextEncoder().encode('tar bytes'))
    await signedRemote(store, { keys: [k.trusted] }, opts(k.seed)).put('k', new Blob([art]), {
      durationMs: 1,
    })
    expect(new TextDecoder().decode(Bun.zstdDecompressSync(store.store.get('k')!))).toBe(
      'tar bytes',
    )
  })

  it('without a signing key nothing is uploaded, said once; a rotated key is read', async () => {
    const old = keypair()
    const next = keypair()
    const store = memory()
    const said: string[] = []
    const unsigned = signedRemote(
      store,
      { keys: [old.trusted] },
      opts(undefined, (m) => said.push(m)),
    )
    await unsigned.put('a', new Blob(['a']), { durationMs: 1 })
    await unsigned.put('b', new Blob(['b']), { durationMs: 1 })
    await signedRemote(store, { keys: [next.trusted] }, opts(next.seed)).put('c', new Blob(['c']), {
      durationMs: 1,
    })
    const both = signedRemote(store, { keys: [old.trusted, next.trusted] }, opts())
    expect([[...store.store.keys()], said.length, await served(both, 'c')]).toEqual([['c'], 1, 'c'])
  })

  it('refuses a malformed key list or signing key by name, never echoing the key', () => {
    const k = keypair()
    const why = (f: () => unknown) => {
      try {
        f()
        return 'ok'
      } catch (e) {
        return (e as Error).message
      }
    }
    const store = memory()
    expect([
      why(() => signedRemote(store, { keys: [] }, opts())),
      why(() => signedRemote(store, { keys: ['rsa:x'] }, opts())),
      why(() => signedRemote(store, { keys: [k.trusted] }, opts('c2VjcmV0'))),
    ]).toEqual([
      "test: `trust.keys` must list at least one 'ed25519:<base64 public key>'",
      `test: \`trust.keys\` entries are 'ed25519:<base64 public key>' (got "rsa:x")`,
      'VX_CACHE_SIGNING_KEY must be 32 bytes, base64',
    ])
  })
})

describe('signedRemote under core', () => {
  it('a remote artifact no trusted key signed is a miss, and the task runs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-trust-'))
    try {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
      )
      const app = path.join(root, 'packages', 'app')
      await mkdir(path.join(app, 'src'), { recursive: true })
      await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
      await writeFile(path.join(app, 'src', 'in.txt'), 'v1')
      await writeFile(
        path.join(app, 'vx.config.mjs'),
        `export default { tasks: { build: {
  exec: { command: 'echo built > out.txt' },
  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } } } } }
`,
      )
      Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
      const k = keypair()
      const store = memory()
      const log = { log: () => {}, status: () => {}, error: () => {} }
      const go = async (remote: RemoteCacheLayer) => {
        await rm(path.join(root, '.vx'), { recursive: true, force: true })
        await rm(path.join(app, 'out.txt'), { force: true })
        const r = await run({ cwd: root, tasks: ['build'], log: log as never, remoteCache: remote })
        return r.outcomes[0]!.status
      }
      const first = await go(signedRemote(store, { keys: [k.trusted] }, opts(k.seed)))
      const hit = await go(signedRemote(store, { keys: [k.trusted] }, opts()))
      // A writer with bucket access signs with a key the workspace does not list.
      const [key] = [...store.store.keys()]
      const bytes = store.store.get(key!)!.slice(0, -116)
      const attacker = keypair()
      await signedRemote(store, { keys: [attacker.trusted] }, opts(attacker.seed)).put(
        key!,
        new Blob([bytes]),
        { durationMs: 1 },
      )
      const refused = await go(signedRemote(store, { keys: [k.trusted] }, opts()))
      expect([first, hit, refused, await readFile(path.join(app, 'out.txt'), 'utf8')]).toEqual([
        'success',
        'cache-hit-remote',
        'success',
        'built\n',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
