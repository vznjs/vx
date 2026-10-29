// `assume` with a history server: the run orders twice (its local history,
// then the server's numbers), and a bad assumption is said once a run.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { Cache, type TaskNode } from '@vzn/vx'
import { NAMED } from './issuer.js'
import { vxHistory } from '../src/index.js'

let root: string
let srv: Bun.Server<undefined>
const saved = { ...Bun.env }

beforeAll(async () => {
  // No token: the run reads only, and asks no OIDC endpoint.
  for (const k of ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'])
    delete Bun.env[k]
  delete Bun.env.VX_HISTORY_TOKEN
  root = await mkdtemp(path.join(tmpdir(), 'vx-history-assume-'))
  srv = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      if (new URL(req.url).pathname === '/v1/capabilities')
        return Response.json({ maxUploadTimings: 100, maxQueryHashes: 100 })
      const { hashes } = (await req.json()) as { hashes: string[] }
      return Response.json({
        timings: Object.fromEntries(hashes.map((h) => [h, { durationMs: 500 }])),
      })
    },
  })
})

afterAll(async () => {
  await srv.stop(true)
  for (const k of Object.keys(Bun.env)) if (!(k in saved)) delete Bun.env[k]
  Object.assign(Bun.env, saved)
  await rm(root, { recursive: true, force: true })
})

it('a bad assumption is said once, when the server re-ranks the run too', async () => {
  const node = {
    id: 'a#build',
    projectName: 'a',
    projectDir: path.join(root, 'a'),
    taskName: 'build',
    config: { exec: { command: 'true' } },
    deps: [],
    requested: true,
  } as unknown as TaskNode
  const cache = new Cache(path.join(root, '.vx', 'cache'))
  const warned: string[] = []
  const refined: Promise<unknown>[] = []
  try {
    const plugin = vxHistory({
      url: srv.url.href.replace(/\/$/, ''),
      ...NAMED,
      assume: { 'b#build': Number(undefined) },
    })
    await plugin.schedule!(new Map([[node.id, node]]), {
      workspaceRoot: root,
      localCache: cache,
      branch: 'main',
      refs: ['refs/heads/main'],
      warn: (m: string) => warned.push(m),
      refine: (p: Promise<unknown>) => refined.push(p),
    } as never)
    const late = await Promise.all(refined)
    // The server's numbers did re-rank: the second ordering ran.
    expect(late).toEqual([expect.any(Map)])
    expect(warned.filter((m) => m.includes('assume'))).toEqual([
      '[vx] vx-history: assume ignores "b#build" — each must be a number of ms from 0 to 2^53',
    ])
  } finally {
    cache.close()
  }
})
