// The synchronizer's contract, driven over a real socket with a fake worker.
//
// A fake worker rather than a real one on purpose: everything interesting here
// is the RENDEZVOUS — does a result reach the vx side that is waiting for it,
// does a task go to a worker that can actually run it — and none of that needs
// git, an install, or a task to execute.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { SyncClient } from '../src/client.js'
import { SyncServer } from '../src/sync.js'
import { satisfies, type RunEvent } from '../src/protocol.js'

let server: ReturnType<SyncServer['listen']> | undefined
let sync: SyncServer
let client: SyncClient

beforeEach(() => {
  // A short poll so the "nothing to do" path is testable; production holds
  // 25 s so a worker is not asking every second.
  sync = new SyncServer({ port: 0, workPollMs: 300 })
  server = sync.listen()
  client = new SyncClient({ endpoint: `http://127.0.0.1:${server.port}` })
})

afterEach(() => {
  void server?.stop(true)
  server = undefined
})

const caps = { concurrency: 1 }

describe('the rendezvous', () => {
  it('carries a task from vx to a worker and its result back', async () => {
    const worker = await client.register({ name: 'w0', capabilities: caps })
    const run = await client.openRun('abc123', 'https://git.example/repo.git')

    const events: RunEvent[] = []
    await client.subscribe(run.runId, (e) => events.push(e))

    const assignmentId = await client.dispatch(run.runId, {
      taskId: 'pkg#build',
      project: 'pkg',
      task: 'build',
      forwardArgs: [],
      requirement: {},
    })

    const claimed = await client.claim(worker.workerId)
    expect(claimed?.assignmentId).toBe(assignmentId)
    // The worker gets the run's commit and remote, which is all it needs to
    // put itself at the right source — vx never ships a file.
    expect(claimed?.commit).toBe('abc123')
    expect(claimed?.remote).toBe('https://git.example/repo.git')

    await client.output(assignmentId, 'out', 'hello\n')
    await client.result(assignmentId, {
      exitCode: 0,
      durationMs: 5,
      workerId: worker.workerId,
    })

    await settle(() => events.some((e) => e.kind === 'result'))
    const output = events.find((e) => e.kind === 'output')
    expect(output).toEqual({
      kind: 'output',
      assignmentId,
      stream: 'out',
      chunk: 'hello\n',
    })
    const result = events.find((e) => e.kind === 'result')
    expect(result?.kind === 'result' && result.result.exitCode).toBe(0)
    // `where` comes from here — it is how a run attributes a task to a machine.
    expect(result?.kind === 'result' && result.result.workerId).toBe(worker.workerId)
  })

  it('answers 204 when a poll expires with nothing to do', async () => {
    // Distinguishable from an assignment on purpose: a worker that got no work
    // and a worker handed a malformed empty one must not look the same.
    const worker = await client.register({ name: 'idle', capabilities: caps })
    expect(await client.claim(worker.workerId)).toBe(null)
  })

  it('routes a task only to a worker that satisfies it', async () => {
    const small = await client.register({
      name: 'small',
      capabilities: { concurrency: 1, cores: 1, memory: 1024 },
    })
    const big = await client.register({
      name: 'big',
      capabilities: { concurrency: 1, cores: 8, memory: 16_384 },
    })
    const run = await client.openRun('c', 'r')
    await client.dispatch(run.runId, {
      taskId: 'pkg#heavy',
      project: 'pkg',
      task: 'heavy',
      forwardArgs: [],
      requirement: { cores: 4 },
    })

    // The small worker must come back empty rather than take work it cannot
    // honour — that would turn a placement error into someone's OOM.
    expect(await client.claim(small.workerId)).toBe(null)
    expect((await client.claim(big.workerId))?.taskId).toBe('pkg#heavy')
  })

  it("releases a run's workers when the run closes", async () => {
    // A run that ended holding leases would starve every later run until they
    // timed out, which reads as the fleet being broken.
    const worker = await client.register({ name: 'w', capabilities: caps })
    const first = await client.openRun('c1', 'r')
    await client.dispatch(first.runId, {
      taskId: 'a#t',
      project: 'a',
      task: 't',
      forwardArgs: [],
      requirement: {},
    })
    const claimed = await client.claim(worker.workerId)
    await client.result(claimed!.assignmentId, {
      exitCode: 0,
      durationMs: 1,
      workerId: worker.workerId,
    })
    await client.closeRun(first.runId)

    const second = await client.openRun('c2', 'r')
    await client.dispatch(second.runId, {
      taskId: 'b#t',
      project: 'b',
      task: 't',
      forwardArgs: [],
      requirement: {},
    })
    expect((await client.claim(worker.workerId))?.taskId).toBe('b#t')
  })
})

describe('satisfies', () => {
  it('treats an absent requirement axis as no constraint', () => {
    expect(satisfies({ concurrency: 1 }, {})).toBe(true)
  })

  it('refuses when the worker never said, rather than assuming it can', () => {
    // "Unknown" is not "enough". Routing an 8 GB task to a worker that never
    // advertised its memory would make the declaration a lie.
    expect(satisfies({ concurrency: 1 }, { memory: 8192 })).toBe(false)
  })

  it('needs every declared axis, not one of them', () => {
    const worker = { concurrency: 1, cores: 8, memory: 1024, image: 'a' }
    expect(satisfies(worker, { cores: 4, memory: 512 })).toBe(true)
    expect(satisfies(worker, { cores: 4, memory: 4096 })).toBe(false)
    expect(satisfies(worker, { image: 'b' })).toBe(false)
  })
})

async function settle(done: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done() && Date.now() < deadline) await Bun.sleep(5)
}
