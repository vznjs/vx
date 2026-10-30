// The live list's `cpu` and `mem`: each running task's process tree's
// average cores since it started and its peak memory so far, the values
// its results row shows once it ends (2026-10-29: the live row showed the
// last half second's, and a task's row changed meaning as it finished).
// Looked at on a timer only once the list asks for a row, so a run with
// no live list (a pipe, CI) registers pids and reads nothing.
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
  startedAt: number
  /** The most CPU time the tree has shown: a descendant that exits takes its share out of the sum. */
  cpuMs: number
  peakRssBytes: number
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
        t.cpuMs = Math.max(t.cpuMs, u.cpuMs)
        t.peakRssBytes = Math.max(t.peakRssBytes, u.rssBytes)
        if (ts > t.startedAt) {
          const cores = t.cpuMs / (ts - t.startedAt)
          t.now = { cores: Math.round(cores * 100) / 100, rssBytes: t.peakRssBytes }
        }
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
      const t: Tracked = { pid, startedAt: now(), cpuMs: 0, peakRssBytes: 0 }
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
