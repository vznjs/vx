// The serve-side FIFO run queue (cloud-data-model-2026-07 §7): unit tests
// for the queue semantics, plus serve e2e over the run WebSocket — the
// queue:* wire, the plain-delegation queue line rendering through
// createWireRenderer, and cancel-on-socket-close.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createWireRenderer, type RunRequest, type WireEvent } from '@vzn/vx'
import { RunQueue } from '../src/run-queue.js'
import { startServe } from '../src/cli/serve.js'
import { serveInfoPath } from '../src/serve-info.js'

const prevServeInfo = process.env['VX_CLOUD_SERVE_INFO']
beforeAll(() => {
  process.env['VX_CLOUD_SERVE_INFO'] = path.join(tmpdir(), `vx-serveinfo-queue-${process.pid}.json`)
})
afterAll(async () => {
  await rm(serveInfoPath(), { force: true })
  if (prevServeInfo === undefined) delete process.env['VX_CLOUD_SERVE_INFO']
  else process.env['VX_CLOUD_SERVE_INFO'] = prevServeInfo
})

function req(task: string): RunRequest {
  return { tasks: [task], cwd: '/tmp' }
}

/** Flush microtasks (the queue starts each job's execute on one). */
const tick = (): Promise<void> => Bun.sleep(0)

describe('RunQueue', () => {
  it('runs FIFO, one at a time — the second execute waits for the first', async () => {
    const entered: string[] = []
    const gates = new Map<string, (ok: boolean) => void>()
    const queue = new RunQueue({
      execute: (job) =>
        new Promise<boolean>((resolve) => {
          entered.push(job.request.tasks[0]!)
          gates.set(job.request.tasks[0]!, resolve)
        }),
    })
    const a = queue.submit(req('a'))
    const b = queue.submit(req('b'))
    const c = queue.submit(req('c'))
    if ('error' in a || 'error' in b || 'error' in c) throw new Error('refused')
    expect(a.position).toBe(0)
    expect(b.position).toBe(1)
    expect(c.position).toBe(2)

    await tick()
    expect(entered).toEqual(['a'])
    expect(queue.jobs().map((j) => [j.tasks[0], j.state, j.position])).toEqual([
      ['a', 'running', 0],
      ['b', 'queued', 1],
      ['c', 'queued', 2],
    ])

    gates.get('a')!(true)
    await tick()
    expect(entered).toEqual(['a', 'b'])
    // Done jobs drop out; the promoted job renumbered to position 0.
    expect(queue.jobs().map((j) => [j.tasks[0], j.state, j.position])).toEqual([
      ['b', 'running', 0],
      ['c', 'queued', 1],
    ])

    gates.get('b')!(true)
    await tick()
    gates.get('c')!(false)
    await tick()
    expect(entered).toEqual(['a', 'b', 'c'])
    expect(queue.jobs()).toEqual([])
  })

  it('fires onUpdate with renumbered positions when earlier jobs finish', async () => {
    const gates: ((ok: boolean) => void)[] = []
    const updates: string[][] = []
    const queue = new RunQueue({
      execute: () => new Promise<boolean>((resolve) => gates.push(resolve)),
      onUpdate: (jobs) => updates.push(jobs.map((j) => `${j.tasks[0]}@${j.position}`)),
    })
    queue.submit(req('a'))
    queue.submit(req('b'))
    queue.submit(req('c'))
    await tick()
    expect(updates).toEqual([]) // submissions alone shift nobody

    gates[0]!(true)
    await tick()
    expect(updates).toEqual([['b@0', 'c@1']])
  })

  it('refuses past maxQueued', async () => {
    const queue = new RunQueue({
      execute: () => new Promise<boolean>(() => {}),
      maxQueued: 1,
    })
    expect('jobId' in queue.submit(req('a'))).toBe(true) // running
    expect('jobId' in queue.submit(req('b'))).toBe(true) // queued (1/1)
    const refused = queue.submit(req('c'))
    expect('error' in refused && refused.error).toMatch(/queue is full/)
  })

  it('cancels queued jobs (removes + renumbers); a running job is not cancelable', async () => {
    const updates: string[][] = []
    const queue = new RunQueue({
      execute: () => new Promise<boolean>(() => {}),
      onUpdate: (jobs) => updates.push(jobs.map((j) => `${j.tasks[0]}@${j.position}`)),
    })
    const a = queue.submit(req('a'))
    const b = queue.submit(req('b'))
    const c = queue.submit(req('c'))
    if ('error' in a || 'error' in b || 'error' in c) throw new Error('refused')

    expect(queue.cancel(b.jobId)).toBe(true)
    expect(updates).toEqual([['a@0', 'c@1']])
    expect(queue.jobs().map((j) => j.jobId)).toEqual([a.jobId, c.jobId])

    expect(queue.cancel(a.jobId)).toBe(false) // running
    expect(queue.cancel('nope')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Serve e2e.
// ---------------------------------------------------------------------------

/** A workspace with a fast task and a slow one (to hold the queue busy). */
async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-queue-'))
  spawnSync('git', ['init', '-q'], { cwd: root })
  spawnSync('git', ['config', 'user.email', 'a@b.c'], { cwd: root })
  spawnSync('git', ['config', 'user.name', 't'], { cwd: root })
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0' }),
  )
  await writeFile(
    path.join(root, 'vx.config.mjs'),
    [
      'export default {',
      '  tasks: {',
      '    hello: { exec: { command: "echo hi-from-task" } },',
      '    slow: { exec: { command: "sleep 0.5 && echo slow-done" } },',
      '  },',
      '}',
      '',
    ].join('\n'),
  )
  spawnSync('git', ['add', '-A'], { cwd: root })
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: root })
  return root
}

interface WsHarness {
  send: (m: unknown) => void
  messages: { t?: string; [k: string]: unknown }[]
  waitFor: (pred: (m: { t?: string; [k: string]: unknown }) => boolean) => Promise<any>
  close: () => void
}

function wsConnect(origin: string): Promise<WsHarness> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(origin.replace('http://', 'ws://'))
    const messages: { t?: string }[] = []
    const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = []
    sock.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data)) as { t?: string }
      messages.push(m)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pred(m)) waiters.splice(i, 1)[0]!.resolve(m)
      }
    })
    sock.addEventListener('open', () =>
      resolve({
        send: (m) => sock.send(JSON.stringify(m)),
        messages,
        waitFor: (pred) => {
          const hit = messages.find(pred)
          if (hit !== undefined) return Promise.resolve(hit)
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('waitFor timed out')), 10_000)
            waiters.push({
              pred,
              resolve: (m) => {
                clearTimeout(timer)
                res(m)
              },
            })
          })
        },
        close: () => sock.close(),
      }),
    )
    sock.addEventListener('error', reject)
  })
}

describe('vx serve — run queue e2e', () => {
  it('two queue:submits serialize; queue:done carries a resolvable runId', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    const ws = await wsConnect(server.origin)
    try {
      ws.send({ t: 'queue:submit', v: 1, request: { tasks: ['slow'], cwd: root } })
      const acc1 = await ws.waitFor((m) => m.t === 'queue:accepted')
      expect(acc1.position).toBe(0)
      await ws.waitFor((m) => m.t === 'queue:start' && m.jobId === acc1.jobId)

      ws.send({ t: 'queue:submit', v: 1, request: { tasks: ['hello'], cwd: root } })
      const acc2 = await ws.waitFor((m) => m.t === 'queue:accepted' && m.jobId !== acc1.jobId)
      expect(acc2.position).toBe(1)

      const done2 = await ws.waitFor((m) => m.t === 'queue:done' && m.jobId === acc2.jobId)
      expect(done2.ok).toBe(true)
      expect(typeof done2.runId).toBe('string')

      // Strict serialization on the shared timeline: the first job finished
      // before the second started.
      const idx = (pred: (m: { t?: string }) => boolean): number => ws.messages.findIndex(pred)
      const done1At = idx((m) => m.t === 'queue:done' && (m as any).jobId === acc1.jobId)
      const start2At = idx((m) => m.t === 'queue:start' && (m as any).jobId === acc2.jobId)
      expect(done1At).toBeGreaterThanOrEqual(0)
      expect(start2At).toBeGreaterThan(done1At)
      // Both jobs streamed the standard core wire between their frames.
      expect(idx((m) => m.t === 'result')).toBeGreaterThanOrEqual(0)

      // The runId links into run history (the self-ingested summary).
      const detail = await fetch(`${server.origin}/v1/runs/${done2.runId as string}`)
      expect(detail.status).toBe(200)
      expect(((await detail.json()) as { runId: string }).runId).toBe(done2.runId)
    } finally {
      ws.close()
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a plain delegated run queues behind a job and its queue line renders cleanly', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    const a = await wsConnect(server.origin)
    const b = await wsConnect(server.origin)
    try {
      a.send({ t: 'queue:submit', v: 1, request: { tasks: ['slow'], cwd: root } })
      await a.waitFor((m) => m.t === 'queue:start')

      // Plain CLI delegation while the queue is busy.
      b.send({ t: 'run', request: { tasks: ['hello'], cwd: root, flow: 'focused' } })
      const result = await b.waitFor((m) => m.t === 'result')
      expect((result.result as { ok: boolean }).ok).toBe(true)

      // The §7.2 verify item: the pre-run:start queue-position run:status
      // line renders through createWireRenderer without breaking output.
      const order: string[] = []
      const lines: string[] = []
      const render = createWireRenderer({
        status: (line) => {
          order.push('status')
          lines.push(line)
        },
        taskStdout: () => {},
        taskStderr: () => {},
        taskComplete: () => order.push('taskComplete'),
        runStart: () => order.push('runStart'),
        runEnd: () => order.push('runEnd'),
      })
      for (const m of b.messages) {
        if (m.t === 'event') render(m['event'] as WireEvent)
      }
      expect(lines.some((l) => l.includes('queued behind 1 run(s) on this serve'))).toBe(true)
      // The queue line came FIRST — before the delegated run's run:start.
      // (run:status lines also follow run:end: the summary footer, the
      // documented wireForwarder contract — so only the head is pinned.)
      expect(order[0]).toBe('status')
      expect(order).toContain('taskComplete')
      expect(order.indexOf('runStart')).toBeGreaterThan(0)
      expect(order.indexOf('runEnd')).toBeGreaterThan(order.indexOf('runStart'))
    } finally {
      a.close()
      b.close()
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reflects queue state over /v1/runs/queue; closing a queued socket cancels its job', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    const a = await wsConnect(server.origin)
    const b = await wsConnect(server.origin)
    try {
      a.send({ t: 'queue:submit', v: 1, request: { tasks: ['slow'], cwd: root } })
      await a.waitFor((m) => m.t === 'queue:start')
      b.send({ t: 'queue:submit', v: 1, request: { tasks: ['hello'], cwd: root } })
      const acc2 = await b.waitFor((m) => m.t === 'queue:accepted')
      expect(acc2.position).toBe(1)

      const state = (await (await fetch(`${server.origin}/v1/runs/queue`)).json()) as {
        jobs: { jobId: string; tasks: string[]; state: string; position: number }[]
      }
      expect(state.jobs.map((j) => [j.tasks[0], j.state, j.position])).toEqual([
        ['slow', 'running', 0],
        ['hello', 'queued', 1],
      ])

      // Close the QUEUED job's socket → canceled; the running one is not.
      b.close()
      let jobs: { state: string }[] = []
      for (let i = 0; i < 50; i++) {
        jobs = ((await (await fetch(`${server.origin}/v1/runs/queue`)).json()) as typeof state).jobs
        if (jobs.length === 1) break
        await Bun.sleep(20)
      }
      expect(jobs.map((j) => j.state)).toEqual(['running'])

      await a.waitFor((m) => m.t === 'queue:done')
      const after = (await (await fetch(`${server.origin}/v1/runs/queue`)).json()) as {
        jobs: unknown[]
      }
      expect(after.jobs).toEqual([])
    } finally {
      a.close()
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a queue protocol mismatch naming both versions', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    const ws = await wsConnect(server.origin)
    try {
      ws.send({ t: 'queue:submit', v: 99, request: { tasks: ['hello'], cwd: root } })
      const refused = await ws.waitFor((m) => m.t === 'queue:refused')
      expect(refused.message).toMatch(/v99/)
      expect(refused.message).toMatch(/v1/)
    } finally {
      ws.close()
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
