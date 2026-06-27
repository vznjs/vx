import { createMemo, createResource } from 'solid-js'
import { useParams } from '@solidjs/router'
import { type RunSummaryRow, getOriginSignal, getTaskDetail } from '../api.ts'
import { C, S, T, el, toSpec } from '../jr/spec.ts'
import { Dash } from '../jr/renderer.tsx'
import { formatBytes, formatDuration, formatRelativeTime } from '../format.ts'

// CPU utilization = cpuMs / wall durationMs (>100% = multi-core). Cache hits
// excluded (~0 duration → meaningless ratio).
function cpuPct(r: Pick<RunSummaryRow, 'cpuMs' | 'durationMs' | 'cacheHit'>): number | undefined {
  return r.cpuMs !== null && r.durationMs > 0 && r.cacheHit !== true ? (r.cpuMs / r.durationMs) * 100 : undefined
}

const vis = (s: string) => ({ visible: { $state: '/status', eq: s } })

const SPEC = toSpec(
  el('Page', { backHref: '/tasks', backLabel: 'tasks', title: S('/taskId'), mono: true }, [
    el('Text', { text: 'Loading…', tone: 'faint' }, undefined, vis('loading')),
    el('Empty', { title: 'No data for this task', cmd: T('vx run ${/taskId}') }, undefined, vis('missing')),

    el('Grid', { variant: 'metrics-6' }, [
      el('Metric', { label: 'Runs', value: C('fmtNumber', { n: S('/runs') }), sub: S('/runsSub') }),
      el('Metric', { label: 'Success rate', value: C('fmtPercent0', { n: S('/successRate') }), sub: S('/failureMode'), tone: S('/successTone') }),
      el('Metric', { label: 'Hit rate', value: C('fmtPercent0', { n: S('/hitRate') }), sub: S('/hitSub') }),
      el('Metric', { label: 'Avg duration', value: C('fmtDuration', { ms: S('/avgMs') }), sub: S('/avgSub') }),
      el('Metric', { label: 'CPU usage', value: S('/cpuValue'), sub: S('/cpuSub') }),
      el('Metric', { label: 'Last run', value: S('/lastValue'), sub: S('/lastSub') }),
    ], vis('ok')),

    el('Card', { title: 'Duration over recent runs', actionText: 'oldest → newest' }, [
      el('LineChart', {
        xs: S('/durXs'),
        series: [{ name: 'duration', strokeClass: 'stroke-accent', areaClass: 'fill-accent/10', data: S('/durData') }],
        yFormat: 'duration',
        height: 280,
      }, undefined, { visible: { $state: '/hasRuns', eq: true } }),
      el('Empty', { title: 'No runs yet' }, undefined, { visible: { $state: '/hasRuns', eq: false } }),
    ], vis('ok')),

    el('Card', { title: 'Latest cache entry' }, [el('Facts', { items: S('/factItems'), command: S('/command') })], { visible: { $state: '/hasLatest', eq: true } }),

    el('Card', { title: S('/recentTitle'), noPad: true }, [
      el('DataTable', {
        rows: S('/recent'),
        emptyTitle: 'No runs yet',
        columns: [
          { key: 'startedAt', label: 'When', kind: 'relativeTime', baseTone: 'faint' },
          { key: 'status', label: 'Status', kind: 'status' },
          { key: 'durationMs', label: 'Duration', align: 'right', kind: 'duration' },
          { key: 'cpuMs', label: 'CPU', align: 'right', kind: 'duration', baseTone: 'faint' },
          { key: '_cpuPct', label: 'CPU %', align: 'right', kind: 'cpuPct', tone: { gt: 100, tone: 'success', else: 'faint' } },
          { key: '_rss', label: 'Peak RSS', align: 'right', kind: 'bytes', baseTone: 'faint' },
          { key: '_hash', label: 'Hash', align: 'right', kind: 'muted' },
        ],
      }),
    ], vis('ok')),
  ]),
)

export function TaskDetail() {
  const params = useParams<{ id: string }>()
  const taskId = () => decodeURIComponent(params.id)
  const origin = getOriginSignal()
  const [detail] = createResource(
    () => ({ id: taskId(), o: origin() }),
    (args) => getTaskDetail(args.id),
  )

  const state = createMemo<Record<string, unknown>>(() => {
    const d = detail()
    const status = d === undefined ? 'loading' : d === null ? 'missing' : 'ok'
    if (!d) return { taskId: taskId(), status }
    const agg = d.aggregate
    const recent = d.recent
    const cpuVals = recent.map(cpuPct).filter((v): v is number => v !== undefined && Number.isFinite(v))
    const cpu = cpuVals.length > 0 ? { avg: cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length, max: Math.max(...cpuVals) } : undefined
    const dur = [...recent].reverse()
    const e = d.latestEntry
    return {
      taskId: taskId(),
      status,
      runs: agg?.runs ?? 0,
      runsSub: agg ? `${agg.successes} ok · ${agg.failures} fail` : '',
      successRate: agg?.successRate ?? 0,
      failureMode: agg?.failureMode ?? '',
      successTone: agg?.failureMode === 'stable' ? 'good' : agg?.failureMode === 'flaky-fatal' ? 'bad' : 'warn',
      hitRate: agg?.hitRate ?? 0,
      hitSub: `${agg?.hits ?? 0} hits`,
      avgMs: agg?.avgDurationMs ?? 0,
      avgSub: `p50 ${formatDuration(agg?.p50DurationMs ?? 0)} · p99 ${formatDuration(agg?.p99DurationMs ?? 0)}`,
      cpuValue: cpu ? `${cpu.avg.toFixed(0)}%` : '—',
      cpuSub: cpu ? `avg · max ${cpu.max.toFixed(0)}%` : 'no timed runs',
      lastValue: agg?.lastSeenAt !== undefined ? formatRelativeTime(agg.lastSeenAt) : '—',
      lastSub: `min ${formatDuration(agg?.minDurationMs ?? 0)} · max ${formatDuration(agg?.maxDurationMs ?? 0)}`,
      hasRuns: dur.length > 0,
      durXs: dur.map((_, i) => i),
      durData: dur.map((r) => r.durationMs),
      hasLatest: !!e,
      factItems: e
        ? [
            { label: 'hash', value: `${e.hash.slice(0, 16)}…`, mono: true },
            { label: 'size', value: formatBytes(e.sizeBytes) },
            { label: 'duration', value: formatDuration(e.durationMs) },
            { label: 'created', value: formatRelativeTime(e.createdAt) },
            { label: 'accessed', value: formatRelativeTime(e.accessedAt) },
            { label: 'exit', value: String(e.exitCode) },
          ]
        : [],
      command: e?.command ?? '',
      recentTitle: `Recent runs (${recent.length})`,
      recent: recent.map((r) => ({
        ...r,
        _cpuPct: cpuPct(r) ?? null,
        _rss: r.peakRssBytes && r.peakRssBytes > 0 ? r.peakRssBytes : null,
        _hash: `${r.hash.slice(0, 10)}…`,
      })),
    }
  })

  return <Dash spec={SPEC} state={state()} />
}
