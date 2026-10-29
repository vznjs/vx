// `github()`: the workers one demand starts are one `workflow_dispatch` per
// size, naming the run, the relay, the commit and the workers; a refused
// dispatch says so for each worker.

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { WorkerSpawn } from '../src/index.js'
import { github as make } from '../src/index.js'

const saved = { ...process.env }
/** Each test's adapters: one left open watches its jobs past the test (CI, 2026-10-23). */
const adapters: ReturnType<typeof make>[] = []
const github = (...args: Parameters<typeof make>): ReturnType<typeof make> => {
  const a = make(...args)
  adapters.push(a)
  return a
}
// The job these tests run in has its own run: a dispatch names it.
beforeEach(() => {
  delete process.env['GITHUB_RUN_ID']
  delete process.env['GITHUB_RUN_ATTEMPT']
})
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.close?.()))
  process.env = { ...saved }
})

function spawn(id: string, size: string, exited: (why: string) => void = () => {}): WorkerSpawn {
  return { id, size, run: 'r1', relay: 'https://relay.test', exited } as WorkerSpawn
}

it('dispatches one workflow run per size for the workers one demand starts', async () => {
  const calls: { path: string; auth: string | null; body: unknown }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      calls.push({
        path: new URL(req.url).pathname,
        auth: req.headers.get('authorization'),
        body: await req.json(),
      })
      return new Response(null, { status: 204 })
    },
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
    GITHUB_REF_NAME: 'main',
    GITHUB_SHA: 'abc123',
  })
  delete process.env['GITHUB_HEAD_REF']
  try {
    const adapter = github()
    expect(adapter.keyless).toBe(true)
    void adapter.spawn(spawn('small#1', 'small'))
    void adapter.spawn(spawn('small#2', 'small'))
    void adapter.spawn(spawn('big#3', 'big'))
    await Bun.sleep(100)
    const inputs = (size: string, workers: string[]) => ({
      ref: 'main',
      inputs: {
        run: 'r1',
        relay: 'https://relay.test',
        sha: 'abc123',
        size,
        workers: JSON.stringify(workers),
      },
    })
    expect(calls).toEqual([
      {
        path: '/repos/o/r/actions/workflows/vx-worker.yml/dispatches',
        auth: 'Bearer ght',
        body: inputs('small', ['small#1', 'small#2']),
      },
      {
        path: '/repos/o/r/actions/workflows/vx-worker.yml/dispatches',
        auth: 'Bearer ght',
        body: inputs('big', ['big#3']),
      },
    ])
  } finally {
    await server.stop(true)
  }
})

it('hands its workers the variables env names, as the env input', async () => {
  const bodies: { inputs: Record<string, string> }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      bodies.push((await req.json()) as { inputs: Record<string, string> })
      return new Response(null, { status: 204 })
    },
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
    GITHUB_REF_NAME: 'main',
    GITHUB_SHA: 'abc123',
  })
  try {
    void github({ env: { VX_CACHE_URL: 'https://preview.test', UNSET: undefined } }).spawn(
      spawn('small#1', 'small'),
    )
    await Bun.sleep(100)
    expect(bodies[0]!.inputs['env']).toBe('{"VX_CACHE_URL":"https://preview.test"}')
  } finally {
    await server.stop(true)
  }
  // A value of two lines would write a second variable.
  expect(() => github({ env: { VX_CACHE_URL: 'a\nNODE_OPTIONS=x' } })).toThrow(
    `github(): env "VX_CACHE_URL": a variable's name, and a string of one line`,
  )
  expect(() => github({ env: { 'A-B': 'x' } })).toThrow('github(): env "A-B"')
})

it('says why for each worker of a dispatch GitHub refused', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('nope', { status: 403 }),
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
  })
  try {
    const why: string[] = []
    const adapter = github({ workflow: 'workers.yml' })
    void adapter.spawn(spawn('small#1', 'small', (w) => why.push(`small#1: ${w}`)))
    void adapter.spawn(spawn('small#2', 'small', (w) => why.push(`small#2: ${w}`)))
    await Bun.sleep(100)
    expect(why).toEqual([
      'small#1: github(): dispatching workers.yml: 403 nope: the job needs `permissions: actions: write` to start workers',
      'small#2: github(): dispatching workers.yml: 403 nope: the job needs `permissions: actions: write` to start workers',
    ])
  } finally {
    await server.stop(true)
  }
})

it('says the workflow is not on the branch when GitHub answers 404', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => Response.json({ message: 'Not Found' }, { status: 404 }),
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
    GITHUB_REF_NAME: 'feat',
  })
  try {
    const why: string[] = []
    void github().spawn(spawn('small#1', 'small', (w) => why.push(w)))
    await Bun.sleep(100)
    expect(why).toEqual([
      'github(): dispatching vx-worker.yml: 404 {"message":"Not Found"}: .github/workflows/vx-worker.yml is not on feat (vx dte init writes it; commit and push it)',
    ])
  } finally {
    await server.stop(true)
  }
})

it('cancels the workflow runs it dispatched when the run closes', async () => {
  const calls: string[] = []
  let id = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      calls.push(`${req.method} ${path} ${req.headers.get('x-github-api-version')}`)
      if (path.endsWith('/dispatches'))
        return Response.json({ workflow_run_id: ++id, run_url: '', html_url: '' })
      return new Response(null, { status: 202 })
    },
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
  })
  try {
    const adapter = github()
    void adapter.spawn(spawn('small#1', 'small'))
    void adapter.spawn(spawn('mac#2', 'mac'))
    await adapter.close?.()
    expect(calls.toSorted()).toEqual([
      'POST /repos/o/r/actions/runs/1/cancel 2026-03-10',
      'POST /repos/o/r/actions/runs/2/cancel 2026-03-10',
      'POST /repos/o/r/actions/workflows/vx-worker.yml/dispatches 2026-03-10',
      'POST /repos/o/r/actions/workflows/vx-worker.yml/dispatches 2026-03-10',
    ])
  } finally {
    await server.stop(true)
  }
})

// 2026-10-23: workers joined only to be let go; one not needed is
// stopped before its setup, when its run holds no worker still needed.
it('cancels a dispatched run once every worker in it is not needed', async () => {
  const calls: string[] = []
  let id = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      calls.push(`${req.method} ${path}`)
      if (path.endsWith('/dispatches')) return Response.json({ workflow_run_id: ++id })
      return new Response(null, { status: 202 })
    },
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
  })
  try {
    const adapter = github()
    void adapter.spawn(spawn('small#1', 'small'))
    void adapter.spawn(spawn('small#2', 'small'))
    await Bun.sleep(50)
    void adapter.spawn(spawn('mac#3', 'mac'))
    await Bun.sleep(50)
    // small#2 shares its run with small#1, still needed: that run goes on.
    adapter.cancel?.(['small#2', 'mac#3'])
    await Bun.sleep(50)
    expect(calls.filter((c) => c.endsWith('/cancel'))).toEqual([
      'POST /repos/o/r/actions/runs/2/cancel',
    ])
    adapter.cancel?.(['small#1'])
    await adapter.close?.()
    expect(calls.filter((c) => c.endsWith('/cancel'))).toEqual([
      'POST /repos/o/r/actions/runs/2/cancel',
      'POST /repos/o/r/actions/runs/1/cancel',
    ])
  } finally {
    await server.stop(true)
  }
})

// A worker let go while its dispatch was in flight: its run was never
// cancelled until the run closed, holding a runner it would never use.
it('cancels a run whose workers were all let go while it was dispatched', async () => {
  const calls: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname
      calls.push(`${req.method} ${path}`)
      if (path.endsWith('/dispatches')) {
        await Bun.sleep(150)
        return Response.json({ workflow_run_id: 4 })
      }
      return new Response(null, { status: 202 })
    },
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
  })
  try {
    const adapter = github()
    void adapter.spawn(spawn('small#1', 'small'))
    await Bun.sleep(30)
    adapter.cancel?.(['small#1'])
    for (let i = 0; i < 50 && !calls.some((c) => c.endsWith('/cancel')); i++) await Bun.sleep(20)
    expect(calls).toEqual([
      'POST /repos/o/r/actions/workflows/vx-worker.yml/dispatches',
      'POST /repos/o/r/actions/runs/4/cancel',
    ])
  } finally {
    await server.stop(true)
  }
})

// A killed orchestrator never closes: the job's `if: cancelled()` step cancels
// what this file lists, or the queued workers hold macOS runners.
it('lists each run it dispatched in RUNNER_TEMP for the job to cancel', async () => {
  let id = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => Response.json({ workflow_run_id: ++id, run_url: '', html_url: '' }),
  })
  const temp = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-gh-'))
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
    RUNNER_TEMP: temp,
  })
  try {
    const adapter = github()
    void adapter.spawn(spawn('small#1', 'small'))
    void adapter.spawn(spawn('mac#2', 'mac'))
    const file = path.join(temp, 'vx-dte-runs')
    let lines: string[] = []
    for (let i = 0; i < 100 && lines.length < 2; i++) {
      await Bun.sleep(10)
      lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []
    }
    expect(lines.toSorted()).toEqual(['/repos/o/r/actions/runs/1', '/repos/o/r/actions/runs/2'])
  } finally {
    await server.stop(true)
    await rm(temp, { recursive: true, force: true })
  }
})

// A job that failed at its install told the run nothing: its worker stayed
// `starting` and the run waited for the job's timeout (2026-10-22).
it('says why for each worker whose job ended, a success too', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path.endsWith('/dispatches')) return Response.json({ workflow_run_id: 7 })
      if (path === '/repos/o/r/actions/runs/7/jobs')
        return Response.json({
          jobs: [
            {
              name: 'small#1',
              status: 'completed',
              conclusion: 'failure',
              steps: [
                { name: 'Set up job', conclusion: 'success' },
                { name: 'Install dependencies', conclusion: 'failure' },
              ],
            },
            { name: 'small#2', status: 'in_progress', conclusion: null },
            // Found no live run and left: the run must not wait on it.
            { name: 'small#3', status: 'completed', conclusion: 'success', steps: [] },
          ],
        })
      return new Response(null, { status: 202 })
    },
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
  })
  try {
    const why: string[] = []
    const adapter = github()
    void adapter.spawn(spawn('small#1', 'small', (w) => why.push(`small#1: ${w}`)))
    void adapter.spawn(spawn('small#2', 'small', (w) => why.push(`small#2: ${w}`)))
    void adapter.spawn(spawn('small#3', 'small', (w) => why.push(`small#3: ${w}`)))
    for (let i = 0; i < 50 && why.length < 2; i++) await Bun.sleep(100)
    expect(why.sort()).toEqual([
      'small#1: job failure at Install dependencies',
      'small#3: job success',
    ])
    await adapter.close?.()
  } finally {
    await server.stop(true)
  }
}, 10_000)

it("dispatches on the base branch once a merged PR's branch is gone", async () => {
  // Before: a PR merged mid-run, its branch was deleted, GitHub answered
  // 422 "No ref found" and every worker of the dispatch failed (2026-10-22).
  const refs: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const { ref } = (await req.json()) as { ref: string }
      refs.push(ref)
      if (ref === 'feature')
        return Response.json({ message: 'No ref found for: feature' }, { status: 422 })
      return new Response(null, { status: 204 })
    },
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
    GITHUB_HEAD_REF: 'feature',
    GITHUB_BASE_REF: 'main',
  })
  try {
    const why: string[] = []
    void github().spawn(spawn('small#1', 'small', (w) => why.push(w)))
    await Bun.sleep(100)
    expect([refs, why]).toEqual([['feature', 'main'], []])
  } finally {
    await server.stop(true)
  }
})

// A step before checkout dispatches workers, so they start while the job
// installs (~20 s on CI); the run adopts them as its own: it watches their
// jobs and cancels their run when it closes.
it('adopts the workers a step started, watching and stopping them as its own', async () => {
  const calls: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      calls.push(`${req.method} ${path}`)
      if (path === '/repos/o/r/actions/runs/9/jobs')
        return Response.json({
          jobs: [{ name: 'small#2', status: 'completed', conclusion: 'failure', steps: [] }],
        })
      return new Response(null, { status: 202 })
    },
  })
  const temp = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-gh-'))
  await Bun.write(path.join(temp, 'vx-dte-started'), '/repos/o/r/actions/runs/9 small#1,small#2\n')
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
    RUNNER_TEMP: temp,
  })
  try {
    const adopted: string[] = []
    const why: string[] = []
    const adapter = github()
    adapter.adopt?.((id, size) => {
      adopted.push(`${id} ${size}`)
      return spawn(id, size, (w) => why.push(`${id}: ${w}`))
    })
    expect(adopted).toEqual(['small#1 small', 'small#2 small'])
    for (let i = 0; i < 50 && why.length === 0; i++) await Bun.sleep(100)
    expect(why).toEqual(['small#2: job failure'])
    await adapter.close?.()
    expect(calls).toContain('POST /repos/o/r/actions/runs/9/cancel')
    // Control: with no file there is nothing to adopt.
    await rm(path.join(temp, 'vx-dte-started'))
    const none: string[] = []
    github().adopt?.((id, size) => {
      none.push(id)
      return spawn(id, size)
    })
    expect(none).toEqual([])
  } finally {
    await server.stop(true)
    await rm(temp, { recursive: true, force: true })
  }
}, 10_000)

// 2026-10-23: a remote fault is at least a warning. A jobs poll or a
// cancel GitHub refused went unsaid: a dead worker unseen, a run left to
// hold runners until its timeout.
it('says each poll and cancel GitHub refused, by status and body, once', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path.endsWith('/dispatches')) return Response.json({ workflow_run_id: 7 })
      if (path.endsWith('/jobs')) return new Response('bad gateway', { status: 502 })
      return new Response('cannot cancel', { status: 500 })
    },
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
  })
  try {
    const said: string[] = []
    const adapter = github()
    adapter.report?.((m) => said.push(m))
    void adapter.spawn(spawn('small#1', 'small'))
    for (let i = 0; i < 80 && said.length === 0; i++) await Bun.sleep(100)
    await adapter.close?.()
    expect(said).toEqual([
      "github(): reading workflow run 7's jobs failed: 502 bad gateway",
      'github(): cancelling workflow run 7 failed: 500 cannot cancel',
    ])
  } finally {
    await server.stop(true)
  }
}, 15_000)

// Every job of a repository shares GITHUB_TOKEN's API limit (1000 an
// hour). Each run polled its workers' jobs every 10 s, so with many PRs
// at once the limit ran out, dispatches were refused and workers never
// started (2026-10-28). A 304 to a conditional ask is free.
it("asks a run's jobs again with its ETag, a 304 changing nothing", async () => {
  const asked: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path.endsWith('/dispatches')) return Response.json({ workflow_run_id: 7 })
      if (path.endsWith('/jobs')) {
        const tag = req.headers.get('if-none-match')
        asked.push(tag)
        if (tag === '"j1"') return new Response(null, { status: 304, headers: { etag: '"j1"' } })
        return Response.json(
          { jobs: [{ name: 'small#1', status: 'in_progress', conclusion: null }] },
          { headers: { etag: '"j1"' } },
        )
      }
      return new Response(null, { status: 202 })
    },
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
  })
  try {
    const said: string[] = []
    const why: string[] = []
    const adapter = github()
    adapter.report?.((m) => said.push(m))
    void adapter.spawn(spawn('small#1', 'small', (w) => why.push(w)))
    for (let i = 0; i < 100 && asked.length < 2; i++) await Bun.sleep(100)
    await adapter.close?.()
    expect(asked).toEqual([null, '"j1"'])
    expect(said).toEqual([])
    expect(why).toEqual([])
  } finally {
    await server.stop(true)
  }
}, 15_000)

it('asks no more jobs until a spent API limit resets, saying when', async () => {
  let jobs = 0
  const reset = Math.ceil(Date.now() / 1000) + 3600
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path.endsWith('/dispatches')) return Response.json({ workflow_run_id: 7 })
      if (path.endsWith('/jobs')) {
        jobs++
        return new Response('API rate limit exceeded for installation', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        })
      }
      return new Response(null, { status: 202 })
    },
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
  })
  try {
    const said: string[] = []
    const adapter = github()
    adapter.report?.((m) => said.push(m))
    void adapter.spawn(spawn('small#1', 'small'))
    // Unlimited, the second ask comes 6 s in (2 s, then 4 s later).
    await Bun.sleep(7_000)
    await adapter.close?.()
    expect(jobs).toBe(1)
    expect(said).toEqual([
      `github(): reading workflow run 7's jobs failed: 403 API rate limit exceeded for installation; the repository's API limit resets at ${new Date(reset * 1000).toISOString()}`,
    ])
  } finally {
    await server.stop(true)
  }
}, 15_000)

it('dispatches again once a spent API limit resets', async () => {
  let dispatches = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path.endsWith('/dispatches')) {
        if (++dispatches === 1)
          return new Response('API rate limit exceeded for installation', {
            status: 403,
            headers: { 'retry-after': '1' },
          })
        return Response.json({ workflow_run_id: 7 })
      }
      if (path.endsWith('/jobs')) return Response.json({ jobs: [] })
      return new Response(null, { status: 202 })
    },
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
  })
  try {
    const why: string[] = []
    const adapter = github()
    void adapter.spawn(spawn('small#1', 'small', (w) => why.push(w)))
    for (let i = 0; i < 40 && dispatches < 2; i++) await Bun.sleep(100)
    await adapter.close?.()
    expect(dispatches).toBe(2)
    expect(why).toEqual([])
  } finally {
    await server.stop(true)
  }
}, 10_000)

it('names the spent API limit, not a permission, when its reset is too far', async () => {
  const reset = Math.ceil(Date.now() / 1000) + 3600
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () =>
      new Response('API rate limit exceeded for installation', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      }),
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
  })
  try {
    const why: string[] = []
    const adapter = github()
    void adapter.spawn(spawn('small#1', 'small', (w) => why.push(w)))
    for (let i = 0; i < 30 && why.length === 0; i++) await Bun.sleep(100)
    expect(why).toEqual([
      `github(): dispatching vx-worker.yml: 403 API rate limit exceeded for installation; the repository's API limit resets at ${new Date(reset * 1000).toISOString()}`,
    ])
  } finally {
    await server.stop(true)
  }
}, 10_000)

// An orchestrator that died where it could not cancel (the API limit spent,
// a SIGKILL) left its queued workers to start for no one, each holding a
// runner (2026-10-28): each worker reads its run's attempt first.
it("names the run's own attempt to the workers it dispatches", async () => {
  const bodies: { inputs: Record<string, string> }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      bodies.push((await req.json()) as { inputs: Record<string, string> })
      return new Response(null, { status: 204 })
    },
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
    GITHUB_RUN_ID: '55',
    GITHUB_RUN_ATTEMPT: '2',
  })
  try {
    void github().spawn(spawn('small#1', 'small'))
    for (let i = 0; i < 50 && bodies.length === 0; i++) await Bun.sleep(10)
    expect(bodies[0]?.inputs['parent']).toBe('55/attempts/2')
  } finally {
    await server.stop(true)
  }
})

// A cancel the spent API limit refused left the run's workers queued for
// runners after it ended (2026-10-28): closing, it asks again at the reset.
it('cancels again once a spent API limit resets, as the run closes', async () => {
  let cancels = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path.endsWith('/dispatches')) return Response.json({ workflow_run_id: 8 })
      if (path.endsWith('/cancel') && ++cancels === 1)
        return new Response('API rate limit exceeded for installation', {
          status: 403,
          headers: { 'retry-after': '1' },
        })
      if (path.endsWith('/jobs')) return Response.json({ jobs: [] })
      return new Response(null, { status: 202 })
    },
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
  })
  try {
    const said: string[] = []
    const adapter = github()
    adapter.report?.((m) => said.push(m))
    void adapter.spawn(spawn('small#1', 'small'))
    await Bun.sleep(100)
    await adapter.close?.()
    expect(cancels).toBe(2)
    expect(said).toEqual([])
  } finally {
    await server.stop(true)
  }
}, 10_000)

it('says a cancel the spent API limit refuses past its wait, with the reset', async () => {
  const reset = Math.ceil(Date.now() / 1000) + 3600
  let cancels = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path.endsWith('/dispatches')) return Response.json({ workflow_run_id: 8 })
      if (path.endsWith('/cancel')) {
        cancels++
        return new Response('API rate limit exceeded for installation', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        })
      }
      return Response.json({ jobs: [] })
    },
  })
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
  })
  try {
    const said: string[] = []
    const adapter = github()
    adapter.report?.((m) => said.push(m))
    void adapter.spawn(spawn('small#1', 'small'))
    await Bun.sleep(100)
    await adapter.close?.()
    expect(cancels).toBe(1)
    expect(said).toEqual([
      `github(): cancelling workflow run 8 failed: 403 API rate limit exceeded for installation; the repository's API limit resets at ${new Date(reset * 1000).toISOString()}`,
    ])
  } finally {
    await server.stop(true)
  }
})

// The workflow runs it dispatched or adopted are the only ones whose jobs
// the orchestrator admits as its workers (seal.ts githubProof); one
// dispatch that named no run (an older API) admits any of the repository.
it('names the workflow runs its workers come from, none once a dispatch named no run', async () => {
  let id = 6
  let named = true
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      if (new URL(req.url).pathname.endsWith('/dispatches'))
        return named
          ? Response.json({ workflow_run_id: ++id })
          : new Response(null, { status: 204 })
      return Response.json({ jobs: [] })
    },
  })
  const temp = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-gh-'))
  await Bun.write(path.join(temp, 'vx-dte-started'), '/repos/o/r/actions/runs/5 small#1\n')
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'ght',
    GITHUB_REF_NAME: 'main',
    GITHUB_SHA: 'abc123',
    RUNNER_TEMP: temp,
  })
  try {
    const adapter = github()
    expect([...adapter.workerRuns!()!]).toEqual([])
    adapter.adopt?.((w, size) => spawn(w, size))
    void adapter.spawn(spawn('small#2', 'small'))
    for (let i = 0; i < 50 && adapter.workerRuns!()!.size < 2; i++) await Bun.sleep(20)
    expect([...adapter.workerRuns!()!].sort()).toEqual(['5', '7'])
    named = false
    void adapter.spawn(spawn('big#3', 'big'))
    for (let i = 0; i < 50 && adapter.workerRuns!() !== undefined; i++) await Bun.sleep(20)
    expect(adapter.workerRuns!()).toBeUndefined()
  } finally {
    await server.stop(true)
    await rm(temp, { recursive: true, force: true })
  }
})
