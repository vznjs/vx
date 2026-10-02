// A signed download is written to a temp and checked before core sees a
// byte. The temp sat in the shared temp dir, which a sandboxed task may
// read: a task in one project could read another project's outputs there
// while the tag was checked (L-45; the class of L-10). It lands in vx's
// cache directory, which the sandbox walls.
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { turboCache } from '../src/index.js'

const KEY = 'k'.repeat(32)
let release: () => void = () => {}
const stalled = new Promise<void>((r) => (release = r))
const srv = Bun.serve({
  port: 0,
  fetch() {
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(new Uint8Array(16))
        await stalled
        c.close()
      },
    })
    return new Response(body, { headers: { 'x-artifact-tag': 'bad' } })
  },
})
const dirs: string[] = []
afterAll(async () => {
  release()
  await srv.stop(true)
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

it('a signed download is checked in the cache directory, not the shared temp dir', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'vx-turbo-temp-'))
  dirs.push(cacheDir)
  const layer = turboCache({
    apiUrl: `http://127.0.0.1:${srv.port}`,
    token: 't',
    teamId: 'team_1',
    signatureKey: KEY,
  }).cache?.({
    localCache: {} as never,
    policy: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true },
    warn: () => {},
    workspaceRoot: cacheDir,
    cacheDir,
  } as never) as unknown as { remote: { get(h: string): Promise<unknown> } }
  const hash = 'ab'.repeat(8)
  const got = layer.remote.get(hash).catch(() => null)
  const ours = (names: string[]) => names.filter((n) => n.startsWith(`vx-turbo-${hash}-`))
  let inCache: string[] = []
  for (let i = 0; i < 200 && inCache.length === 0; i++) {
    inCache = ours(await readdir(cacheDir))
    if (inCache.length === 0) await Bun.sleep(10)
  }
  const inTmp = ours(await readdir(tmpdir()))
  release()
  await got
  expect({ inCache: inCache.length, inTmp }).toEqual({ inCache: 1, inTmp: [] })
})
