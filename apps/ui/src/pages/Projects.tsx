import { createMemo, createResource } from 'solid-js'
import { type ProjectRollup, getOriginSignal, listProjects } from '../api.ts'
import { type Node, el, toSpec } from '../jr/spec.ts'
import { DashRenderer } from '../jr/renderer.tsx'
import { formatBytes, formatDuration, formatPercent, formatRelativeTime, paletteFor } from '../format.ts'

const enc = encodeURIComponent

function build(data: ProjectRollup[] | undefined): Node {
  const rows = data ?? []
  const maxTime = Math.max(1, ...rows.map((p) => p.totalDurationMs))
  return el('Page', { title: 'Projects' }, [
    el('Card', { noPad: true }, [
      el('DataTable', {
        filter: true,
        filterPlaceholder: 'filter…',
        initialSort: { key: 'total', desc: true },
        emptyTitle: 'No projects discovered',
        emptyCmd: 'vx run <task>',
        columns: [
          { key: 'name', label: 'Project', sortable: true },
          { key: 'runs', label: 'Runs', align: 'right', sortable: true },
          { key: 'failures', label: 'Failures', align: 'right', sortable: true },
          { key: 'hitRate', label: 'Hit %', align: 'right', sortable: true },
          { key: 'total', label: 'Total time', align: 'right', sortable: true },
          { key: 'saved', label: 'Saved', align: 'right', sortable: true },
          { key: 'cache', label: 'Cache', align: 'right', sortable: true },
          { key: 'last', label: 'Last run', align: 'right', sortable: true },
        ],
        rows: rows.map((p) => ({
          href: `/projects/${enc(p.project)}`,
          filter: p.project.toLowerCase(),
          sort: {
            name: p.project,
            runs: p.runs,
            failures: p.failures,
            hitRate: p.hitRate,
            total: p.totalDurationMs,
            saved: p.estimatedTimeSavedMs,
            cache: p.cacheBytes,
            last: p.lastRunAt ?? 0,
          },
          cells: {
            name: { kind: 'dots', dots: [paletteFor(p.project)], v: p.project, sub: `· ${p.taskCount} tasks` },
            runs: String(p.runs),
            failures: { kind: 'tone', v: String(p.failures), tone: p.failures > 0 ? 'danger' : 'default' },
            hitRate: { kind: 'tone', v: formatPercent(p.hitRate, 0), tone: 'cache' },
            total: { kind: 'bar', v: formatDuration(p.totalDurationMs), fraction: p.totalDurationMs / maxTime, color: paletteFor(p.project) },
            saved: { kind: 'tone', v: formatDuration(p.estimatedTimeSavedMs), tone: 'success' },
            cache: formatBytes(p.cacheBytes),
            last: { kind: 'tone', v: p.lastRunAt ? formatRelativeTime(p.lastRunAt) : '—', tone: 'faint' },
          },
        })),
      }),
    ]),
  ])
}

export function Projects() {
  const origin = getOriginSignal()
  const [data] = createResource(origin, () => listProjects(500))
  const spec = createMemo(() => toSpec(build(data())))
  return <DashRenderer spec={spec()} />
}
