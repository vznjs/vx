// Signed artifacts (cache trust, step 1): with `cacheTrust.keys` set, a remote
// artifact is taken only when a listed key signed exactly its cache key and
// its entries. Anything else is a miss, refused before it is stored, so the
// task runs and the planted bytes never land.
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace, silentLogger, TIMEOUT } from './helpers/orchestrator-fixture.js'
import {
  extractArtifactStream,
  packArtifactBytes,
  planArtifact,
  scanArtifact,
  scanTarBytes,
} from '../src/cache/archive.js'
import { tarPack } from '../src/cache/tar-stream.js'
import { streamOf } from './helpers/stream.js'
import type { RemoteCacheLayer } from '../src/cache/index.js'
import { type ArtifactSigner, signedMessage, signerOf } from '../src/cache/trust.js'
import { run } from '../src/orchestrator/index.js'

const CFG = `export default { tasks: { build: {
  exec: { command: 'echo built > out.txt' },
  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } } } } }`

/** A fresh Ed25519 pair: the seed `VX_CACHE_SIGNING_KEY` takes, and the `cacheTrust.keys` entry. */
function keypair(): { seed: string; trusted: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16)
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12)
  return { seed: seed.toString('base64'), trusted: `ed25519:${pub.toString('base64')}` }
}

/** How a hostile remote signs: a trusted key's real signature over another message. */
type Forge = (signer: ArtifactSigner) => ArtifactSigner | undefined

/** A remote that answers every key with `outputs/out.txt` = `body`, signed as `forge` says. */
async function serving(dir: string, body: string, forge: Forge, seed: string) {
  const file = path.join(dir, '.remote-out')
  await writeFile(file, body)
  const gets: string[] = []
  const layer: RemoteCacheLayer = {
    endpoint: 'mem://test',
    async has() {
      return true
    },
    async get(hash: string) {
      gets.push(hash)
      const signer = forge(signerOf(seed))
      const tar = await packArtifactBytes(
        await planArtifact({
          key: hash,
          stdout: '',
          outputs: new Map([['outputs/out.txt', file]]),
          signer,
        }),
      )
      return { body: new Blob([Bun.zstdCompressSync(tar)]), durationMs: 1 }
    },
    async put() {},
  }
  return { layer, gets }
}

async function runApp(
  root: string,
  keys: readonly string[] | undefined,
  remote: RemoteCacheLayer,
): Promise<{ status: string; out: string; log: string[] }> {
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    `export default ${keys === undefined ? '{}' : JSON.stringify({ cacheTrust: { keys } })}\n`,
  )
  await rm(path.join(root, '.vx'), { recursive: true, force: true })
  const fx = { root, log: [] as string[], err: [] as string[] }
  const r = await run({ cwd: root, tasks: ['build'], log: silentLogger(fx), remoteCache: remote })
  return {
    status: r.outcomes[0]!.status,
    out: await readFile(path.join(root, 'packages/app/out.txt'), 'utf8'),
    log: [...fx.log, ...fx.err],
  }
}

const honest: Forge = (s) => s

describe('cacheTrust: a remote artifact must be signed by a trusted key', () => {
  it.each([
    ['signed by the trusted key', honest, 'cache-hit-remote', null],
    ['unsigned', () => undefined, 'success', 'artifact is not signed'],
    // A valid signature by the trusted key, over another cache key: a replay.
    [
      'signed over another cache key',
      (s: ArtifactSigner) => ({
        keyId: s.keyId,
        sign: (m: Uint8Array) => s.sign(signedMessage('f'.repeat(16), digestOf(m))),
      }),
      'success',
      'does not match its key and contents',
    ],
    // A valid signature by the trusted key, over other entries.
    [
      'signed over other contents',
      (s: ArtifactSigner) => ({
        keyId: s.keyId,
        sign: (m: Uint8Array) => s.sign(signedMessage(keyOf(m), '0'.repeat(64))),
      }),
      'success',
      'does not match its key and contents',
    ],
    [
      'naming the trusted key but signed by another',
      (s: ArtifactSigner) => ({ keyId: s.keyId, sign: signerOf(keypair().seed).sign }),
      'success',
      'does not match its key and contents',
    ],
  ] as const)(
    '%s',
    async (_label, forge, status, said) => {
      const fx = await makeWorkspace('vx-trust-')
      try {
        await addProject(fx.root, 'app', { files: { 'src/in.txt': 'v1' }, config: CFG })
        const k = keypair()
        const { layer } = await serving(fx.root, 'remote\n', forge, k.seed)
        const r = await runApp(fx.root, [k.trusted], layer)
        expect({
          status: r.status,
          out: r.out,
          said: said === null ? null : r.log.some((l) => l.includes(said)),
        }).toEqual({
          status,
          out: status === 'cache-hit-remote' ? 'remote\n' : 'built\n',
          said: said === null ? null : true,
        })
      } finally {
        await rm(fx.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a key the workspace does not list is refused by its id; listing it beside the old one takes it',
    async () => {
      const fx = await makeWorkspace('vx-trust-')
      try {
        await addProject(fx.root, 'app', { files: { 'src/in.txt': 'v1' }, config: CFG })
        const old = keypair()
        const next = keypair()
        const { layer } = await serving(fx.root, 'remote\n', honest, next.seed)
        const before = await runApp(fx.root, [old.trusted], layer)
        const rotated = await runApp(fx.root, [old.trusted, next.trusted], layer)
        const untrusted = await runApp(fx.root, undefined, layer)
        expect([
          before.status,
          before.log.some((l) => l.includes('signed by a key this workspace does not trust')),
          rotated.status,
          untrusted.status,
        ]).toEqual(['success', true, 'cache-hit-remote', 'cache-hit-remote'])
      } finally {
        await rm(fx.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a writer signs with VX_CACHE_SIGNING_KEY; without it, a trusting run uploads nothing',
    async () => {
      const fx = await makeWorkspace('vx-trust-')
      const prior = process.env['VX_CACHE_SIGNING_KEY']
      try {
        await addProject(fx.root, 'app', { files: { 'src/in.txt': 'v1' }, config: CFG })
        const k = keypair()
        const store = new Map<string, Uint8Array>()
        const remote: RemoteCacheLayer = {
          async has(hash) {
            return store.has(hash)
          },
          async get(hash) {
            const bytes = store.get(hash)
            return bytes === undefined ? null : { body: new Blob([bytes]), durationMs: undefined }
          },
          async put(hash, body) {
            store.set(hash, new Uint8Array(await body.arrayBuffer()))
          },
        }
        delete process.env['VX_CACHE_SIGNING_KEY']
        const unsigned = await runApp(fx.root, [k.trusted], remote)
        const uploadedUnsigned = store.size
        process.env['VX_CACHE_SIGNING_KEY'] = k.seed
        const signed = await runApp(fx.root, [k.trusted], remote)
        delete process.env['VX_CACHE_SIGNING_KEY']
        const read = await runApp(fx.root, [k.trusted], remote)
        const [bytes] = [...store.values()]
        const sig = scanTarBytes(Bun.zstdDecompressSync(bytes!)).signature
        expect([
          unsigned.status,
          uploadedUnsigned,
          signed.status,
          store.size,
          read.status,
          sig?.split(' ')[0],
        ]).toEqual(['success', 0, 'success', 1, 'cache-hit-remote', 'v1'])
      } finally {
        if (prior === undefined) delete process.env['VX_CACHE_SIGNING_KEY']
        else process.env['VX_CACHE_SIGNING_KEY'] = prior
        await rm(fx.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'trust never moves a key: a local entry saved without it hits with it',
    async () => {
      const fx = await makeWorkspace('vx-trust-')
      try {
        await addProject(fx.root, 'app', { files: { 'src/in.txt': 'v1' }, config: CFG })
        const fxLog = { root: fx.root, log: [] as string[], err: [] as string[] }
        const first = await run({ cwd: fx.root, tasks: ['build'], log: silentLogger(fxLog) })
        await writeFile(
          path.join(fx.root, 'vx.workspace.mjs'),
          `export default ${JSON.stringify({ cacheTrust: { keys: [keypair().trusted] } })}\n`,
        )
        const second = await run({ cwd: fx.root, tasks: ['build'], log: silentLogger(fxLog) })
        expect([second.outcomes[0]!.hash, second.outcomes[0]!.status]).toEqual([
          first.outcomes[0]!.hash,
          'cache-hit',
        ])
      } finally {
        await rm(fx.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe('signed artifacts, off', () => {
  it('no signer packs no `.vx-sig` and the scan takes no digest', async () => {
    const tar = await packArtifactBytes(
      await planArtifact({ key: 'k', stdout: 'x', outputs: new Map() }),
    )
    const scan = scanTarBytes(tar)
    expect([scan.signature, scan.digest]).toEqual([undefined, undefined])
  })

  it('a signed plan sizes the tar it packs', async () => {
    const plan = await planArtifact({
      key: 'k',
      stdout: 'x',
      outputs: new Map(),
      signer: signerOf(keypair().seed),
    })
    expect((await packArtifactBytes(plan)).byteLength).toBe(plan.size)
  })
})

describe('the signature entry', () => {
  it('a signed artifact restores; a second signature, or any entry after it, is refused', async () => {
    const tar = await packArtifactBytes(
      await planArtifact({
        key: 'k',
        stdout: 'x',
        outputs: new Map(),
        signer: signerOf(keypair().seed),
      }),
    )
    let end = tar.length
    while (tar.subarray(end - 512, end).every((b) => b === 0)) end -= 512
    const after = async (name: string): Promise<Uint8Array> => {
      const extra: Uint8Array[] = []
      for await (const c of tarPack([{ name, size: 1, body: 'x' }])) extra.push(c)
      return new Uint8Array([...tar.subarray(0, end), ...Buffer.concat(extra)])
    }
    const why = (t: Uint8Array) =>
      scanArtifact(streamOf(t)).then(
        () => 'scanned',
        (e: Error) => e.message,
      )
    const dest = await mkdtemp(path.join(os.tmpdir(), 'vx-sig-'))
    try {
      expect([
        await why(tar),
        await extractArtifactStream(streamOf(tar), dest, undefined).then(() => 'restored'),
        await why(await after('.vx-sig')),
        await why(await after('outputs/late.txt')),
      ]).toEqual([
        'scanned',
        'restored',
        "entry .vx-sig follows the artifact's checksum",
        "entry outputs/late.txt follows the artifact's checksum",
      ])
    } finally {
      await rm(dest, { recursive: true, force: true })
    }
  })
})

/** The message's parts: `vx-sig-v1\0<key>\0<digest>`. */
function partsOf(m: Uint8Array): string[] {
  return new TextDecoder().decode(m).split('\0')
}
function keyOf(m: Uint8Array): string {
  return partsOf(m)[1]!
}
function digestOf(m: Uint8Array): string {
  return partsOf(m)[2]!
}
