// The data behind <DteSpread>: nine real runs of the demo workspace's
// `vx run build test lint --all` over local() workers (2-core machines,
// 2026-11-23), one per push (every task changed, an edit in packages/web,
// nothing changed) and per `max` (1 to 3). Each bar is a task's command on
// the worker that ran it, ending when the run heard it end; a worker's
// warm-up runs from when the run asked for it. Recorded from `vx last
// --format json` and the run's workers lines, never modelled.

export type Push = 'all' | 'web' | 'none'

export interface Bar {
  id: string
  lane: number // 0 = your CI job, 1.. = worker n
  start: number
  end: number
  kind: 'task' | 'warm' | 'hit'
  slot?: number // which of the worker's rows, when its tasks overlap
}

export interface Run {
  bars: Bar[]
  workers: number
  end: number
}

// Which task waits on which, as the demo's configs say (`dependsOn: ['^build']`).
const NEEDS: Record<string, string[]> = {
  '@demo/web#build': ['@demo/ui#build'],
  '@demo/web#test': ['@demo/ui#build'],
}

export const RUNS: Record<`${Push}-${1 | 2 | 3}`, Run> = {
  'all-1': {
    bars: [
      {
        id: 'worker 1',
        lane: 1,
        start: 0,
        end: 200,
        kind: 'warm',
      },
      {
        id: '@demo/ui#test',
        lane: 1,
        start: 234,
        end: 611,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/ui#build',
        lane: 1,
        start: 268,
        end: 489,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/ui#lint',
        lane: 1,
        start: 492,
        end: 545,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#lint',
        lane: 1,
        start: 557,
        end: 607,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#test',
        lane: 1,
        start: 619,
        end: 1038,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/web#build',
        lane: 1,
        start: 620,
        end: 858,
        kind: 'task',
        slot: 1,
      },
    ],
    workers: 1,
    end: 1041,
  },
  'all-2': {
    bars: [
      {
        id: 'worker 1',
        lane: 1,
        start: 0,
        end: 200,
        kind: 'warm',
      },
      {
        id: 'worker 2',
        lane: 2,
        start: 0,
        end: 200,
        kind: 'warm',
      },
      {
        id: '@demo/ui#test',
        lane: 1,
        start: 273,
        end: 725,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/ui#build',
        lane: 1,
        start: 298,
        end: 532,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#lint',
        lane: 2,
        start: 342,
        end: 411,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/ui#lint',
        lane: 2,
        start: 352,
        end: 409,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#test',
        lane: 1,
        start: 558,
        end: 962,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#build',
        lane: 1,
        start: 759,
        end: 991,
        kind: 'task',
        slot: 0,
      },
    ],
    workers: 2,
    end: 998,
  },
  'all-3': {
    bars: [
      {
        id: 'worker 1',
        lane: 1,
        start: 0,
        end: 200,
        kind: 'warm',
      },
      {
        id: 'worker 2',
        lane: 2,
        start: 0,
        end: 200,
        kind: 'warm',
      },
      {
        id: 'worker 3',
        lane: 3,
        start: 600,
        end: 800,
        kind: 'warm',
      },
      {
        id: '@demo/ui#test',
        lane: 1,
        start: 268,
        end: 695,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/ui#build',
        lane: 1,
        start: 293,
        end: 554,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/ui#lint',
        lane: 2,
        start: 307,
        end: 388,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/web#lint',
        lane: 2,
        start: 318,
        end: 387,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#test',
        lane: 1,
        start: 580,
        end: 1010,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#build',
        lane: 1,
        start: 718,
        end: 954,
        kind: 'task',
        slot: 0,
      },
    ],
    workers: 3,
    end: 1014,
  },
  'web-1': {
    bars: [
      {
        id: 'worker 1',
        lane: 1,
        start: 100,
        end: 300,
        kind: 'warm',
      },
      {
        id: '@demo/ui#build',
        lane: 0,
        start: 29,
        end: 30,
        kind: 'hit',
      },
      {
        id: '@demo/ui#lint',
        lane: 0,
        start: 32,
        end: 32,
        kind: 'hit',
      },
      {
        id: '@demo/ui#test',
        lane: 0,
        start: 32,
        end: 32,
        kind: 'hit',
      },
      {
        id: '@demo/web#test',
        lane: 1,
        start: 297,
        end: 703,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/web#build',
        lane: 1,
        start: 308,
        end: 664,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#lint',
        lane: 1,
        start: 689,
        end: 740,
        kind: 'task',
        slot: 1,
      },
    ],
    workers: 1,
    end: 744,
  },
  'web-2': {
    bars: [
      {
        id: 'worker 1',
        lane: 1,
        start: 0,
        end: 200,
        kind: 'warm',
      },
      {
        id: 'worker 2',
        lane: 2,
        start: 0,
        end: 300,
        kind: 'warm',
      },
      {
        id: '@demo/ui#build',
        lane: 0,
        start: 23,
        end: 24,
        kind: 'hit',
      },
      {
        id: '@demo/ui#lint',
        lane: 0,
        start: 26,
        end: 26,
        kind: 'hit',
      },
      {
        id: '@demo/ui#test',
        lane: 0,
        start: 26,
        end: 26,
        kind: 'hit',
      },
      {
        id: '@demo/web#lint',
        lane: 1,
        start: 314,
        end: 385,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/web#test',
        lane: 1,
        start: 326,
        end: 702,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#build',
        lane: 2,
        start: 360,
        end: 646,
        kind: 'task',
        slot: 0,
      },
    ],
    workers: 2,
    end: 705,
  },
  'web-3': {
    bars: [
      {
        id: 'worker 1',
        lane: 1,
        start: 0,
        end: 200,
        kind: 'warm',
      },
      {
        id: 'worker 2',
        lane: 2,
        start: 0,
        end: 200,
        kind: 'warm',
      },
      {
        id: '@demo/ui#build',
        lane: 0,
        start: 22,
        end: 23,
        kind: 'hit',
      },
      {
        id: '@demo/ui#lint',
        lane: 0,
        start: 25,
        end: 25,
        kind: 'hit',
      },
      {
        id: '@demo/ui#test',
        lane: 0,
        start: 25,
        end: 25,
        kind: 'hit',
      },
      {
        id: '@demo/web#lint',
        lane: 2,
        start: 270,
        end: 359,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/web#test',
        lane: 2,
        start: 278,
        end: 681,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#build',
        lane: 1,
        start: 309,
        end: 659,
        kind: 'task',
        slot: 0,
      },
    ],
    workers: 2,
    end: 684,
  },
  'none-1': {
    bars: [
      {
        id: '@demo/ui#build',
        lane: 0,
        start: 9,
        end: 10,
        kind: 'hit',
      },
      {
        id: '@demo/ui#test',
        lane: 0,
        start: 12,
        end: 12,
        kind: 'hit',
      },
      {
        id: '@demo/web#build',
        lane: 0,
        start: 12,
        end: 12,
        kind: 'hit',
      },
      {
        id: '@demo/ui#lint',
        lane: 0,
        start: 13,
        end: 13,
        kind: 'hit',
      },
      {
        id: '@demo/web#lint',
        lane: 0,
        start: 13,
        end: 13,
        kind: 'hit',
      },
      {
        id: '@demo/web#test',
        lane: 0,
        start: 13,
        end: 13,
        kind: 'hit',
      },
    ],
    workers: 0,
    end: 14,
  },
  'none-2': {
    bars: [
      {
        id: '@demo/ui#build',
        lane: 0,
        start: 15,
        end: 18,
        kind: 'hit',
      },
      {
        id: '@demo/web#build',
        lane: 0,
        start: 21,
        end: 22,
        kind: 'hit',
      },
      {
        id: '@demo/ui#test',
        lane: 0,
        start: 23,
        end: 23,
        kind: 'hit',
      },
      {
        id: '@demo/ui#lint',
        lane: 0,
        start: 24,
        end: 24,
        kind: 'hit',
      },
      {
        id: '@demo/web#lint',
        lane: 0,
        start: 24,
        end: 24,
        kind: 'hit',
      },
      {
        id: '@demo/web#test',
        lane: 0,
        start: 24,
        end: 24,
        kind: 'hit',
      },
    ],
    workers: 0,
    end: 26,
  },
  'none-3': {
    bars: [
      {
        id: '@demo/ui#build',
        lane: 0,
        start: 11,
        end: 13,
        kind: 'hit',
      },
      {
        id: '@demo/web#build',
        lane: 0,
        start: 17,
        end: 23,
        kind: 'hit',
      },
      {
        id: '@demo/ui#test',
        lane: 0,
        start: 18,
        end: 18,
        kind: 'hit',
      },
      {
        id: '@demo/web#test',
        lane: 0,
        start: 18,
        end: 18,
        kind: 'hit',
      },
      {
        id: '@demo/ui#lint',
        lane: 0,
        start: 19,
        end: 19,
        kind: 'hit',
      },
      {
        id: '@demo/web#lint',
        lane: 0,
        start: 19,
        end: 19,
        kind: 'hit',
      },
    ],
    workers: 0,
    end: 24,
  },
}

export const project = (id: string): string =>
  id.startsWith('@demo/ui') ? 'ui' : id.startsWith('@demo/web') ? 'web' : ''

// The tasks on the run's longest path of tasks that wait on each other:
// no number of workers ends it sooner.
export function longest(run: Run): Set<string> {
  const ms = new Map(run.bars.filter((b) => b.kind === 'task').map((b) => [b.id, b.end - b.start]))
  const after = (id: string) => [...ms.keys()].filter((x) => NEEDS[x]?.includes(id))
  const length = (id: string): number => ms.get(id)! + Math.max(0, ...after(id).map(length))
  const path = (id: string): string[] => {
    const next = after(id).sort((a, b) => length(b) - length(a))[0]
    return [id, ...(next ? path(next) : [])]
  }
  const roots = [...ms.keys()].filter((id) => !NEEDS[id]?.some((d) => ms.has(d)))
  const top = roots.sort((a, b) => length(b) - length(a))[0]
  return new Set(top ? path(top) : [])
}

export const rows = (run: Run): number => Math.max(1, ...run.bars.map((b) => (b.slot ?? 0) + 1))

export const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)}s`
