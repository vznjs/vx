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

  // The values its results row shows once it ends: average cores and peak
  // memory, never the last half second's.
  it('cores are the average since the task started; mem is its peak so far', async () => {
    const c = clock()
    let now = 0
    const seen = [
      { cpuMs: 1500, rssBytes: 30 },
      // A descendant exited: its CPU and memory left the tree's sum.
      { cpuMs: 1200, rssBytes: 10 },
      { cpuMs: 3600, rssBytes: 20 },
    ]
    const live = createLiveUsage({
      every: c.every,
      now: () => now,
      sample: async () => new Map([[7, seen.shift()!]]),
    })
    live.track('p#a', 7)
    live.usage('p#a')
    now = 1000
    await c.tick()
    expect(live.usage('p#a')).toEqual({ cores: 1.5, rssBytes: 30 })
    now = 2000
    await c.tick()
    expect(live.usage('p#a')).toEqual({ cores: 0.75, rssBytes: 30 })
    now = 3000
    await c.tick()
    expect(live.usage('p#a')).toEqual({ cores: 1.2, rssBytes: 30 })
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
