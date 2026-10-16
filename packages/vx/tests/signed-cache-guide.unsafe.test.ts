// Cache trust without core: the plugins guide's "Signed artifacts" example is
// a third-party cache plugin that signs uploads and refuses a download no
// trusted key signed. This runs that exact code through `vx run`'s cache
// seam, so the guide's claim, that core needs nothing more, stays true.
// Unsafe: it reads vx-docs.
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { CORE_INDEX } from './helpers/local-workspace.js'
import { addProject, makeWorkspace, silentLogger, TIMEOUT } from './helpers/orchestrator-fixture.js'
import { run } from './helpers/orchestrator.js'

const GUIDE = path.resolve(import.meta.dir, '../../vx-docs/src/content/docs/guides/plugins.md')

/** The guide's `signed-cache.ts` fence, importing core from source. */
function example(): string {
  const fence = /```ts\n\/\/ signed-cache\.ts\n([\s\S]*?)```/.exec(readFileSync(GUIDE, 'utf8'))
  expect(fence).not.toBeNull()
  return fence![1]!.replace("from '@vzn/vx'", `from ${JSON.stringify(CORE_INDEX)}`)
}

const CFG = `export default { tasks: { build: {
  exec: { command: 'echo built > out.txt' },
  inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } } } } }`

/** A remote that is a directory: what a bucket anyone can write looks like. */
const DIR_REMOTE = `
import { mkdirSync, existsSync } from 'node:fs'
export default function dirRemote(dir) {
  mkdirSync(dir, { recursive: true })
  const at = (h) => dir + '/' + h
  return {
    has: async (h) => existsSync(at(h)),
    get: async (h) => (existsSync(at(h)) ? { body: Bun.file(at(h)), durationMs: undefined } : null),
    put: async (h, body) => { await Bun.write(at(h), await body.bytes()) },
  }
}
`

describe('a signing cache plugin needs no core change', () => {
  it(
    'signed uploads hit; a forged or unsigned artifact is a miss and the task runs',
    async () => {
      const fx = await makeWorkspace('vx-signed-guide-')
      const prior = process.env['CACHE_SIGNING_KEY']
      try {
        await addProject(fx.root, 'app', { files: { 'src/in.txt': 'v1' }, config: CFG })
        const main = generateKeyPairSync('ed25519')
        const pub = main.publicKey.export({ format: 'pem', type: 'spki' }).toString()
        const priv = main.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
        const store = path.join(fx.root, '.bucket')
        await writeFile(path.join(fx.root, 'signed-cache.ts'), example())
        await writeFile(path.join(fx.root, 'dir-remote.mjs'), DIR_REMOTE)
        await Bun.write(
          path.join(fx.root, '.vx/workspace.ts'),
          `import { signedCache } from '../signed-cache.ts'
import dirRemote from '../dir-remote.mjs'
export default { plugins: [signedCache(dirRemote(${JSON.stringify(store)}), ${JSON.stringify(pub)})] }
`,
        )
        const out = path.join(fx.root, 'packages/app/out.txt')
        const go = async (key: string | undefined): Promise<string> => {
          if (key === undefined) delete process.env['CACHE_SIGNING_KEY']
          else process.env['CACHE_SIGNING_KEY'] = key
          await rm(path.join(fx.root, '.vx', 'cache'), { recursive: true, force: true })
          await rm(out, { force: true })
          const r = await run({ cwd: fx.root, tasks: ['build'], log: silentLogger(fx) })
          return r.outcomes[0]!.status
        }
        const signer = await go(priv)
        const files = (await readdir(store)).sort()
        const reader = await go(undefined)
        // Anyone who can write the bucket: another key's signature, then none.
        const [hash] = files.filter((f) => !f.endsWith('.sig'))
        const forger = generateKeyPairSync('ed25519').privateKey
        const { sign } = await import('node:crypto')
        const { createHash } = await import('node:crypto')
        const bytes = await readFile(path.join(store, hash!))
        const digest = createHash('sha256').update(bytes).digest('hex')
        await writeFile(
          path.join(store, `${hash}.sig`),
          sign(null, Buffer.from(`${hash}\0${digest}`), forger),
        )
        const forged = await go(undefined)
        await rm(path.join(store, `${hash}.sig`))
        const unsigned = await go(undefined)
        // A run without the signing key uploads nothing.
        await rm(store, { recursive: true, force: true })
        await mkdir(store)
        const noKey = await go(undefined)
        expect({
          signer,
          files: files.map((f) => (f.endsWith('.sig') ? 'sig' : 'artifact')),
          reader,
          forged,
          unsigned,
          noKey,
          uploaded: (await readdir(store)).length,
          out: existsSync(out) ? await readFile(out, 'utf8') : null,
        }).toEqual({
          signer: 'success',
          files: ['artifact', 'sig'],
          reader: 'cache-hit-remote',
          forged: 'success',
          unsigned: 'success',
          noKey: 'success',
          uploaded: 0,
          out: 'built\n',
        })
      } finally {
        if (prior === undefined) delete process.env['CACHE_SIGNING_KEY']
        else process.env['CACHE_SIGNING_KEY'] = prior
        await rm(fx.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
