import { createMemo, createResource } from 'solid-js'
import { useParams } from '@solidjs/router'
import { type ProjectRollup, type TaskHistoryRow, getHistory, getOriginSignal, listProjects } from '../api.ts'
import { type Node, el, toSpec } from '../jr/spec.ts'
import { DashRenderer } from '../jr/renderer.tsx'
import { formatBytes, formatDuration, formatPercent, formatRelativeTime, paletteFor } from '../format.ts'

const enc = encodeURIComponent

function build(name: string, summary: ProjectRollup | undefined, tasks: TaskHistoryRow[] | undefined): Node {
  const head = { backHref: '/projects', backLabel: 'projects', dotColor: paletteFor(name), title: name, mono: true }
  const ts = tasks ?? []
  const maxTotal = Math.max(1, ...ts.map((t) => t.totalDurationMs))

  const metrics = summary
    ? el('Grid', { variant: 'metrics-5' }, [
        el('Metric', { label: 'Total runs', value: String(summary.runs), sub: `${summary.taskCount} tasks` }),
        el('Metric', { label: 'Total time', value: formatDuration(summary.totalDurationMs), sub: `avg ${formatDuration(summary.avgDurationMs)}` }),
        el('Metric', { label: 'Time saved', value: formatDuration(summary.estimatedTimeSavedMs), sub: `${summary.hits} hits`, tone: 'good' }),
        el('Metric', { label: 'Hit rate', value: formatPercent(summary.hitRate, 0), tone: summary.hitRate > 0.5 ? 'good' : 'default' }),
        el('Metric', { label: 'Cache', value: formatBytes(summary.cacheBytes), sub: `${summary.cacheEntries} entries` }),
      ])
    : el('Empty', { title: 'No data for this project' })

  const tasksCard = el('Card', { title: `Tasks (${ts.length})`, noPad: true }, [
    el('DataTable', {
      emptyTitle: 'No tasks recorded',
      columns: [
        { key: 'task', label: 'Task' },
        { key: 'runs', label: 'Runs', align: 'right' },
        { key: 'success', label: 'Success', align: 'right' },
        { key: 'hit', label: 'Hit', align: 'right' },
        { key: 'avg', label: 'Avg', align: 'right' },
        { key: 'p99', label: 'p99', align: 'right' },
        { key: 'total', label: 'Total', align: 'right' },
        { key: 'last', label: 'Last', align: 'right' },
      ],
      rows: ts.map((t) => ({
        href: `/tasks/${enc(t.id)}`,
        cells: {
          task: { kind: 'projtask', project: t.project, task: t.task },
          runs: String(t.runs),
          success: { kind: 'tone', v: formatPercent(t.successRate, 0), tone: t.successRate < 0.9 ? 'danger' : 'default' },
          hit: { kind: 'tone', v: formatPercent(t.hitRate, 0), tone: 'cache' },
          avg: formatDuration(t.avgDurationMs ?? 0),
          p99: formatDuration(t.p99DurationMs ?? 0),
          total: { kind: 'bar', v: formatDuration(t.totalDurationMs), fraction: t.totalDurationMs / maxTotal, color: paletteFor(t.project) },
          last: { kind: 'tone', v: t.lastSeenAt !== undefined ? formatRelativeTime(t.lastSeenAt) : '—', tone: 'faint' },
        },
      })),
    }),
  ])

  return el('Page', head, [metrics, tasksCard])
}

export function ProjectDetail() {
  const params = useParams<{ name: string }>()
  const projectName = () => decodeURIComponent(params.name)
  const origin = getOriginSignal()
  const [projects] = createResource(() => ({ name: projectName(), o: origin() }), () => listProjects(500))
  const [tasks] = createResource(
    () => ({ name: projectName(), o: origin() }),
    async (args) => (await getHistory(500)).filter((t) => t.project === args.name),
  )
  const summary = createMemo(() => (projects() ?? []).find((p) => p.project === projectName()))
  const spec = createMemo(() => toSpec(build(projectName(), summary(), tasks())))
  return <DashRenderer spec={spec()} />
}
