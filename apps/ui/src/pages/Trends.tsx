import { createMemo, createResource } from 'solid-js'
import {
  type HeatmapCellApi,
  type ParallelismPoint,
  type StoragePoint,
  type TrendPoint,
  getHeatmap,
  getOriginSignal,
  getParallelismHistory,
  getRunTrends,
  getStorageGrowth,
} from '../api.ts'
import { type Node, el, toSpec } from '../jr/spec.ts'
import { DashRenderer } from '../jr/renderer.tsx'
import { formatDuration } from '../format.ts'

interface Data {
  trend?: TrendPoint[]
  storage?: StoragePoint[]
  heat?: HeatmapCellApi[]
  parallel?: ParallelismPoint[]
}

function build(d: Data): Node {
  const trend = d.trend ?? []
  const storage = d.storage ?? []
  const heat = d.heat ?? []
  const parallel = d.parallel ?? []
  const parAsc = [...parallel].reverse()

  const runsCard = el('Card', { title: 'Runs per day (last 30d)' }, [
    trend.length > 0
      ? el('LineChart', {
          xs: trend.map((p) => p.t),
          series: [
            { name: 'runs', strokeClass: 'stroke-accent', areaClass: 'fill-accent/10', data: trend.map((p) => p.runs) },
            { name: 'hits', strokeClass: 'stroke-cache-local', data: trend.map((p) => p.hits) },
            { name: 'failures', strokeClass: 'stroke-danger', data: trend.map((p) => p.failures) },
          ],
          xFormat: 'date',
          yFormat: 'count',
          height: 320,
        })
      : el('Empty', { title: 'No data yet' }),
  ])

  const durationCard = el('Card', { title: 'Total duration per day (last 30d)' }, [
    trend.length > 0
      ? el('LineChart', {
          xs: trend.map((p) => p.t),
          series: [{ name: 'duration', strokeClass: 'stroke-info', areaClass: 'fill-info/10', data: trend.map((p) => p.totalDurationMs) }],
          xFormat: 'date',
          yFormat: 'duration',
          height: 320,
        })
      : el('Empty', { title: 'No data' }),
  ])

  const heatCard = el('Card', { title: 'When you build', actionText: 'last 30d' }, [
    heat.some((c) => c.runs > 0)
      ? el('Heatmap', { data: heat.map((c) => ({ dayOfWeek: c.dayOfWeek, hourOfDay: c.hourOfDay, value: c.runs })), cellSize: 14 })
      : el('Empty', { title: 'No runs in the window' }),
  ])

  const storageCard = el('Card', { title: 'Cache storage growth (entries added per day)' }, [
    storage.length > 0
      ? el('LineChart', {
          xs: storage.map((p) => p.t),
          series: [{ name: 'bytes', strokeClass: 'stroke-accent-2', areaClass: 'fill-accent-2/10', data: storage.map((p) => p.bytesAdded) }],
          xFormat: 'date',
          yFormat: 'bytes',
          height: 280,
        })
      : el('Empty', { title: 'No cached output yet' }),
  ])

  const parChildren: Array<Node | false> = [
    el('Grid', { variant: 'cols-3' }, [
      el('Metric', {
        label: 'Avg parallelism',
        value: `${(parallel.reduce((a, p) => a + p.factor, 0) / Math.max(1, parallel.length)).toFixed(2)}×`,
        sub: 'across recent runs',
      }),
      el('Metric', { label: 'Best invocation', value: `${Math.max(0, ...parallel.map((p) => p.factor)).toFixed(2)}×` }),
      el('Metric', { label: 'Total CPU time', value: formatDuration(parallel.reduce((a, p) => a + p.cpuSumMs, 0)) }),
    ]),
    el('LineChart', {
      xs: parAsc.map((p) => p.startedAt),
      series: [{ name: 'parallelism', strokeClass: 'stroke-chart-3', areaClass: 'fill-chart-3/10', data: parAsc.map((p) => p.factor) }],
      xFormat: 'date',
      yFormat: 'multiplier',
      height: 240,
    }),
  ]
  const parallelCard = el('Card', { title: 'Parallelism factor per invocation', actionText: 'cpu sum / wall time — 1.0 = serial' }, [
    parallel.length > 0 ? el('Stack', { gap: '4' }, parChildren) : el('Empty', { title: 'No invocations recorded' }),
  ])

  return el('Page', { title: 'Trends', subtitle: 'Patterns over time — when builds happen, how the cache grows, how parallel you run.' }, [
    runsCard,
    el('Grid', { variant: 'main-320' }, [durationCard, heatCard]),
    storageCard,
    parallelCard,
  ])
}

export function Trends() {
  const origin = getOriginSignal()
  const [trend] = createResource(origin, () => getRunTrends({ bucket: 'day' }))
  const [storage] = createResource(origin, () => getStorageGrowth(30))
  const [heat] = createResource(origin, () => getHeatmap(30))
  const [parallel] = createResource(origin, () => getParallelismHistory(50))
  const spec = createMemo(() => toSpec(build({ trend: trend()?.points, storage: storage(), heat: heat(), parallel: parallel() })))
  return <DashRenderer spec={spec()} />
}
