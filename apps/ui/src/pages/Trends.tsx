import { createMemo, createResource } from 'solid-js'
import { getHeatmap, getOriginSignal, getParallelismHistory, getRunTrends, getStorageGrowth } from '../api.ts'
import { S, el, toSpec } from '../jr/spec.ts'
import { Dash } from '../jr/renderer.tsx'
import { formatDuration } from '../format.ts'

const showIf = (flag: string) => ({ visible: { $state: flag, eq: true } })
const hideIf = (flag: string) => ({ visible: { $state: flag, eq: false } })

const SPEC = toSpec(
  el('Page', { title: 'Trends', subtitle: 'Patterns over time — when builds happen, how the cache grows, how parallel you run.' }, [
    el('Card', { title: 'Runs per day (last 30d)' }, [
      el('LineChart', {
        xs: S('/trendXs'),
        series: [
          { name: 'runs', strokeClass: 'stroke-accent', areaClass: 'fill-accent/10', data: S('/trendRuns') },
          { name: 'hits', strokeClass: 'stroke-cache-local', data: S('/trendHits') },
          { name: 'failures', strokeClass: 'stroke-danger', data: S('/trendFailures') },
        ],
        xFormat: 'date',
        yFormat: 'count',
        height: 320,
      }, undefined, showIf('/hasTrend')),
      el('Empty', { title: 'No data yet' }, undefined, hideIf('/hasTrend')),
    ]),

    el('Grid', { variant: 'main-320' }, [
      el('Card', { title: 'Total duration per day (last 30d)' }, [
        el('LineChart', {
          xs: S('/trendXs'),
          series: [{ name: 'duration', strokeClass: 'stroke-info', areaClass: 'fill-info/10', data: S('/trendDuration') }],
          xFormat: 'date',
          yFormat: 'duration',
          height: 320,
        }, undefined, showIf('/hasTrend')),
        el('Empty', { title: 'No data' }, undefined, hideIf('/hasTrend')),
      ]),
      el('Card', { title: 'When you build', actionText: 'last 30d' }, [
        el('Heatmap', { data: S('/heat'), cellSize: 14 }, undefined, showIf('/hasHeat')),
        el('Empty', { title: 'No runs in the window' }, undefined, hideIf('/hasHeat')),
      ]),
    ]),

    el('Card', { title: 'Cache storage growth (entries added per day)' }, [
      el('LineChart', {
        xs: S('/storageXs'),
        series: [{ name: 'bytes', strokeClass: 'stroke-accent-2', areaClass: 'fill-accent-2/10', data: S('/storageData') }],
        xFormat: 'date',
        yFormat: 'bytes',
        height: 280,
      }, undefined, showIf('/hasStorage')),
      el('Empty', { title: 'No cached output yet' }, undefined, hideIf('/hasStorage')),
    ]),

    el('Card', { title: 'Parallelism factor per invocation', actionText: 'cpu sum / wall time — 1.0 = serial' }, [
      el('Stack', { gap: '4' }, [
        el('Grid', { variant: 'cols-3' }, [
          el('Metric', { label: 'Avg parallelism', value: S('/parAvg'), sub: 'across recent runs' }),
          el('Metric', { label: 'Best invocation', value: S('/parBest') }),
          el('Metric', { label: 'Total CPU time', value: S('/parTotal') }),
        ]),
        el('LineChart', {
          xs: S('/parXs'),
          series: [{ name: 'parallelism', strokeClass: 'stroke-chart-3', areaClass: 'fill-chart-3/10', data: S('/parData') }],
          xFormat: 'date',
          yFormat: 'multiplier',
          height: 240,
        }),
      ], showIf('/hasParallel')),
      el('Empty', { title: 'No invocations recorded' }, undefined, hideIf('/hasParallel')),
    ]),
  ]),
)

export function Trends() {
  const origin = getOriginSignal()
  const [trend] = createResource(origin, () => getRunTrends({ bucket: 'day' }))
  const [storage] = createResource(origin, () => getStorageGrowth(30))
  const [heat] = createResource(origin, () => getHeatmap(30))
  const [parallel] = createResource(origin, () => getParallelismHistory(50))

  const state = createMemo<Record<string, unknown>>(() => {
    const tr = trend()?.points ?? []
    const sg = storage() ?? []
    const hm = heat() ?? []
    const par = parallel() ?? []
    const parAsc = [...par].reverse()
    return {
      hasTrend: tr.length > 0,
      trendXs: tr.map((p) => p.t),
      trendRuns: tr.map((p) => p.runs),
      trendHits: tr.map((p) => p.hits),
      trendFailures: tr.map((p) => p.failures),
      trendDuration: tr.map((p) => p.totalDurationMs),
      hasHeat: hm.some((c) => c.runs > 0),
      heat: hm.map((c) => ({ dayOfWeek: c.dayOfWeek, hourOfDay: c.hourOfDay, value: c.runs })),
      hasStorage: sg.length > 0,
      storageXs: sg.map((p) => p.t),
      storageData: sg.map((p) => p.bytesAdded),
      hasParallel: par.length > 0,
      parXs: parAsc.map((p) => p.startedAt),
      parData: parAsc.map((p) => p.factor),
      parAvg: `${(par.reduce((a, p) => a + p.factor, 0) / Math.max(1, par.length)).toFixed(2)}×`,
      parBest: `${Math.max(0, ...par.map((p) => p.factor)).toFixed(2)}×`,
      parTotal: formatDuration(par.reduce((a, p) => a + p.cpuSumMs, 0)),
    }
  })

  return <Dash spec={SPEC} state={state()} />
}
