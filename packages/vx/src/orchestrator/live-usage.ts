// The live list's `cpu` and `mem`: what each running task's process tree
// uses now. Looked at on a timer only once the list asks for a row, so a
// run with no live list (a pipe, CI) registers pids and reads nothing.
// The look is async and off the dispatch path: a slow one skips a tick.

import { sampleTrees, type TreeUsage } from '../exec/index.js'
import type { LiveUsage } from '../report/index.js'

/** How often a tracked tree is looked at while the live list shows. */
const LOOK_MS = 500

type Every = (ms: number, fn: () => Promise<void>) => () => void

const everyInterval: Every = (ms, fn) => {
  const timer = setInterval(() => void fn(), ms)
  timer.unref()
  return () => clearInterval(timer)
}

interface Tracked {
  pid: number
  last?: { ts: number; cpuMs: number }
  now?: LiveUsage
}

export function createLiveUsage(
  opts: {
    every?: Every
    now?: () => number
    sample?: (pids: number[]) => Promise<Map<number, TreeUsage>>
  } = {},
): {
  track(taskId: string, pid: number): () => void
  usage(taskId: string): LiveUsage | undefined
} {
  const every = opts.every ?? everyInterval
  const now = opts.now ?? Date.now
  const sample = opts.sample ?? sampleTrees
  const tracked = new Map<string, Tracked>()
  let asked = false
  let looking = false
  let stop: (() => void) | undefined

  const look = async (): Promise<void> => {
    if (looking) return
    looking = true
    try {
      const entries = [...tracked]
      const usage = await sample(entries.map(([, t]) => t.pid))
      const ts = now()
      for (const [id, t] of entries) {
        const u = usage.get(t.pid)
        if (u === undefined || tracked.get(id) !== t) continue
        // A descendant that exited takes its CPU out of the live sum, so
        // an interval can read negative: none is shown below zero.
        if (t.last !== undefined && ts > t.last.ts) {
          const cores = Math.max(0, (u.cpuMs - t.last.cpuMs) / (ts - t.last.ts))
          t.now = { cores: Math.round(cores * 100) / 100, rssBytes: u.rssBytes }
        }
        t.last = { ts, cpuMs: u.cpuMs }
      }
    } catch {
      // A failed look is a missing point, never a broken run.
    } finally {
      looking = false
    }
  }
  const start = (): void => {
    if (asked && stop === undefined && tracked.size > 0) stop = every(LOOK_MS, look)
  }

  return {
    track(taskId, pid) {
      const t: Tracked = { pid }
      tracked.set(taskId, t)
      start()
      return () => {
        if (tracked.get(taskId) === t) tracked.delete(taskId)
        if (tracked.size === 0 && stop !== undefined) {
          stop()
          stop = undefined
        }
      }
    },
    usage(taskId) {
      if (!asked) {
        asked = true
        start()
      }
      return tracked.get(taskId)?.now
    },
  }
}
