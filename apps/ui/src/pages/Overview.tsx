import { createMemo, createResource } from 'solid-js'
import {
  type CacheSavings,
  type CacheStats,
  type FailureRow,
  type InvocationRow,
  type ProjectRollup,
  type TopTaskRow,
  type TrendPoint,
  getCacheSavings,
  getCacheStats,
  getFailures,
  getOriginSignal,
  getRunTrends,
  getTopTasks,
  listInvocations,
  listProjects,
} from '../api.ts'
import { type Node, el, toSpec } from '../jr/spec.ts'
import { DashRenderer } from '../jr/renderer.tsx'
import { formatBytes, formatDuration, formatPercent, formatRelativeTime, paletteFor } from '../format.ts'

interface Data {
  stats?: CacheStats
  savings?: CacheSavings
  topTasks?: TopTaskRow[]
  failures?: FailureRow[]
  projects?: ProjectRollup[]
  invocations?: InvocationRow[]
  trend?: TrendPoint[]
}

const enc = encodeURIComponent

function build(d: Data): Node {
  const projects = d.projects ?? []
  const trend = d.trend ?? []
  const totalRuns = projects.reduce((a, p) => a + p.runs, 0)
  const totalHits = projects.reduce((a, p) => a + p.hits, 0)
  const totalFails = projects.reduce((a, p) => a + p.failures, 0)
  const hitRate = totalRuns > 0 ? totalHits / totalRuns : 0
  const last30dRuns = trend.reduce((a, p) => a + p.runs, 0)
  const last30dDur = trend.reduce((a, p) => a + p.totalDurationMs, 0)
  const last30dHits = trend.reduce((a, p) => a + p.hits, 0)
  const maxTime = Math.max(1, ...projects.map((p) => p.totalDurationMs))

  const metrics =
    d.stats && d.savings
      ? el('Grid', { variant: 'metrics-4' }, [
          el('Metric', {
            label: 'Time saved',
            value: formatDuration(d.savings.estimatedTimeSavedTotalMs),
            sub: `${totalHits} cache hits`,
            tone: d.savings.estimatedTimeSavedTotalMs > 0 ? 'good' : 'default',
          }),
          el('Metric', {
            label: 'Hit rate',
            value: formatPercent(hitRate, 0),
            sub: `${totalHits} / ${totalRuns} runs`,
            tone: hitRate > 0.5 ? 'good' : hitRate < 0.2 && totalRuns > 5 ? 'warn' : 'default',
          }),
          el('Metric', {
            label: 'Total runs',
            value: String(totalRuns),
            sub: totalFails > 0 ? `${totalFails} failed (${formatPercent(totalFails / Math.max(1, totalRuns), 0)})` : 'no failures',
            tone: totalFails > 0 ? 'bad' : 'good',
          }),
          el('Metric', {
            label: 'Cache footprint',
            value: formatBytes(d.stats.totalBytes),
            sub: `${d.stats.entryCount} entries`,
          }),
        ])
      : undefined

  const activityCard = el('Card', { title: 'Activity — last 30 days', actionText: 'runs · failures' }, [
    last30dRuns > 0
      ? el('LineChart', {
          xs: trend.map((p) => p.t),
          series: [
            { name: 'runs', strokeClass: 'stroke-accent', areaClass: 'fill-accent/10', data: trend.map((p) => p.runs) },
            { name: 'failures', strokeClass: 'stroke-danger', data: trend.map((p) => p.failures) },
          ],
          xFormat: 'date',
          yFormat: 'count',
          height: 300,
        })
      : el('Empty', { title: 'No runs in the last 30 days', cmd: 'vx run <task>' }),
    last30dRuns > 0 &&
      el('Text', {
        text: `${last30dRuns} runs · ${formatDuration(last30dDur)} total · ${last30dHits} hits`,
        tone: 'faint',
        mono: true,
        class: 'mt-2',
      }),
  ])

  const liveCard = el('Card', { title: 'Live activity', actionText: 'SSE' }, [el('LiveActivity', {})])

  const topBurners = el('Card', { title: 'Top time-burners', actionHref: '/tasks', actionLabel: 'all tasks', noPad: true }, [
    el('RankList', {
      emptyTitle: 'Nothing executed yet',
      emptyCmd: 'vx run <task>',
      items: (d.topTasks ?? []).map((t, i) => ({
        index: i + 1,
        label: t.id,
        metaRight: `${t.runs}×`,
        value: formatDuration(t.totalDurationMs),
        href: `/tasks/${enc(t.id)}`,
      })),
    }),
  ])

  const failuresCard = el('Card', { title: 'Recent failures', actionHref: '/tasks', actionLabel: 'all tasks', noPad: true }, [
    el('RankList', {
      emptyTitle: 'No failures 🎉',
      items: (d.failures ?? []).map((f) => ({
        label: `${f.project}#${f.task}`,
        metaRight: `exit ${f.exitCode}`,
        value: formatRelativeTime(f.startedAt),
        href: `/tasks/${enc(`${f.project}#${f.task}`)}`,
      })),
    }),
  ])

  const treemapCard = el('Card', { title: 'Cache footprint by project', actionHref: '/cache', actionLabel: 'cache' }, [
    projects.some((p) => p.cacheBytes > 0)
      ? el('Treemap', {
          data: projects
            .filter((p) => p.cacheBytes > 0)
            .map((p) => ({ label: p.project, value: p.cacheBytes, colorClass: `fill-${paletteFor(p.project)}` })),
          height: 240,
          valueFormat: 'bytes',
        })
      : el('Empty', { title: 'No cached output yet' }),
  ])

  const leaderboard = el('Card', { title: 'Project leaderboard', actionHref: '/projects', actionLabel: 'all', noPad: true }, [
    el('RankList', {
      emptyTitle: 'No projects discovered',
      items: projects.slice(0, 6).map((p) => ({
        label: p.project,
        metaRight: `${p.runs}×`,
        value: formatDuration(p.totalDurationMs),
        fraction: p.totalDurationMs / maxTime,
        color: paletteFor(p.project),
        href: `/projects/${enc(p.project)}`,
      })),
    }),
  ])

  const invocations = el('Card', { title: 'Recent invocations', noPad: true }, [
    el('DataTable', {
      emptyTitle: 'No invocations yet',
      emptyCmd: 'vx run <task>',
      columns: [
        { key: 'run', label: 'Run' },
        { key: 'started', label: 'Started', align: 'right' },
        { key: 'duration', label: 'Duration', align: 'right' },
        { key: 'tasks', label: 'Tasks', align: 'right' },
        { key: 'failed', label: 'Failed', align: 'right' },
        { key: 'hits', label: 'Hits', align: 'right' },
      ],
      rows: (d.invocations ?? []).map((r) => ({
        href: `/runs/${r.runId}`,
        cells: {
          run: { kind: 'tone', v: `${r.runId.slice(0, 8)}…`, tone: 'muted' },
          started: { kind: 'tone', v: formatRelativeTime(r.startedAt), tone: 'faint' },
          duration: formatDuration(r.totalDurationMs),
          tasks: String(r.taskCount),
          failed: { kind: 'tone', v: String(r.failedCount), tone: r.failedCount > 0 ? 'danger' : 'default' },
          hits: { kind: 'tone', v: String(r.hitCount), tone: 'cache' },
        },
      })),
    }),
  ])

  return el('Page', {}, [
    metrics,
    el('Grid', { variant: 'main-280' }, [activityCard, liveCard]),
    el('Grid', { variant: 'cols-2' }, [topBurners, failuresCard]),
    el('Grid', { variant: 'main-320' }, [treemapCard, leaderboard]),
    invocations,
  ])
}

export function Overview() {
  const origin = getOriginSignal()
  const [stats] = createResource(origin, () => getCacheStats())
  const [savings] = createResource(origin, () => getCacheSavings())
  const [topTasks] = createResource(origin, () => getTopTasks(8))
  const [failures] = createResource(origin, () => getFailures(8))
  const [projects] = createResource(origin, () => listProjects(50))
  const [invocations] = createResource(origin, () => listInvocations(12))
  const [trend] = createResource(origin, () => getRunTrends({ bucket: 'day' }))

  const spec = createMemo(() =>
    toSpec(
      build({
        stats: stats(),
        savings: savings(),
        topTasks: topTasks(),
        failures: failures(),
        projects: projects(),
        invocations: invocations(),
        trend: trend()?.points,
      }),
    ),
  )

  return <DashRenderer spec={spec()} />
}
