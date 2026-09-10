// The save lane: a miss's cache save runs off the execution slot, bounded,
// drained by the run before the upload drain. Unit-level here; the run-level
// differential (saves overlap the next execution) is below.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { createSaveLane } from '../src/orchestrator/save-lane.js'
import { run } from '../src/orchestrator/index.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('createSaveLane', () => {
  it('runs up to `cap` saves at once and queues the rest in order', async () => {
    let active = 0
    let peak = 0
    const done: number[] = []
    const lane = createSaveLane(2, () => undefined)
    for (let i = 0; i < 5; i++) {
      void lane.defer(async () => {
        peak = Math.max(peak, ++active)
        await sleep(10)
        active--
        done.push(i)
      })
    }
    await lane.drain()
    expect(peak).toBe(2)
    expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
  })

  it('drain settles saves queued behind running ones, and ones deferred during the drain', async () => {
    const lane = createSaveLane(1, () => undefined)
    const order: string[] = []
    void lane.defer(async () => {
      await sleep(5)
      order.push('a')
      void lane.defer(async () => {
        await sleep(5)
        order.push('c')
      })
    })
    void lane.defer(async () => {
      order.push('b')
    })
    await lane.drain()
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('a failed save reaches onError, frees its slot, and never rejects the drain', async () => {
    const errors: string[] = []
    const lane = createSaveLane(1, (e) => errors.push(String(e)))
    let second = false
    void lane.defer(async () => {
      throw new Error('disk full')
    })
    void lane.defer(async () => {
      second = true
    })
    await lane.drain()
    expect(errors).toEqual(['Error: disk full'])
    expect(second).toBe(true)
  })
})

describe('the save lane in a run', () => {
  it('a slow cache save no longer holds the execution slot, and the entries still land', async () => {
    // A cache layer whose every save sleeps 300 ms, over the local cache,
    // and an order log every event appends to. Four independent cached
    // tasks on ONE slot: with the save in the slot no execution can start
    // between a save's start and its end; off the slot the next task's
    // execution does — that ordering is the claim, and it holds under
    // any load. Then the second run must hit: the lane was drained
    // before the first run returned.
    const root = await makeWorkspace({ prefix: 'vx-save-lane-' })
    const orderLog = path.join(root, 'order.log')
    try {
      await Bun.write(
        path.join(root, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [
            pluginSource(
              'org/slow-save',
              `{
                cache: (ctx) => {
                  const local = ctx.localCache
                  return new Proxy(local, {
                    get(target, key) {
                      const v = Reflect.get(target, key)
                      if (key === 'save') {
                        return async (args) => {
                          appendFileSync(${JSON.stringify(orderLog)}, 'save-start\\n')
                          await new Promise((r) => setTimeout(r, 300))
                          const out = await v.call(target, args)
                          appendFileSync(${JSON.stringify(orderLog)}, 'save-end\\n')
                          return out
                        }
                      }
                      return typeof v === 'function' ? v.bind(target) : v
                    },
                  })
                },
              }`,
            ),
          ],
          "import { appendFileSync } from 'node:fs'\n",
        ),
      )
      for (const name of ['a', 'b', 'c', 'd']) {
        await addProject(root, name, {
          files: { 'src/in.txt': name },
          config: `export default { tasks: { build: {
              exec: { command: 'echo exec-${name} >> ${orderLog} && cat src/in.txt > out.txt' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
            } } }`,
        })
      }
      const silent = {
        runStart: () => undefined,
        taskStart: () => undefined,
        taskStdout: () => undefined,
        taskStderr: () => undefined,
        taskComplete: () => undefined,
        runStatus: () => undefined,
        runEnd: () => undefined,
        status: () => undefined,
      }
      const first = await run({ cwd: root, tasks: ['build'], concurrency: 1, log: silent })
      expect(first.ok).toBe(true)
      expect(first.outcomes.filter((o) => o.status === 'success').length).toBe(4)
      const events = (await Bun.file(orderLog).text()).trim().split('\n')
      expect(events.filter((e) => e === 'save-end').length).toBe(4)
      // An execution started while a save was in flight.
      let inFlight = 0
      let overlapped = false
      for (const e of events) {
        if (e === 'save-start') inFlight++
        else if (e === 'save-end') inFlight--
        else if (e.startsWith('exec-') && inFlight > 0) overlapped = true
      }
      expect(overlapped).toBe(true)
      const second = await run({ cwd: root, tasks: ['build'], concurrency: 1, log: silent })
      expect(second.outcomes.map((o) => o.status)).toEqual([
        'cache-hit',
        'cache-hit',
        'cache-hit',
        'cache-hit',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
