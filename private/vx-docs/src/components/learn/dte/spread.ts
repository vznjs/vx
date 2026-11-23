// The data behind <DteSpread>: nine real runs of the demo workspace's
// `vx run build test lint --all` over local() workers (2-core machines,
// 2026-11-23), one per push (every task changed, an edit in apps/web,
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
        start: 100,
        end: 400,
        kind: 'warm',
      },
      {
        id: '@demo/ui#test',
        lane: 1,
        start: 349,
        end: 971,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/ui#build',
        lane: 1,
        start: 413,
        end: 737,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/ui#lint',
        lane: 1,
        start: 736,
        end: 828,
        kind: 'task',
        slot: 2,
      },
      {
        id: '@demo/web#test',
        lane: 1,
        start: 852,
        end: 1306,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#build',
        lane: 1,
        start: 989,
        end: 1260,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/web#lint',
        lane: 1,
        start: 1275,
        end: 1334,
        kind: 'task',
        slot: 0,
      },
    ],
    workers: 1,
    end: 1337,
  },
  'all-2': {
    bars: [
      {
        id: 'worker 1',
        lane: 1,
        start: 100,
        end: 300,
        kind: 'warm',
      },
      {
        id: 'worker 2',
        lane: 2,
        start: 300,
        end: 600,
        kind: 'warm',
      },
      {
        id: '@demo/ui#test',
        lane: 1,
        start: 333,
        end: 893,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/ui#build',
        lane: 1,
        start: 397,
        end: 737,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/ui#lint',
        lane: 2,
        start: 634,
        end: 712,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/web#lint',
        lane: 2,
        start: 639,
        end: 722,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#build',
        lane: 1,
        start: 762,
        end: 1049,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#test',
        lane: 2,
        start: 772,
        end: 1214,
        kind: 'task',
        slot: 0,
      },
    ],
    workers: 2,
    end: 1217,
  },
  'all-3': {
    bars: [
      {
        id: 'worker 1',
        lane: 1,
        start: 100,
        end: 400,
        kind: 'warm',
      },
      {
        id: 'worker 2',
        lane: 2,
        start: 300,
        end: 600,
        kind: 'warm',
      },
      {
        id: 'worker 3',
        lane: 3,
        start: 400,
        end: 700,
        kind: 'warm',
      },
      {
        id: '@demo/ui#test',
        lane: 1,
        start: 359,
        end: 968,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/ui#build',
        lane: 1,
        start: 405,
        end: 802,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/ui#lint',
        lane: 2,
        start: 749,
        end: 830,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/web#lint',
        lane: 3,
        start: 796,
        end: 887,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/web#test',
        lane: 1,
        start: 849,
        end: 1380,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#build',
        lane: 3,
        start: 905,
        end: 1324,
        kind: 'task',
        slot: 0,
      },
    ],
    workers: 3,
    end: 1384,
  },
  'web-1': {
    bars: [
      {
        id: 'worker 1',
        lane: 1,
        start: 100,
        end: 400,
        kind: 'warm',
      },
      {
        id: '@demo/ui#build',
        lane: 0,
        start: 39,
        end: 41,
        kind: 'hit',
      },
      {
        id: '@demo/ui#test',
        lane: 0,
        start: 44,
        end: 44,
        kind: 'hit',
      },
      {
        id: '@demo/ui#lint',
        lane: 0,
        start: 45,
        end: 45,
        kind: 'hit',
      },
      {
        id: '@demo/web#test',
        lane: 1,
        start: 432,
        end: 858,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/web#build',
        lane: 1,
        start: 441,
        end: 847,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#lint',
        lane: 1,
        start: 884,
        end: 930,
        kind: 'task',
        slot: 0,
      },
    ],
    workers: 1,
    end: 934,
  },
  'web-2': {
    bars: [
      {
        id: 'worker 1',
        lane: 1,
        start: 100,
        end: 400,
        kind: 'warm',
      },
      {
        id: 'worker 2',
        lane: 2,
        start: 100,
        end: 400,
        kind: 'warm',
      },
      {
        id: '@demo/ui#build',
        lane: 0,
        start: 33,
        end: 35,
        kind: 'hit',
      },
      {
        id: '@demo/ui#lint',
        lane: 0,
        start: 39,
        end: 39,
        kind: 'hit',
      },
      {
        id: '@demo/ui#test',
        lane: 0,
        start: 39,
        end: 39,
        kind: 'hit',
      },
      {
        id: '@demo/web#test',
        lane: 1,
        start: 422,
        end: 900,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/web#lint',
        lane: 1,
        start: 424,
        end: 517,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#build',
        lane: 2,
        start: 444,
        end: 802,
        kind: 'task',
        slot: 0,
      },
    ],
    workers: 2,
    end: 904,
  },
  'web-3': {
    bars: [
      {
        id: 'worker 1',
        lane: 1,
        start: 100,
        end: 400,
        kind: 'warm',
      },
      {
        id: 'worker 2',
        lane: 2,
        start: 100,
        end: 400,
        kind: 'warm',
      },
      {
        id: '@demo/ui#build',
        lane: 0,
        start: 36,
        end: 38,
        kind: 'hit',
      },
      {
        id: '@demo/ui#test',
        lane: 0,
        start: 42,
        end: 42,
        kind: 'hit',
      },
      {
        id: '@demo/ui#lint',
        lane: 0,
        start: 43,
        end: 43,
        kind: 'hit',
      },
      {
        id: '@demo/web#lint',
        lane: 1,
        start: 414,
        end: 518,
        kind: 'task',
        slot: 0,
      },
      {
        id: '@demo/web#test',
        lane: 1,
        start: 418,
        end: 926,
        kind: 'task',
        slot: 1,
      },
      {
        id: '@demo/web#build',
        lane: 2,
        start: 435,
        end: 886,
        kind: 'task',
        slot: 0,
      },
    ],
    workers: 2,
    end: 932,
  },
  'none-1': {
    bars: [
      {
        id: '@demo/ui#build',
        lane: 0,
        start: 18,
        end: 20,
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
        id: '@demo/web#build',
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
    end: 25,
  },
  'none-2': {
    bars: [
      {
        id: '@demo/ui#build',
        lane: 0,
        start: 19,
        end: 21,
        kind: 'hit',
      },
      {
        id: '@demo/web#build',
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
        id: '@demo/ui#test',
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
        start: 27,
        end: 30,
        kind: 'hit',
      },
      {
        id: '@demo/web#build',
        lane: 0,
        start: 34,
        end: 43,
        kind: 'hit',
      },
      {
        id: '@demo/ui#test',
        lane: 0,
        start: 37,
        end: 37,
        kind: 'hit',
      },
      {
        id: '@demo/web#test',
        lane: 0,
        start: 37,
        end: 37,
        kind: 'hit',
      },
      {
        id: '@demo/ui#lint',
        lane: 0,
        start: 38,
        end: 38,
        kind: 'hit',
      },
      {
        id: '@demo/web#lint',
        lane: 0,
        start: 38,
        end: 38,
        kind: 'hit',
      },
    ],
    workers: 0,
    end: 46,
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
