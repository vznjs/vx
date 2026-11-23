// The model behind <DteSpread>: the demo workspace's six tasks, with the
// times a real local() run measured (2026-11-23, two 2-core workers), laid
// over workers. Simplified from the real plan: a worker runs two tasks at
// once, the ready task on the longest chain goes first, and it goes to the
// busiest worker with room, so workers fill before another starts.

export interface Task {
  id: string
  project: 'ui' | 'web'
  ms: number
  needs: string[]
}

export const TASKS: Task[] = [
  { id: '@demo/ui#build', project: 'ui', ms: 312, needs: [] },
  { id: '@demo/ui#test', project: 'ui', ms: 513, needs: [] },
  { id: '@demo/ui#lint', project: 'ui', ms: 70, needs: [] },
  { id: '@demo/web#build', project: 'web', ms: 310, needs: ['@demo/ui#build'] },
  { id: '@demo/web#test', project: 'web', ms: 447, needs: ['@demo/ui#build'] },
  { id: '@demo/web#lint', project: 'web', ms: 97, needs: [] },
]

export const WARM_UP_MS = 250
export const SLOTS = 2
export const RESTORE_MS = 20

export type Push = 'all' | 'web' | 'none'

export interface Bar {
  id: string
  lane: number // 0 = your CI job, 1.. = worker n
  start: number
  end: number
  kind: 'task' | 'warm' | 'hit'
  slot?: number // which of the worker's two task rows
}

export interface Plan {
  bars: Bar[]
  workers: number
  end: number
}

// The tasks a push makes run: an edit in apps/web misses only web's tasks.
export const misses = (push: Push): Set<string> =>
  new Set(
    TASKS.filter((t) => push === 'all' || (push === 'web' && t.project === 'web')).map((t) => t.id),
  )

// Longest time from a task's start to the end of everything after it.
function chain(id: string, run: Set<string>): number {
  const t = TASKS.find((x) => x.id === id)!
  const after = TASKS.filter((x) => run.has(x.id) && x.needs.includes(id))
  return t.ms + Math.max(0, ...after.map((x) => chain(x.id, run)))
}

function simulate(run: Set<string>, n: number): Bar[] {
  const bars: Bar[] = []
  for (let w = 1; w <= n; w++)
    bars.push({ id: `worker ${w}`, lane: w, start: 0, end: WARM_UP_MS, kind: 'warm' })
  const running: Bar[] = []
  const done = new Map<string, number>()
  const left = TASKS.filter((t) => run.has(t.id)).sort(
    (a, b) => chain(b.id, run) - chain(a.id, run),
  )
  let now = WARM_UP_MS
  while (left.length) {
    for (const t of [...left]) {
      if (!t.needs.every((d) => !run.has(d) || (done.get(d) ?? Infinity) <= now)) continue
      const busy = (w: number) => running.filter((b) => b.lane === w && b.end > now).length
      // The busiest worker with room, so one fills before the next works.
      const lanes = Array.from({ length: n }, (_, i) => i + 1).filter((w) => busy(w) < SLOTS)
      if (!lanes.length) break
      const w = lanes.sort((a, b) => busy(b) - busy(a) || a - b)[0]!
      const taken = running.filter((b) => b.lane === w && b.end > now).map((b) => b.slot)
      const slot = taken.includes(0) ? 1 : 0
      const bar: Bar = { id: t.id, lane: w, start: now, end: now + t.ms, kind: 'task', slot }
      running.push(bar)
      bars.push(bar)
      done.set(t.id, bar.end)
      left.splice(left.indexOf(t), 1)
    }
    now = Math.min(...running.map((b) => b.end).filter((e) => e > now))
  }
  return bars
}

// vx compares plans by when the run ends, then by fewer workers.
export function plan(push: Push, max: number): Plan {
  const run = misses(push)
  const bars: Bar[] = TASKS.filter((t) => !run.has(t.id)).map((t, i) => ({
    id: t.id,
    lane: 0,
    start: i * RESTORE_MS,
    end: (i + 1) * RESTORE_MS,
    kind: 'hit' as const,
  }))
  const restored = Math.max(0, ...bars.map((b) => b.end))
  if (run.size === 0) return { bars, workers: 0, end: restored }
  let best: Bar[] | undefined
  let bestEnd = Infinity
  for (let n = 1; n <= max; n++) {
    const b = simulate(run, n)
    const end = Math.max(...b.map((x) => x.end))
    if (end < bestEnd) {
      best = b
      bestEnd = end
    }
  }
  const workers = new Set(best!.filter((b) => b.kind === 'task').map((b) => b.lane)).size
  return { bars: [...bars, ...best!], workers, end: Math.max(bestEnd, restored) }
}

export const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)}s`

// The tasks on the run's longest chain: no number of workers ends it sooner.
export function longest(push: Push): string[] {
  const run = misses(push)
  const from = (id: string): string[] => {
    const after = TASKS.filter((x) => run.has(x.id) && x.needs.includes(id))
    const next = after.sort((a, b) => chain(b.id, run) - chain(a.id, run))[0]
    return [id, ...(next ? from(next.id) : [])]
  }
  const roots = TASKS.filter((t) => run.has(t.id) && !t.needs.some((d) => run.has(d)))
  const top = roots.sort((a, b) => chain(b.id, run) - chain(a.id, run))[0]
  return top ? from(top.id) : []
}
