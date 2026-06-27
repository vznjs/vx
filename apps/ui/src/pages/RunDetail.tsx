import { createMemo, createResource } from 'solid-js'
import { useParams } from '@solidjs/router'
import { getOriginSignal, getRun } from '../api.ts'
import { C, S, el, toSpec } from '../jr/spec.ts'
import { Dash } from '../jr/renderer.tsx'
import { formatRelativeTime } from '../format.ts'

const enc = encodeURIComponent
const vis = (s: string) => ({ visible: { $state: '/status', eq: s } })

const SPEC = toSpec(
  el('Page', { backHref: '/', backLabel: 'runs', title: S('/title'), mono: true }, [
    el('Text', { text: 'Loading…', tone: 'faint' }, undefined, vis('loading')),
    el('Empty', { title: 'Run not found' }, undefined, vis('missing')),

    el('Grid', { variant: 'metrics-5' }, [
      el('Metric', { label: 'Tasks', value: C('fmtNumber', { n: S('/taskCount') }), sub: S('/tasksSub') }),
      el('Metric', { label: 'Wall time', value: C('fmtDuration', { ms: S('/wallMs') }), sub: S('/wallSub') }),
      el('Metric', { label: 'Total task time', value: C('fmtDuration', { ms: S('/totalMs') }), sub: 'sum across all tasks' }),
      el('Metric', { label: 'CPU time', value: C('fmtDuration', { ms: S('/cpuMs') }), sub: S('/cpuSub') }),
      el('Metric', { label: 'Outcome', value: S('/outcome'), tone: S('/outcomeTone') }),
    ], vis('ok')),

    el('Card', { title: 'Timeline' }, [el('Flamegraph', { tasks: S('/tasks') })], vis('ok')),

    el('Card', { title: S('/tasksTitle'), noPad: true }, [
      el('DataTable', {
        rows: S('/rows'),
        rowHrefKey: '_href',
        emptyTitle: 'No tasks',
        columns: [
          { key: 'task', label: 'Task', kind: 'projtask' },
          { key: 'status', label: 'Status', kind: 'status' },
          { key: 'durationMs', label: 'Duration', align: 'right', kind: 'duration' },
          { key: 'cpuMs', label: 'CPU', align: 'right', kind: 'duration', baseTone: 'faint' },
          { key: '_rss', label: 'Peak RSS', align: 'right', kind: 'bytes', baseTone: 'faint' },
          { key: 'cacheHit', label: 'Cache', align: 'right', kind: 'cache' },
        ],
      }),
    ], vis('ok')),
  ]),
)

export function RunDetail() {
  const params = useParams<{ id: string }>()
  const origin = getOriginSignal()
  const [run] = createResource(() => ({ id: params.id, o: origin() }), (args) => getRun(args.id))

  const state = createMemo<Record<string, unknown>>(() => {
    const r = run()
    const status = r === undefined ? 'loading' : r === null ? 'missing' : 'ok'
    const base = { title: `Run ${params.id.slice(0, 12)}`, status }
    if (!r) return base
    const tasks = r.tasks
    const total = tasks.reduce((a, t) => a + (t.durationMs ?? 0), 0)
    const cpu = tasks.reduce((a, t) => a + (t.cpuMs ?? 0), 0)
    const successes = tasks.filter((t) => t.status === 'success').length
    const failures = tasks.filter((t) => t.status === 'failed').length
    const hits = tasks.filter((t) => t.cacheHit === true).length
    const startMs = Math.min(...tasks.map((x) => x.startedAt))
    const wall = Math.max(...tasks.map((x) => x.endedAt)) - startMs
    return {
      ...base,
      taskCount: tasks.length,
      tasksSub: `${successes} ok · ${failures} fail · ${hits} hits`,
      wallMs: wall,
      wallSub: `started ${formatRelativeTime(startMs)}`,
      totalMs: total,
      cpuMs: cpu,
      cpuSub: wall > 0 ? `${(cpu / wall).toFixed(2)}× parallelism` : '',
      outcome: failures > 0 ? 'failed' : 'success',
      outcomeTone: failures > 0 ? 'bad' : 'good',
      tasks,
      tasksTitle: `Tasks (${tasks.length})`,
      rows: tasks.map((t) => ({
        ...t,
        _rss: t.peakRssBytes && t.peakRssBytes > 0 ? t.peakRssBytes : null,
        _href: `/tasks/${enc(`${t.project}#${t.task}`)}`,
      })),
    }
  })

  return <Dash spec={SPEC} state={state()} />
}
