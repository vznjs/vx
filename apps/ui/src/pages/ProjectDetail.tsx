import { createMemo, createResource } from 'solid-js'
import { useParams } from '@solidjs/router'
import { getHistory, getOriginSignal, listProjects } from '../api.ts'
import { C, S, el, toSpec } from '../jr/spec.ts'
import { Dash } from '../jr/renderer.tsx'
import { formatDuration, paletteFor } from '../format.ts'

const enc = encodeURIComponent

const SPEC = toSpec(
  el('Page', { backHref: '/projects', backLabel: 'projects', dotColor: S('/dotColor'), title: S('/name'), mono: true }, [
    el('Grid', { variant: 'metrics-5' }, [
      el('Metric', { label: 'Total runs', value: C('fmtNumber', { n: S('/runs') }), sub: S('/runsSub') }),
      el('Metric', { label: 'Total time', value: C('fmtDuration', { ms: S('/totalMs') }), sub: S('/avgSub') }),
      el('Metric', { label: 'Time saved', value: C('fmtDuration', { ms: S('/savedMs') }), sub: S('/savedSub'), tone: 'good' }),
      el('Metric', { label: 'Hit rate', value: C('fmtPercent0', { n: S('/hitRate') }), tone: S('/hitTone') }),
      el('Metric', { label: 'Cache', value: C('fmtBytes', { b: S('/cacheBytes') }), sub: S('/cacheSub') }),
    ], { visible: { $state: '/hasSummary', eq: true } }),
    el('Empty', { title: 'No data for this project' }, undefined, { visible: { $state: '/hasSummary', eq: false } }),

    el('Card', { title: S('/tasksTitle'), noPad: true }, [
      el('DataTable', {
        rows: S('/rows'),
        rowHrefKey: '_href',
        emptyTitle: 'No tasks recorded',
        columns: [
          { key: 'task', label: 'Task', kind: 'projtask' },
          { key: 'runs', label: 'Runs', align: 'right' },
          { key: 'successRate', label: 'Success', align: 'right', kind: 'percent0', tone: { lt: 0.9, tone: 'danger' } },
          { key: 'hitRate', label: 'Hit', align: 'right', kind: 'percent0', baseTone: 'cache' },
          { key: 'avgDurationMs', label: 'Avg', align: 'right', kind: 'duration' },
          { key: 'p99DurationMs', label: 'p99', align: 'right', kind: 'duration' },
          { key: 'totalDurationMs', label: 'Total', align: 'right', kind: 'bar', format: 'duration' },
          { key: 'lastSeenAt', label: 'Last', align: 'right', kind: 'relativeTime', baseTone: 'faint' },
        ],
      }),
    ]),
  ]),
)

export function ProjectDetail() {
  const params = useParams<{ name: string }>()
  const name = () => decodeURIComponent(params.name)
  const origin = getOriginSignal()
  const [projects] = createResource(() => ({ name: name(), o: origin() }), () => listProjects(500))
  const [tasks] = createResource(
    () => ({ name: name(), o: origin() }),
    async (args) => (await getHistory(500)).filter((t) => t.project === args.name),
  )

  const state = createMemo<Record<string, unknown>>(() => {
    const s = (projects() ?? []).find((p) => p.project === name())
    const ts = tasks() ?? []
    const maxTotal = Math.max(1, ...ts.map((t) => t.totalDurationMs))
    return {
      name: name(),
      dotColor: paletteFor(name()),
      hasSummary: !!s,
      runs: s?.runs ?? 0,
      runsSub: `${s?.taskCount ?? 0} tasks`,
      totalMs: s?.totalDurationMs ?? 0,
      avgSub: `avg ${formatDuration(s?.avgDurationMs ?? 0)}`,
      savedMs: s?.estimatedTimeSavedMs ?? 0,
      savedSub: `${s?.hits ?? 0} hits`,
      hitRate: s?.hitRate ?? 0,
      hitTone: (s?.hitRate ?? 0) > 0.5 ? 'good' : 'default',
      cacheBytes: s?.cacheBytes ?? 0,
      cacheSub: `${s?.cacheEntries ?? 0} entries`,
      tasksTitle: `Tasks (${ts.length})`,
      rows: ts.map((t) => ({
        ...t,
        _frac: t.totalDurationMs / maxTotal,
        _color: paletteFor(t.project),
        _href: `/tasks/${enc(t.id)}`,
      })),
    }
  })

  return <Dash spec={SPEC} state={state()} />
}
