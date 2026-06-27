import { createMemo, createResource } from 'solid-js'
import { useParams } from '@solidjs/router'
import { type RunDetail as RunDetailData, getOriginSignal, getRun } from '../api.ts'
import { type Node, el, toSpec } from '../jr/spec.ts'
import { DashRenderer } from '../jr/renderer.tsx'
import { formatBytes, formatDuration, formatRelativeTime } from '../format.ts'

const enc = encodeURIComponent

function build(id: string, run: RunDetailData | null | undefined): Node {
  const head = { backHref: '/', backLabel: 'runs', title: `Run ${id.slice(0, 12)}`, mono: true }
  if (run === undefined) return el('Page', head, [el('Text', { text: 'Loading…', tone: 'faint' })])
  if (run === null) return el('Page', head, [el('Empty', { title: 'Run not found' })])

  const tasks = run.tasks
  const total = tasks.reduce((a, t) => a + (t.durationMs ?? 0), 0)
  const successes = tasks.filter((t) => t.status === 'success').length
  const failures = tasks.filter((t) => t.status === 'failed').length
  const hits = tasks.filter((t) => t.cacheHit === true).length
  const cpu = tasks.reduce((a, t) => a + (t.cpuMs ?? 0), 0)
  const startMs = Math.min(...tasks.map((x) => x.startedAt))
  const wall = Math.max(...tasks.map((x) => x.endedAt)) - startMs

  const metrics = el('Grid', { variant: 'metrics-5' }, [
    el('Metric', { label: 'Tasks', value: String(tasks.length), sub: `${successes} ok · ${failures} fail · ${hits} hits` }),
    el('Metric', { label: 'Wall time', value: formatDuration(wall), sub: `started ${formatRelativeTime(startMs)}` }),
    el('Metric', { label: 'Total task time', value: formatDuration(total), sub: 'sum across all tasks' }),
    el('Metric', { label: 'CPU time', value: formatDuration(cpu), sub: wall > 0 ? `${(cpu / wall).toFixed(2)}× parallelism` : '' }),
    el('Metric', { label: 'Outcome', value: failures > 0 ? 'failed' : 'success', tone: failures > 0 ? 'bad' : 'good' }),
  ])

  const timeline = el('Card', { title: 'Timeline' }, [el('Flamegraph', { tasks })])

  const table = el('Card', { title: `Tasks (${tasks.length})`, noPad: true }, [
    el('DataTable', {
      emptyTitle: 'No tasks',
      columns: [
        { key: 'task', label: 'Task' },
        { key: 'status', label: 'Status' },
        { key: 'duration', label: 'Duration', align: 'right' },
        { key: 'cpu', label: 'CPU', align: 'right' },
        { key: 'rss', label: 'Peak RSS', align: 'right' },
        { key: 'cache', label: 'Cache', align: 'right' },
      ],
      rows: tasks.map((t) => ({
        href: `/tasks/${enc(`${t.project}#${t.task}`)}`,
        cells: {
          task: { kind: 'projtask', project: t.project, task: t.task },
          status: { kind: 'status', status: t.status, cacheHit: t.cacheHit },
          duration: formatDuration(t.durationMs),
          cpu: { kind: 'tone', v: t.cpuMs !== null ? formatDuration(t.cpuMs) : '—', tone: 'faint' },
          rss: { kind: 'tone', v: t.peakRssBytes !== null && t.peakRssBytes > 0 ? formatBytes(t.peakRssBytes) : '—', tone: 'faint' },
          cache: { kind: 'tone', v: t.cacheHit === true ? 'hit' : 'miss', tone: 'cache' },
        },
      })),
    }),
  ])

  return el('Page', head, [metrics, timeline, table])
}

export function RunDetail() {
  const params = useParams<{ id: string }>()
  const origin = getOriginSignal()
  const [run] = createResource(() => ({ id: params.id, o: origin() }), (args) => getRun(args.id))
  const spec = createMemo(() => toSpec(build(params.id, run())))
  return <DashRenderer spec={spec()} />
}
