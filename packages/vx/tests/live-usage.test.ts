import { describe, expect, it } from 'bun:test'
import { createLiveUsage } from '../src/orchestrator/live-usage.js'

// The live list's `cpu` and `mem`: a running task's process tree, looked at
// on a timer only once the list asks, so a run with no live list (a pipe,
// CI) never reads /proc for it.
describe('live task usage', () => {
  const clock = () => {
    let fn: (() => Promise<void>) | undefined
    let starts = 0
    return {
      every: (_ms: number, f: () => Promise<void>) => {
        starts++
        fn = f
        return () => {
          fn = undefined
        }
      },
      tick: () => fn?.(),
      get running() {
        return fn !== undefined
      },
      get starts() {
        return starts
      },
    }
  }

  it('looks at nothing until the list asks', async () => {
    const c = clock()
    let reads = 0
    const live = createLiveUsage({
      every: c.every,
      sample: async () => {
        reads++
        return new Map()
      },
    })
    const stop = live.track('p#a', 1)
    expect(c.running).toBe(false)
    expect(live.usage('p#a')).toBeUndefined()
    expect(c.running).toBe(true)
    await c.tick()
    expect(reads).toBe(1)
    stop()
    expect(c.running).toBe(false)
  })

  it('cores are CPU time over wall time between two looks; mem is the latest', async () => {
    const c = clock()
    let now = 0
    const seen = [
      { cpuMs: 100, rssBytes: 10 },
      { cpuMs: 1900, rssBytes: 30 },
    ]
    const live = createLiveUsage({
      every: c.every,
      now: () => now,
      sample: async () => new Map([[7, seen.shift()!]]),
    })
    live.track('p#a', 7)
    live.usage('p#a')
    await c.tick()
    // One look has no interval yet.
    expect(live.usage('p#a')).toBeUndefined()
    now = 1000
    await c.tick()
    expect(live.usage('p#a')).toEqual({ cores: 1.8, rssBytes: 30 })
  })

  it('a task that ended has no usage, and the timer stops with the last', async () => {
    const c = clock()
    const live = createLiveUsage({ every: c.every, sample: async () => new Map() })
    const a = live.track('p#a', 1)
    const b = live.track('p#b', 2)
    live.usage('p#a')
    a()
    expect(c.running).toBe(true)
    b()
    expect(c.running).toBe(false)
    expect(live.usage('p#a')).toBeUndefined()
  })
})
