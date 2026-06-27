import { createMemo, createResource } from 'solid-js'
import {
  getCacheSavings,
  getCacheStats,
  getFailures,
  getOriginSignal,
  getRunTrends,
  getTopTasks,
  listInvocations,
  listProjects,
} from '../api.ts'
import { C, S, T, el, toSpec } from '../jr/spec.ts'
import { Dash } from '../jr/renderer.tsx'
import { formatDuration, paletteFor } from '../format.ts'

const enc = encodeURIComponent

// Static spec — data-independent. Props bind to the page's raw `state` via
// $state / $computed / $template; sections gate on boolean flags via `visible`.
const SPEC = toSpec(
  el('Page', {}, [
    el(
      'Grid',
      { variant: 'metrics-4' },
      [
        el('Metric', { label: 'Time saved', value: C('fmtDuration', { ms: S('/savedMs') }), sub: T('${totalHits} cache hits'), tone: S('/savedTone') }),
        el('Metric', { label: 'Hit rate', value: C('fmtPercent0', { n: S('/hitRate') }), sub: T('${totalHits} / ${totalRuns} runs'), tone: S('/hitTone') }),
        el('Metric', { label: 'Total runs', value: C('fmtNumber', { n: S('/totalRuns') }), sub: S('/runsSub'), tone: S('/runsTone') }),
        el('Metric', { label: 'Cache footprint', value: C('fmtBytes', { b: S('/totalBytes') }), sub: T('${entryCount} entries') }),
      ],
      { visible: { $state: '/loaded', eq: true } },
    ),

    el('Grid', { variant: 'main-280' }, [
      el('Card', { title: 'Activity — last 30 days', actionText: 'runs · failures' }, [
        el(
          'LineChart',
          {
            xs: S('/trendXs'),
            series: [
              { name: 'runs', strokeClass: 'stroke-accent', areaClass: 'fill-accent/10', data: S('/trendRuns') },
              { name: 'failures', strokeClass: 'stroke-danger', data: S('/trendFailures') },
            ],
            xFormat: 'date',
            yFormat: 'count',
            height: 300,
          },
          undefined,
          { visible: { $state: '/hasTrend', eq: true } },
        ),
        el('Text', { text: S('/trendSummary'), tone: 'faint', mono: true, class: 'mt-2' }, undefined, { visible: { $state: '/hasTrend', eq: true } }),
        el('Empty', { title: 'No runs in the last 30 days', cmd: 'vx run <task>' }, undefined, { visible: { $state: '/hasTrend', eq: false } }),
      ]),
      el('Card', { title: 'Live activity', actionText: 'SSE' }, [el('LiveActivity', {})]),
    ]),

    el('Grid', { variant: 'cols-2' }, [
      el('Card', { title: 'Top time-burners', actionHref: '/tasks', actionLabel: 'all tasks', noPad: true }, [
        el('RankList', {
          items: S('/topTasks'),
          labelKey: 'id',
          valueKey: 'totalDurationMs',
          valueFormat: 'duration',
          indexed: true,
          metaKey: 'runs',
          metaSuffix: '×',
          emptyTitle: 'Nothing executed yet',
          emptyCmd: 'vx run <task>',
        }),
      ]),
      el('Card', { title: 'Recent failures', actionHref: '/tasks', actionLabel: 'all tasks', noPad: true }, [
        el('RankList', {
          items: S('/failures'),
          labelKey: '_label',
          valueKey: 'startedAt',
          valueFormat: 'relativeTime',
          metaKey: 'exitCode',
          metaPrefix: 'exit ',
          emptyTitle: 'No failures 🎉',
        }),
      ]),
    ]),

    el('Grid', { variant: 'main-320' }, [
      el('Card', { title: 'Cache footprint by project', actionHref: '/cache', actionLabel: 'cache' }, [
        el('Treemap', { data: S('/treemap'), height: 240, valueFormat: 'bytes' }, undefined, { visible: { $state: '/hasTreemap', eq: true } }),
        el('Empty', { title: 'No cached output yet' }, undefined, { visible: { $state: '/hasTreemap', eq: false } }),
      ]),
      el('Card', { title: 'Project leaderboard', actionHref: '/projects', actionLabel: 'all', noPad: true }, [
        el('RankList', {
          items: S('/leaderboard'),
          labelKey: 'project',
          valueKey: 'totalDurationMs',
          valueFormat: 'duration',
          metaKey: 'runs',
          metaSuffix: '×',
          emptyTitle: 'No projects discovered',
        }),
      ]),
    ]),

    el('Card', { title: 'Recent invocations', noPad: true }, [
      el('DataTable', {
        rows: S('/invocations'),
        rowHrefKey: '_href',
        emptyTitle: 'No invocations yet',
        emptyCmd: 'vx run <task>',
        columns: [
          { key: '_runShort', label: 'Run', kind: 'faint' },
          { key: 'startedAt', label: 'Started', align: 'right', kind: 'relativeTime', tone: { gt: 0, tone: 'faint', else: 'faint' } },
          { key: 'totalDurationMs', label: 'Duration', align: 'right', kind: 'duration' },
          { key: 'taskCount', label: 'Tasks', align: 'right' },
          { key: 'failedCount', label: 'Failed', align: 'right', tone: { gt: 0, tone: 'danger' } },
          { key: 'hitCount', label: 'Hits', align: 'right', kind: 'mono', tone: { ge: 0, tone: 'cache' } },
        ],
      }),
    ]),
  ]),
)

export function Overview() {
  const origin = getOriginSignal()
  const [stats] = createResource(origin, () => getCacheStats())
  const [savings] = createResource(origin, () => getCacheSavings())
  const [topTasks] = createResource(origin, () => getTopTasks(8))
  const [failures] = createResource(origin, () => getFailures(8))
  const [projects] = createResource(origin, () => listProjects(50))
  const [invocations] = createResource(origin, () => listInvocations(12))
  const [trend] = createResource(origin, () => getRunTrends({ bucket: 'day' }))

  const state = createMemo<Record<string, unknown>>(() => {
    const ps = projects() ?? []
    const tr = trend()?.points ?? []
    const totalRuns = ps.reduce((a, p) => a + p.runs, 0)
    const totalHits = ps.reduce((a, p) => a + p.hits, 0)
    const totalFails = ps.reduce((a, p) => a + p.failures, 0)
    const hitRate = totalRuns > 0 ? totalHits / totalRuns : 0
    const maxTime = Math.max(1, ...ps.map((p) => p.totalDurationMs))
    const trendRuns = tr.reduce((a, p) => a + p.runs, 0)
    const trendDur = tr.reduce((a, p) => a + p.totalDurationMs, 0)
    const trendHits = tr.reduce((a, p) => a + p.hits, 0)
    const sv = savings()
    const st = stats()
    return {
      loaded: !!(st && sv),
      savedMs: sv?.estimatedTimeSavedTotalMs ?? 0,
      savedTone: (sv?.estimatedTimeSavedTotalMs ?? 0) > 0 ? 'good' : 'default',
      totalHits,
      totalRuns,
      hitRate,
      hitTone: hitRate > 0.5 ? 'good' : hitRate < 0.2 && totalRuns > 5 ? 'warn' : 'default',
      runsSub: totalFails > 0 ? `${totalFails} failed` : 'no failures',
      runsTone: totalFails > 0 ? 'bad' : 'good',
      totalBytes: st?.totalBytes ?? 0,
      entryCount: st?.entryCount ?? 0,
      hasTrend: trendRuns > 0,
      trendXs: tr.map((p) => p.t),
      trendRuns: tr.map((p) => p.runs),
      trendFailures: tr.map((p) => p.failures),
      trendSummary: `${trendRuns} runs · ${formatDuration(trendDur)} total · ${trendHits} hits`,
      topTasks: (topTasks() ?? []).map((t) => ({ ...t, _href: `/tasks/${enc(t.id)}` })),
      failures: (failures() ?? []).map((f) => ({ ...f, _label: `${f.project}#${f.task}`, _href: `/tasks/${enc(`${f.project}#${f.task}`)}` })),
      hasTreemap: ps.some((p) => p.cacheBytes > 0),
      treemap: ps.filter((p) => p.cacheBytes > 0).map((p) => ({ label: p.project, value: p.cacheBytes, colorClass: `fill-${paletteFor(p.project)}` })),
      leaderboard: ps.slice(0, 6).map((p) => ({
        project: p.project,
        runs: p.runs,
        totalDurationMs: p.totalDurationMs,
        _frac: p.totalDurationMs / maxTime,
        _color: paletteFor(p.project),
        _href: `/projects/${enc(p.project)}`,
      })),
      invocations: (invocations() ?? []).map((r) => ({ ...r, _runShort: `${r.runId.slice(0, 8)}…`, _href: `/runs/${r.runId}` })),
    }
  })

  return <Dash spec={SPEC} state={state()} />
}
