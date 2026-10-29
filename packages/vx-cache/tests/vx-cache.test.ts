// vxCache() against a real @vzn/vx-cache-server, in process: the layer's
// wire, and a vx run that uploads and later restores through it. Every
// request carries a CI token the server's issuer signed.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { hashPart, oidcAuth } from '@vzn/vx-devtools'
import { createCacheServer } from '@vzn/vx-cache-server'
import type { JWTPayload } from 'jose'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import {
  BRANCH_JOB,
  GITHUB,
  type Issuer,
  issuer,
  READ_JOB,
  REPO,
  ALLOW,
  MAIN_JOB,
} from '../../vx-cache-server/tests/issuer.js'
import { memBlobs } from '../../vx-cache-server/tests/mem-blobs.js'
import { hasCiToken, resolveVxCacheConfig, vxCache, VxCacheLayer } from '../src/index.js'

/** The repository the server's ALLOW names, as a workspace names it. */
const NAMED = { issuer: GITHUB, repository: 'Acme/App' }

let iss: Issuer
beforeAll(async () => {
  iss = await issuer()
})

/** The server over a Map bucket: what the wire sees is the server's own. */
function server(maxUploadBytes = 1 << 20, readAccess?: string, maxCheckHashes?: number) {
  const blobs = new Map<string, Uint8Array>()
  const seen: { method: string; path: string; body: string; scope: string | null }[] = []
  const handle = createCacheServer({
    blobs: memBlobs(blobs),
    authorize: oidcAuth({ allow: ALLOW, readAccess, fetchJson: (u) => iss.fetchJson(u) }),
    limits: { maxUploadBytes, ...(maxCheckHashes === undefined ? {} : { maxCheckHashes }) },
  })
  const srv = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      // The line alone: an upload's bytes follow it.
      const text = await req.clone().text()
      seen.push({
        method: req.method,
        path: new URL(req.url).pathname,
        body: text.split('\n')[0]!,
        scope: req.headers.get('vx-scope'),
      })
      return handle(req as never)
    },
  })
  const url = srv.url.href.replace(/\/$/, '')
  return {
    url,
    blobs,
    seen,
    token: (claims: JWTPayload) => iss.sign(claims, new URL(url).origin),
    stop: () => srv.stop(true),
  }
}

const MAIN = 'refs/heads/main'

/** Requests land in any order: sorted by what they say. */
const byJson = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b))
/** A check's hashes. */
const keysOf = (body: string) => (JSON.parse(body) as { hashes: string[] }).hashes

/** A layer whose job's token is `token`, as GitLab's `VX_CACHE_TOKEN` carries it, reading `refs`. */
function layer(url: string, token: string, refs: string[] = [MAIN], fetchImpl = fetch) {
  const c = new VxCacheLayer(
    {
      url,
      timeoutMs: 5_000,
      uploadTimeoutMs: 5_000,
      headers: {},
      issuer: GITHUB,
      repository: REPO,
    },
    fetchImpl,
    {
      VX_CACHE_TOKEN: token,
    },
  )
  c.refs = refs
  return c
}

describe('VxCacheLayer', () => {
  let srv: ReturnType<typeof server>
  let write = ''
  let read = ''
  beforeAll(async () => {
    srv = server(64)
    ;[write, read] = await Promise.all([srv.token(MAIN_JOB), srv.token(READ_JOB)])
  })
  afterAll(() => srv.stop())

  it("uploads, checks and downloads one artifact, asking each ref's exact key, hashed", async () => {
    const [f, main] = [await hashPart('refs/heads/f'), await hashPart(MAIN)]
    const c = layer(srv.url, write, ['refs/heads/f', MAIN])
    expect(await c.has('aa11')).toBeNull()
    await c.put('aa11', new Blob(['hello']), { durationMs: 1 })
    const before = srv.seen.length
    expect(await c.has('aa11')).toEqual({ size: 5 })
    // Turbo's batch query, every ref's scope in one, in order.
    expect(srv.seen.slice(before).map((r) => JSON.parse(r.body))).toEqual([
      { hashes: ['aa11'], scopes: [f, main] },
    ])
    expect(await c.hasMany(['aa11', 'bb22'])).toEqual(new Map([['aa11', { size: 5 }]]))
    // The download names the ref the check found it under.
    const got = await c.get('aa11')
    expect([await got!.body.text(), srv.seen.at(-1)!.scope]).toEqual(['hello', main])
    expect(await c.get('bb22')).toBeNull()
    expect(srv.seen.slice(-2).map((r) => r.scope)).toEqual([f, main])
    // No ref goes on the wire plain (2026-10-25).
    expect(srv.seen.filter((r) => `${r.body} ${r.scope}`.includes('refs/'))).toEqual([])
  })

  it('uploads an artifact held in a file whole', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'vx-cache-')), 'a.tar')
    await Bun.write(file, 'from a file')
    const c = layer(srv.url, write)
    await c.put('f11e', Bun.file(file), { durationMs: 1 })
    expect(await (await c.get('f11e'))!.body.text()).toBe('from a file')
  })

  it("asks the server's limits once, then checks in chunks of its maxCheckHashes", async () => {
    const before = srv.seen.length
    const keys = Array.from({ length: 1200 }, (_, i) => i.toString(16))
    const c = layer(srv.url, read)
    expect((await c.hasMany(keys)).size).toBe(0)
    await c.hasMany(['0'])
    const seen = srv.seen.slice(before)
    expect(seen.filter((r) => r.path === '/v1/capabilities')).toHaveLength(1)
    const sizes = seen.filter((r) => r.path === '/v1/artifacts').map((r) => keysOf(r.body).length)
    expect(sizes.sort((a, b) => b - a)).toEqual([500, 500, 200, 1])
  })

  it('uploads each artifact alone by PUT, at most four at once', async () => {
    let open = 0
    let most = 0
    const counted: typeof fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PUT') most = Math.max(most, ++open)
        try {
          return await fetch(input, init)
        } finally {
          if (init?.method === 'PUT') open--
        }
      },
      { preconnect: fetch.preconnect },
    )
    const c = layer(srv.url, write, [MAIN], counted)
    const before = srv.seen.length
    const keys = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']
    await Promise.all(keys.map((k) => c.put(k, new Blob([k]), { durationMs: 1 })))
    const seen = srv.seen.slice(before).filter((r) => r.path !== '/v1/capabilities')
    expect(seen.map((r) => [r.method, r.path]).sort(byJson)).toEqual(
      keys.map((k) => ['PUT', `/v1/artifacts/${k}`]),
    )
    expect(most).toBe(4)
    for (const k of keys) expect(await (await c.get(k))!.body.text()).toBe(k)
  })

  it('checks one hash at a time while the server names no limits, and says so once', async () => {
    const said: string[] = []
    // A server whose answers lose the limits.
    const stripped: typeof fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const res = await fetch(input, init)
        if (new URL(input instanceof Request ? input.url : input).pathname === '/v1/capabilities')
          return Response.json({})
        const headers = new Headers(res.headers)
        headers.delete('vx-max-check-hashes')
        return new Response(res.body, { status: res.status, headers })
      },
      { preconnect: fetch.preconnect },
    )
    const c = layer(srv.url, write, [MAIN], stripped)
    c.warn = (m) => said.push(m)
    const before = srv.seen.length
    await c.hasMany(['c1', 'c2', 'c3'])
    await c.hasMany(['c4', 'c5'])
    const checks = srv.seen.slice(before).filter((r) => r.path === '/v1/artifacts')
    expect(checks.map((r) => keysOf(r.body).length)).toEqual([1, 1, 1, 1, 1])
    expect(said).toEqual([
      '[vx] vx-cache: /v1/capabilities (HTTP 200) named no limits (maxCheckHashes, maxUploadBytes); checks go one hash at a time',
    ])
  })

  it("reads a server's endless answer no further than its cap", async () => {
    const pulled = { capabilities: 0, check: 0, refusal: 0 }
    const endless = (into: keyof typeof pulled, status = 200) =>
      new Response(
        new ReadableStream({
          pull(c) {
            pulled[into] += 64 * 1024
            c.enqueue(new Uint8Array(64 * 1024).fill(0x20))
          },
        }),
        { status },
      )
    const fake = (where: keyof typeof pulled, status?: number): typeof fetch =>
      Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const at = new URL(input instanceof Request ? input.url : input).pathname
          if (at === '/v1/capabilities' && where !== 'capabilities') return fetch(input, init)
          return endless(where, status)
        },
        { preconnect: fetch.preconnect },
      )
    expect(layer(srv.url, write, [MAIN], fake('capabilities')).hasMany(['e1'])).rejects.toThrow(
      '/v1/capabilities answered over 65536 bytes',
    )
    expect(layer(srv.url, write, [MAIN], fake('check')).hasMany(['e1'])).rejects.toThrow(
      '/v1/artifacts answered over',
    )
    expect(layer(srv.url, write, [MAIN], fake('refusal', 500)).get('e1')).rejects.toThrow(
      'HTTP 500',
    )
    await Bun.sleep(50)
    for (const n of Object.values(pulled)) expect(n).toBeLessThanOrEqual(256 * 1024)
  })

  it('says a job that reads only was refused a write once, and reads on', async () => {
    const c = layer(srv.url, read)
    expect(c.put('cc33', new Blob(['x']), { durationMs: 1 })).rejects.toThrow(
      'HTTP 403: this request reads only: the write was refused (this job reads only); writes off for this run, reads go on',
    )
    // Not sent, so core counts no upload.
    expect(await c.put('dd44', new Blob(['x']), { durationMs: 1 })).toBe(false)
    expect(await c.has('aa11')).not.toBeNull()
  })

  // #4439: git takes any UTF-8 in a branch name, a header only bytes; the
  // old header of every read ref refused the whole run's reads.
  it('reads and writes under a UTF-8 branch name', async () => {
    const ref = 'refs/heads/café-日本'
    const own = await srv.token({ ...BRANCH_JOB, ref })
    await layer(srv.url, own, [ref]).put('ee55', new Blob(['ü']), { durationMs: 1 })
    const checked = layer(srv.url, own, [ref, MAIN])
    expect(await checked.has('ee55')).not.toBeNull()
    expect(await (await checked.get('ee55'))!.body.text()).toBe('ü')
    // Unchecked, a download names each ref in turn.
    expect(await (await layer(srv.url, own, [ref]).get('ee55'))!.body.text()).toBe('ü')
  })

  it('says a refused token once, then asks nothing', async () => {
    const c = layer(srv.url, 'nope')
    await expect(c.get('aa11')).rejects.toThrow(
      ': the token was refused (this workspace names acme/app at https://token.actions.githubusercontent.com); remote cache off for this run',
    )
    const n = srv.seen.length
    expect(await c.has('aa11')).toBeNull()
    expect(await c.hasMany(['aa11'])).toEqual(new Map())
    expect(srv.seen.length).toBe(n)
  })

  it("sends no artifact over the server's limit, and says so", async () => {
    const c = layer(srv.url, write)
    const said: string[] = []
    c.warn = (m) => said.push(m)
    await c.hasMany(['0'])
    const before = srv.seen.length
    await c.put('b16', new Blob([new Uint8Array(65)]), { durationMs: 1 })
    expect(srv.seen.length).toBe(before)
    expect(said).toEqual([
      "[vx] vx-cache: b16 is 65 bytes, over the server's upload limit of 64: not uploaded",
    ])
  })

  it("names the server's own words when it refuses an upload", async () => {
    expect(
      layer(srv.url, write).put('ee55', new Blob([new Uint8Array(65)]), { durationMs: 1 }),
    ).rejects.toThrow('HTTP 413: an upload is at most 64 bytes')
  })
})

describe("the server's limits", () => {
  // Each check of one hash named every scope: a run reading more refs than
  // the server's maxCheckHashes sent more lookups than it takes, and every
  // check was refused.
  it('checks a run that reads more refs than one check takes, scopes in order', async () => {
    const srv = server(1 << 20, undefined, 2)
    try {
      const [write, read] = await Promise.all([srv.token(MAIN_JOB), srv.token(READ_JOB)])
      await layer(srv.url, write).put('ab12', new Blob(['held']), { durationMs: 1 })
      const refs = ['refs/heads/a', 'refs/heads/b', 'refs/heads/c', 'refs/heads/d', MAIN]
      const c = layer(srv.url, read, refs)
      const before = srv.seen.length
      expect(await c.hasMany(['ab12', 'cd34'])).toEqual(new Map([['ab12', { size: 4 }]]))
      const checks = srv.seen.slice(before).filter((r) => r.path === '/v1/artifacts')
      for (const r of checks) {
        const { hashes, scopes } = JSON.parse(r.body) as { hashes: string[]; scopes: string[] }
        expect(hashes.length * scopes.length).toBeLessThanOrEqual(2)
      }
      expect(await (await c.get('ab12'))!.body.text()).toBe('held')
      expect(srv.seen.at(-1)!.scope).toBe(await hashPart(MAIN))
    } finally {
      await srv.stop()
    }
  })

  // A server restarted with lower limits refused each check and upload for
  // its size, and the run kept the old ones: every check of the run failed.
  it('keeps to the limits a refusal names, from the next check and upload', async () => {
    const blobs = new Map<string, Uint8Array>()
    const made = (maxCheckHashes: number, maxUploadBytes: number) =>
      createCacheServer({
        blobs: memBlobs(blobs),
        authorize: oidcAuth({ allow: ALLOW, fetchJson: (u) => iss.fetchJson(u) }),
        limits: { maxCheckHashes, maxUploadBytes },
      })
    let handle = made(500, 1 << 20)
    const lookups: number[] = []
    const srv = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        if (new URL(req.url).pathname === '/v1/artifacts') {
          const { hashes, scopes } = (await req.clone().json()) as Record<string, string[]>
          lookups.push(hashes!.length * scopes!.length)
        }
        return handle(req as never)
      },
    })
    try {
      const url = srv.url.href.replace(/\/$/, '')
      const c = layer(url, await iss.sign(MAIN_JOB, new URL(url).origin))
      const said: string[] = []
      c.warn = (m) => said.push(m)
      const keys = ['a1', 'a2', 'a3']
      expect((await c.hasMany(keys)).size).toBe(0)
      handle = made(2, 1 << 20)
      await expect(c.hasMany(keys)).rejects.toThrow('HTTP 400')
      handle = made(2, 4)
      await expect(c.put('b1', new Blob(['12345']), { durationMs: 1 })).rejects.toThrow('HTTP 413')
      lookups.length = 0
      expect((await c.hasMany(keys)).size).toBe(0)
      expect(lookups.sort((a, b) => a - b)).toEqual([1, 2])
      expect(await c.put('b2', new Blob(['12345']), { durationMs: 1 })).toBe(false)
      expect(said).toEqual([
        "[vx] vx-cache: b2 is 5 bytes, over the server's upload limit of 4: not uploaded",
      ])
    } finally {
      await srv.stop(true)
    }
  })
})

describe('download deadline', () => {
  /** A server sending `chunks` bytes `gapMs` apart, then going quiet when `stallAfter` were sent. */
  function slow(chunks: number, gapMs: number, stallAfter = Infinity) {
    return Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => {
        let sent = 0
        return new Response(
          new ReadableStream({
            async pull(out) {
              if (sent === stallAfter) return new Promise<void>(() => {})
              await Bun.sleep(gapMs)
              out.enqueue(new Uint8Array([97]))
              if (++sent === chunks) out.close()
            },
          }),
        )
      },
    })
  }
  const slowLayer = (url: string) => {
    const c = new VxCacheLayer(
      { url, timeoutMs: 200, uploadTimeoutMs: 200, headers: {}, issuer: GITHUB, repository: REPO },
      fetch,
      { VX_CACHE_TOKEN: 't' },
    )
    c.refs = [MAIN]
    return c
  }

  it('lets a body arriving at a steady pace outlast the deadline', async () => {
    const s = slow(8, 60)
    try {
      const got = await slowLayer(s.url.href.replace(/\/$/, '')).get('aa')
      expect(await got!.body.text()).toBe('a'.repeat(8))
    } finally {
      await s.stop(true)
    }
  })

  it('ends a body that stops arriving', async () => {
    const s = slow(8, 20, 2)
    try {
      const got = await slowLayer(s.url.href.replace(/\/$/, '')).get('aa')
      expect(got!.body.text()).rejects.toThrow('no bytes for 200 ms')
    } finally {
      await s.stop(true)
    }
  })
})

describe('GitHub OIDC', () => {
  it("asks the job's token for the server's origin, and its branch's writes land there", async () => {
    const srv = server()
    const asked: string[] = []
    const github = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const audience = new URL(req.url).searchParams.get('audience')!
        asked.push(`${req.headers.get('authorization')} ${audience}`)
        return Response.json({ value: await iss.sign(BRANCH_JOB, audience) })
      },
    })
    try {
      const env = {
        ACTIONS_ID_TOKEN_REQUEST_URL: github.url.href,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gh',
      }
      const c = new VxCacheLayer(resolveVxCacheConfig({ ...NAMED, url: srv.url }, env)!, fetch, env)
      await c.put('f1', new Blob(['x']), { durationMs: 1 })
      await c.put('f2', new Blob(['y']), { durationMs: 1 })
      expect(asked).toEqual([`bearer gh ${new URL(srv.url).origin}`])
      const reader = await srv.token(READ_JOB)
      expect(await layer(srv.url, reader).has('f1')).toBeNull()
      expect(await layer(srv.url, reader, ['refs/heads/feature']).has('f1')).toEqual({ size: 1 })
    } finally {
      await srv.stop()
      await github.stop(true)
    }
  })

  // Each request the run starts at once asked GitHub for its own token: the
  // limits, the first checks and four uploads were six asks (2026-10-26).
  it('asks GitHub once for requests that need a token at the same time', async () => {
    const srv = server()
    let asked = 0
    const github = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        asked++
        const audience = new URL(req.url).searchParams.get('audience')!
        return Response.json({ value: await iss.sign(BRANCH_JOB, audience) })
      },
    })
    try {
      const env = {
        ACTIONS_ID_TOKEN_REQUEST_URL: github.url.href,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gh',
      }
      const c = new VxCacheLayer(resolveVxCacheConfig({ ...NAMED, url: srv.url }, env)!, fetch, env)
      c.refs = ['refs/heads/feature']
      c.start()
      await Promise.all([
        c.has('a1'),
        c.put('a2', new Blob(['x']), { durationMs: 1 }),
        c.put('a3', new Blob(['y']), { durationMs: 1 }),
      ])
      expect(asked).toBe(1)
    } finally {
      await srv.stop()
      await github.stop(true)
    }
  })

  // A DTE run asks GitHub again every few minutes, for itself and the
  // token it lends: one 503 among those asks turned the remote cache off
  // for the rest of the run, on every worker.
  it('asks GitHub again after a 5xx or a 429, and gives up on a refusal', async () => {
    const srv = server()
    const answers = [503, 429, 200]
    let asked = 0
    const github = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        asked++
        const status = answers.shift() ?? 403
        // GitHub says why it refuses; the warning carries its words.
        if (status === 403) return Response.json({ message: 'no id-token permission' }, { status })
        if (status !== 200) return new Response('busy', { status })
        const audience = new URL(req.url).searchParams.get('audience')!
        return Response.json({ value: await iss.sign(BRANCH_JOB, audience) })
      },
    })
    try {
      const env = {
        ACTIONS_ID_TOKEN_REQUEST_URL: github.url.href,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gh',
      }
      const c = new VxCacheLayer(
        resolveVxCacheConfig({ ...NAMED, url: srv.url }, env)!,
        fetch,
        env,
        async () => {},
      )
      await c.put('b1', new Blob(['x']), { durationMs: 1 })
      expect(asked).toBe(3)
      const refused = new VxCacheLayer(
        resolveVxCacheConfig({ ...NAMED, url: srv.url }, env)!,
        fetch,
        env,
        async () => {},
      )
      await expect(refused.put('b2', new Blob(['y']), { durationMs: 1 })).rejects.toThrow(
        "GitHub's OIDC endpoint: HTTP 403: no id-token permission; remote cache off for this run",
      )
      expect(asked).toBe(4)
    } finally {
      await srv.stop()
      await github.stop(true)
    }
  })
})

describe('lend', () => {
  it("lends the run's token to another job, whose writes land where the run reads", async () => {
    const srv = server()
    let lifetime = '10m'
    const asked: string[] = []
    // The run's job is a push to main; the other job's a dispatch on main.
    const claims: Record<string, JWTPayload> = { run: MAIN_JOB, other: READ_JOB }
    const github = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const job = req.headers.get('authorization')!.slice('bearer '.length)
        asked.push(job)
        const aud = new URL(req.url).searchParams.get('audience')!
        return Response.json({ value: await iss.sign(claims[job]!, aud, lifetime) })
      },
    })
    const envOf = (job: string) => ({
      ACTIONS_ID_TOKEN_REQUEST_URL: github.url.href,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: job,
    })
    const on = (job: string) =>
      new VxCacheLayer(
        resolveVxCacheConfig({ ...NAMED, url: srv.url }, envOf(job))!,
        fetch,
        envOf(job),
      )
    try {
      const run = on('run')
      const lent = await run.lend()
      expect(lent?.token.split('.')).toHaveLength(3)
      expect(lent!.expiresAt! - Date.now()).toBeGreaterThan(4 * 60_000)

      // Its own token reads only: a pull_request_target job writes nothing.
      await expect(on('other').put('a1', new Blob(['x']), { durationMs: 1 })).rejects.toThrow(
        'writes off for this run',
      )
      const other = on('other')
      other.lent = () => lent!.token
      await other.put('a2', new Blob(['y']), { durationMs: 1 })
      expect(await layer(srv.url, await srv.token(READ_JOB)).has('a2')).toEqual({ size: 1 })
      expect(await other.lend()).toBeUndefined()

      // GitHub's own lifetime: lent with its real end, so the run lends
      // again minutes later, not at once.
      lifetime = '5m'
      expect((await on('run').lend())!.expiresAt! - Date.now()).toBeGreaterThan(4 * 60_000)

      // A token ending within five minutes is asked again before it is lent.
      lifetime = '4m'
      const short = on('run')
      await short.lend()
      await short.lend()
      expect(asked.filter((j) => j === 'run')).toHaveLength(4)
    } finally {
      await srv.stop()
      await github.stop(true)
    }
  })
})

// Core lends while its remote reads, and the layer turns itself off: a
// refused token was lent to every worker, each of which said the refusal
// again, and a failed OIDC ask was asked again at each lend.
it('lends nothing once the remote is off', async () => {
  const srv = server()
  let asked = 0
  const github = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => {
      asked++
      return new Response('no', { status: 403 })
    },
  })
  try {
    const refused = layer(srv.url, 'nope')
    await expect(refused.has('aa11')).rejects.toThrow('remote cache off for this run')
    expect(await refused.lend()).toBeUndefined()

    const env = {
      ACTIONS_ID_TOKEN_REQUEST_URL: github.url.href,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gh',
    }
    const c = new VxCacheLayer(resolveVxCacheConfig({ ...NAMED, url: srv.url }, env)!, fetch, env)
    c.refs = [MAIN]
    await expect(c.has('aa11')).rejects.toThrow("GitHub's OIDC endpoint: HTTP 403")
    expect(await c.lend()).toBeUndefined()
    expect(asked).toBe(1)
  } finally {
    await srv.stop()
    await github.stop(true)
  }
})

describe('config', () => {
  // 2026-10-25: a proxy in front of the server (an Access service token).
  it('sends its headers on every request to the server, never over the CI token', async () => {
    const seen: Headers[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers))
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    const config = resolveVxCacheConfig(
      {
        ...NAMED,
        url: 'https://c.example',
        headers: { 'CF-Access-Client-Id': 'id', 'X-Unset': undefined },
      },
      {},
    )!
    expect(config.headers).toEqual({ 'CF-Access-Client-Id': 'id' })
    const c = new VxCacheLayer(config, fetchImpl, { VX_CACHE_TOKEN: 'jwt' })
    c.refs = [MAIN]
    await c.has('0123456789abcdef').catch(() => {})
    expect(seen.length).toBeGreaterThan(0)
    for (const h of seen)
      expect([
        h.get('cf-access-client-id'),
        h.get('authorization'),
        h.get('vx-issuer'),
        h.get('vx-repository'),
      ]).toEqual(['id', 'Bearer jwt', await hashPart(GITHUB), await hashPart(REPO)])
    // Refused at the call, with no url named: in the hook a laptop passed
    // what failed the first CI run. A value is never printed. A name the
    // wire sets, in any case, joined its value ("x, application/json"):
    // every request was a 400.
    for (const name of [
      'authorization',
      'a b',
      'Content-Type',
      'Content-Length',
      'VX-Issuer',
      'vx-repository',
      'Vx-Scope',
    ])
      expect(() => vxCache({ ...NAMED, headers: { [name]: 'x' } })).toThrow(
        `vxCache() option "headers" cannot set "${name}"`,
      )
    expect(() => vxCache({ ...NAMED, headers: { a: 'x\ny' } })).toThrow(
      'vxCache() option "headers.a" must be one line of text (its value is not printed)',
    )
  })

  it('reads the URL over VX_CACHE_URL, and a CI token from GitHub, GitLab or a lending run', () => {
    expect(resolveVxCacheConfig(NAMED, {})).toBeUndefined()
    expect(resolveVxCacheConfig(NAMED, { VX_CACHE_URL: 'https://c.example/' })).toEqual({
      url: 'https://c.example',
      issuer: GITHUB,
      repository: REPO,
      timeoutMs: 30_000,
      uploadTimeoutMs: 60_000,
      headers: {},
    })
    expect(() => resolveVxCacheConfig({ ...NAMED, url: 'c.example' }, {})).toThrow(
      'vxCache(): url must be http(s), got c.example',
    )
    expect(() => resolveVxCacheConfig({ ...NAMED, url: 'https://c.example/v1' }, {})).toThrow(
      "vxCache(): url is the server's base, without /v1: https://c.example",
    )
    expect(hasCiToken({}, false)).toBe(false)
    expect(hasCiToken({}, true)).toBe(true)
    expect(hasCiToken({ VX_CACHE_TOKEN: 'jwt' }, false)).toBe(true)
    const gh = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://gh', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'b' }
    expect(hasCiToken(gh, false)).toBe(true)
  })

  // 2026-10-25: the user names both, always; nothing guesses them.
  it('refuses a workspace that names no issuer or repository', () => {
    for (const [options, said] of [
      [{ repository: 'acme/app' }, "vxCache(): issuer must be the CI issuer's URL"],
      [{ issuer: 'token.actions.githubusercontent.com', repository: 'acme/app' }, 'issuer must be'],
      [{ issuer: GITHUB }, 'vxCache(): repository must be org/name, got undefined'],
      [{ issuer: GITHUB, repository: 'app' }, 'vxCache(): repository must be org/name, got app'],
    ] as const)
      expect(() => vxCache(options as never)).toThrow(said)
  })

  // A NaN, zero or negative deadline armed its abort at once: every request
  // failed "no answer within NaN ms" and the cache read as a miss each time.
  it('refuses a deadline it cannot wait on, naming the value', () => {
    for (const [options, said] of [
      [
        { timeoutMs: Number.NaN },
        'vxCache() option "timeoutMs" must be a positive number of ms, got NaN',
      ],
      [{ timeoutMs: 0 }, 'vxCache() option "timeoutMs" must be a positive number of ms, got 0'],
      [
        { uploadTimeoutMs: -1 },
        'vxCache() option "uploadTimeoutMs" must be a positive number of ms, got -1',
      ],
    ] as const)
      expect(() => vxCache({ ...NAMED, ...options })).toThrow(said)
    expect(() => vxCache({ ...NAMED, timeoutMs: 1000, uploadTimeoutMs: 2000 })).not.toThrow()
  })

  it('reads with no token from a public server, sends none, and uploads nothing', async () => {
    const srv = server(1 << 20, 'public')
    try {
      const writer = layer(srv.url, await srv.token(MAIN_JOB))
      await writer.put('ab12', new Blob(['x']), { durationMs: 1 })
      const c = new VxCacheLayer(resolveVxCacheConfig({ ...NAMED, url: srv.url }, {})!, fetch, {})
      c.refs = [MAIN]
      expect(await c.has('ab12')).toEqual({ size: 1 })
      expect(await c.put('cd34', new Blob(['y']), { durationMs: 1 })).toBe(false)
      expect(srv.seen.filter((r) => r.method === 'PUT').map((r) => r.path)).toEqual([
        '/v1/artifacts/ab12',
      ])
    } finally {
      await srv.stop()
    }
  })

  it('says a CI job with no token reads only, on GitLab as on GitHub', async () => {
    const saved = { ...Bun.env }
    const names = ['GITHUB_ACTIONS', 'GITLAB_CI', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'VX_CACHE_TOKEN']
    for (const k of names) delete Bun.env[k]
    const warned: string[] = []
    const srv = server(64)
    try {
      const plugin = vxCache({ ...NAMED, url: srv.url })
      for (const ci of ['GITHUB_ACTIONS', 'GITLAB_CI']) {
        Bun.env[ci] = 'true'
        void plugin.cache?.({ refs: [MAIN], warn: (m: string) => warned.push(m) } as never)
        delete Bun.env[ci]
      }
    } finally {
      for (const k of names) if (saved[k] !== undefined) Bun.env[k] = saved[k]
      await srv.stop()
    }
    expect(warned).toEqual([
      '[vx] vx-cache: this job gets no OIDC token (give it `permissions: id-token: write`): it reads only',
      '[vx] vx-cache: no CI token for the cache server (name an id_tokens entry VX_CACHE_TOKEN): it reads only',
    ])
  })

  // Core opens a remote only when the run's policy reads or writes it: the
  // factory asked the limits (and GitHub for a token) on a --no-cache run.
  it('asks the server nothing until core opens it', async () => {
    const saved = { ...Bun.env }
    const names = [
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'VX_CACHE_TOKEN',
    ]
    for (const k of names) delete Bun.env[k]
    const srv = server(1 << 20, 'public')
    try {
      const plugin = vxCache({ ...NAMED, url: srv.url })
      const layer = await plugin.cache!({ refs: [MAIN], warn: () => {} } as never)
      await Bun.sleep(50)
      expect(srv.seen).toEqual([])
      await layer!.open!({ ci: false, warn: () => {} } as never)
      await Bun.sleep(50)
      expect(srv.seen.map((r) => r.path)).toEqual(['/v1/capabilities'])
    } finally {
      for (const k of names) if (saved[k] !== undefined) Bun.env[k] = saved[k]
      await srv.stop()
    }
  })

  // The second failed ask of the limits was kept: every later check threw
  // it, though the server was back (2026-10-26).
  it('asks the limits again after each failed ask, and reads once the server is back', async () => {
    const srv = server()
    try {
      let down = 2
      const flaky: typeof fetch = Object.assign(
        (input: string | URL | Request, init?: RequestInit) =>
          (input instanceof Request ? input.url : input.toString()).endsWith('/v1/capabilities') &&
          down-- > 0
            ? Promise.resolve(new Response('restarting', { status: 503 }))
            : fetch(input, init),
        { preconnect: fetch.preconnect },
      )
      const token = await srv.token(MAIN_JOB)
      await layer(srv.url, token).put('ab13', new Blob(['x']), { durationMs: 1 })
      const c = layer(srv.url, token, [MAIN], flaky)
      c.start()
      await Bun.sleep(50)
      await expect(c.has('ab13')).rejects.toThrow('HTTP 503: restarting')
      expect(await c.has('ab13')).toEqual({ size: 1 })
    } finally {
      await srv.stop()
    }
  })

  // A URL of a website answers any path 200 with its page: JSON.parse's
  // "Unrecognized token '<'" named no fault.
  it('says a 200 that is no JSON is not a vx-cache server', async () => {
    const site = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
    })
    try {
      const c = new VxCacheLayer(
        resolveVxCacheConfig({ ...NAMED, url: site.url.origin }, {})!,
        fetch,
        {},
      )
      c.refs = [MAIN]
      await expect(c.has('ab14')).rejects.toThrow(
        new Error(
          '/v1/capabilities answered 200 with text/html, not JSON: is the url a vx-cache server?',
        ),
      )
    } finally {
      await site.stop(true)
    }
  })

  // A server's words reach the terminal: an ESC in them retitled it and
  // overwrote the line vx printed before them.
  it("writes the controls in a server's words as escapes", async () => {
    const said = JSON.stringify({ message: '\x1b]0;PWNED\x07\x1b[2K\rall good' })
    const c = layer(
      'https://cache.test',
      't',
      [MAIN],
      Object.assign(() => Promise.resolve(new Response(said, { status: 500 })), {
        preconnect: fetch.preconnect,
      }),
    )
    await expect(c.has('ab14')).rejects.toThrow('HTTP 500: \\x1b]0;PWNED\\x07\\x1b[2K all good')
  })

  // The layer asks for the limits as it starts, before any check: a
  // refusal there turned the remote off and was never said.
  it('says a refusal met while it starts, at the first check', async () => {
    const srv = server()
    try {
      const c = new VxCacheLayer(resolveVxCacheConfig({ ...NAMED, url: srv.url }, {})!, fetch, {})
      c.refs = [MAIN]
      c.start()
      await Bun.sleep(100)
      await expect(c.has('ab12')).rejects.toThrow(
        'HTTP 401: no bearer token: a read with no token was refused; remote cache off for this run',
      )
      expect(await c.has('ab12')).toBeNull()
    } finally {
      await srv.stop()
    }
  })

  // A check that started while the start's ask was still out shared its
  // refusal, threw it, and the next check threw it again.
  it('says a refusal met while it starts once, though a check waited on the same ask', async () => {
    const srv = server()
    try {
      const c = new VxCacheLayer(resolveVxCacheConfig({ ...NAMED, url: srv.url }, {})!, fetch, {})
      c.refs = [MAIN]
      c.start()
      const said: string[] = []
      for (let i = 0; i < 3; i++)
        await c.has('ab12').catch((err: Error) => {
          said.push(err.message)
        })
      expect(said).toEqual([
        'HTTP 401: no bearer token: a read with no token was refused; remote cache off for this run',
      ])
    } finally {
      await srv.stop()
    }
  })

  it('says once that a server refuses a read with no token, then asks nothing', async () => {
    const srv = server()
    try {
      const c = new VxCacheLayer(resolveVxCacheConfig({ ...NAMED, url: srv.url }, {})!, fetch, {})
      c.refs = [MAIN]
      await expect(c.has('ab12')).rejects.toThrow(
        'HTTP 401: no bearer token: a read with no token was refused; remote cache off for this run',
      )
      const asked = srv.seen.length
      expect(await c.has('ab12')).toBeNull()
      expect(srv.seen.length).toBe(asked)
    } finally {
      await srv.stop()
    }
  })
})

describe('vx run with vxCache()', () => {
  let srv: ReturnType<typeof server>
  let root: string
  const saved = { ...Bun.env }
  beforeAll(async () => {
    srv = server()
    // This job's CI token, whatever CI runs these tests.
    delete Bun.env.ACTIONS_ID_TOKEN_REQUEST_URL
    delete Bun.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    Bun.env.VX_CACHE_TOKEN = await srv.token(MAIN_JOB)
    root = await mkdtemp(path.join(tmpdir(), 'vx-cache-'))
    await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
    await writeFile(path.join(root, 'pkg', 'src', 'app.js'), 'console.log("app")\n')
    await writeFile(
      path.join(root, 'pkg', 'vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'mkdir -p dist && cp src/app.js dist/app.js' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } } } } }\n",
    )
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      `import { vxCache } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'index.ts'))}\n` +
        `export default { plugins: [vxCache({ url: ${JSON.stringify(srv.url)}, issuer: ${JSON.stringify(GITHUB)}, repository: ${JSON.stringify(REPO)} })] }\n`,
    )
    // A branch with a commit: the run reads refs/heads/main.
    Bun.spawnSync({ cmd: ['git', 'init', '-q', '-b', 'main'], cwd: root })
    Bun.spawnSync({
      cmd: [
        'git',
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      cwd: root,
    })
  })
  afterAll(async () => {
    for (const k of Object.keys(Bun.env)) if (!(k in saved)) delete Bun.env[k]
    Object.assign(Bun.env, saved)
    await srv.stop()
    await rm(root, { recursive: true, force: true })
  })

  it('a miss uploads; with the local cache wiped the next run restores', async () => {
    // The cache named, so no machine-wide store under HOME survives the wipe
    // below and answers the second run itself.
    const cacheDir = path.join(root, '.vx', 'cache')
    const first = await run({ cwd: root, tasks: ['build'], handleSignals: false, cacheDir })
    expect(first.outcomes.map((o) => o.status)).toEqual(['success'])
    expect(srv.blobs.size).toBe(1)
    await rm(cacheDir, { recursive: true, force: true })
    await rm(path.join(root, 'pkg', 'dist'), { recursive: true, force: true })
    const before = srv.seen.length
    const second = await run({ cwd: root, tasks: ['build'], handleSignals: false, cacheDir })
    expect(second.outcomes.map((o) => o.status)).toEqual(['cache-hit-remote'])
    expect(await Bun.file(path.join(root, 'pkg', 'dist', 'app.js')).text()).toBe(
      'console.log("app")\n',
    )
    expect(srv.seen.slice(before).filter((r) => r.method === 'PUT')).toEqual([])
  })
})
