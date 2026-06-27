import { createMemo, createResource } from 'solid-js'
import { useParams } from '@solidjs/router'
import { type RunSummaryRow, type TaskDetail as TaskDetailData, getOriginSignal, getTaskDetail } from '../api.ts'
import { type Node, el, toSpec } from '../jr/spec.ts'
import { DashRenderer } from '../jr/renderer.tsx'
import { formatBytes, formatDuration, formatPercent, formatRelativeTime } from '../format.ts'

// CPU utilization = cpuMs / wall durationMs. >100% means the task used more than
// one core's worth of CPU (multithreaded). Cache hits are excluded (~0 duration
// → meaningless ratio).
function cpuPct(r: Pick<RunSummaryRow, 'cpuMs' | 'durationMs' | 'cacheHit'>): number | undefined {
  return r.cpuMs !== null && r.durationMs > 0 && r.cacheHit !== true ? (r.cpuMs / r.durationMs) * 100 : undefined
}

function build(taskId: string, detail: TaskDetailData | null | undefined): Node {
  const head = { backHref: '/tasks', backLabel: 'tasks', title: taskId, mono: true }
  if (detail === undefined) return el('Page', head, [el('Text', { text: 'Loading…', tone: 'faint' })])
  if (detail === null) return el('Page', head, [el('Empty', { title: 'No data for this task', cmd: `vx run ${taskId}` })])

  const agg = detail.aggregate
  const recent = detail.recent
  const cpuVals = recent.map(cpuPct).filter((v): v is number => v !== undefined && Number.isFinite(v))
  const cpu = cpuVals.length > 0 ? { avg: cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length, max: Math.max(...cpuVals) } : undefined
  const durSeries = [...recent].reverse()

  const metrics = agg
    ? el('Grid', { variant: 'metrics-6' }, [
        el('Metric', { label: 'Runs', value: String(agg.runs), sub: `${agg.successes} ok · ${agg.failures} fail` }),
        el('Metric', {
          label: 'Success rate',
          value: formatPercent(agg.successRate, 0),
          tone: agg.failureMode === 'stable' ? 'good' : agg.failureMode === 'flaky-fatal' ? 'bad' : 'warn',
          sub: agg.failureMode,
        }),
        el('Metric', { label: 'Hit rate', value: formatPercent(agg.hitRate, 0), sub: `${agg.hits} hits` }),
        el('Metric', {
          label: 'Avg duration',
          value: formatDuration(agg.avgDurationMs ?? 0),
          sub: `p50 ${formatDuration(agg.p50DurationMs ?? 0)} · p99 ${formatDuration(agg.p99DurationMs ?? 0)}`,
        }),
        el('Metric', {
          label: 'CPU usage',
          value: cpu ? `${cpu.avg.toFixed(0)}%` : '—',
          sub: cpu ? `avg · max ${cpu.max.toFixed(0)}%` : 'no timed runs',
        }),
        el('Metric', {
          label: 'Last run',
          value: agg.lastSeenAt !== undefined ? formatRelativeTime(agg.lastSeenAt) : '—',
          sub: `min ${formatDuration(agg.minDurationMs ?? 0)} · max ${formatDuration(agg.maxDurationMs ?? 0)}`,
        }),
      ])
    : undefined

  const durCard = el('Card', { title: 'Duration over recent runs', actionText: 'oldest → newest' }, [
    durSeries.length > 0
      ? el('LineChart', {
          xs: durSeries.map((_, i) => i),
          series: [{ name: 'duration', strokeClass: 'stroke-accent', areaClass: 'fill-accent/10', data: durSeries.map((r) => r.durationMs) }],
          yFormat: 'duration',
          height: 280,
        })
      : el('Empty', { title: 'No runs yet' }),
  ])

  const e = detail.latestEntry
  const latestCard = e
    ? el('Card', { title: 'Latest cache entry' }, [
        el('Facts', {
          items: [
            { label: 'hash', value: `${e.hash.slice(0, 16)}…`, mono: true },
            { label: 'size', value: formatBytes(e.sizeBytes) },
            { label: 'duration', value: formatDuration(e.durationMs) },
            { label: 'created', value: formatRelativeTime(e.createdAt) },
            { label: 'accessed', value: formatRelativeTime(e.accessedAt) },
            { label: 'exit', value: String(e.exitCode) },
          ],
          command: e.command,
        }),
      ])
    : undefined

  const table = el('Card', { title: `Recent runs (${recent.length})`, noPad: true }, [
    el('DataTable', {
      emptyTitle: 'No runs yet',
      columns: [
        { key: 'when', label: 'When' },
        { key: 'status', label: 'Status' },
        { key: 'duration', label: 'Duration', align: 'right' },
        { key: 'cpu', label: 'CPU', align: 'right' },
        { key: 'cpupct', label: 'CPU %', align: 'right' },
        { key: 'rss', label: 'Peak RSS', align: 'right' },
        { key: 'hash', label: 'Hash', align: 'right' },
      ],
      rows: recent.map((r) => {
        const pct = cpuPct(r)
        return {
          cells: {
            when: { kind: 'tone', v: formatRelativeTime(r.startedAt), tone: 'faint' },
            status: { kind: 'status', status: r.status, cacheHit: r.cacheHit },
            duration: formatDuration(r.durationMs),
            cpu: { kind: 'tone', v: r.cpuMs !== null ? formatDuration(r.cpuMs) : '—', tone: 'faint' },
            cpupct: { kind: 'tone', v: pct !== undefined ? `${pct.toFixed(0)}%` : '—', tone: pct !== undefined && pct > 100 ? 'success' : 'faint' },
            rss: { kind: 'tone', v: r.peakRssBytes !== null && r.peakRssBytes > 0 ? formatBytes(r.peakRssBytes) : '—', tone: 'faint' },
            hash: { kind: 'muted', v: `${r.hash.slice(0, 10)}…` },
          },
        }
      }),
    }),
  ])

  return el('Page', head, [metrics, durCard, latestCard, table])
}

export function TaskDetail() {
  const params = useParams<{ id: string }>()
  const taskId = () => decodeURIComponent(params.id)
  const origin = getOriginSignal()
  const [detail] = createResource(
    () => ({ id: taskId(), o: origin() }),
    (args) => getTaskDetail(args.id),
  )
  const spec = createMemo(() => toSpec(build(taskId(), detail())))
  return <DashRenderer spec={spec()} />
}
