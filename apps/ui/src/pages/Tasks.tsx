import { createMemo, createResource } from 'solid-js'
import { type TaskHistoryRow, getHistory, getOriginSignal } from '../api.ts'
import { type Node, el, toSpec } from '../jr/spec.ts'
import { DashRenderer } from '../jr/renderer.tsx'
import { formatDuration, formatPercent, formatRelativeTime, paletteFor } from '../format.ts'

const enc = encodeURIComponent

function modeColor(mode: TaskHistoryRow['failureMode']): string {
  return mode === 'stable' ? 'success' : mode === 'flaky-recoverable' ? 'warn' : 'danger'
}

function build(history: TaskHistoryRow[] | undefined): Node {
  const rows = history ?? []
  const maxTotal = Math.max(1, ...rows.map((t) => t.totalDurationMs))
  return el('Page', { title: 'Tasks' }, [
    el('Card', { noPad: true }, [
      el('DataTable', {
        filter: true,
        filterPlaceholder: 'filter by project#task…',
        initialSort: { key: 'totalDurationMs', desc: true },
        emptyTitle: 'No task history yet',
        emptyCmd: 'vx run <task>',
        columns: [
          { key: 'id', label: 'Task', sortable: true },
          { key: 'runs', label: 'Runs', align: 'right', sortable: true },
          { key: 'successRate', label: 'Success', align: 'right', sortable: true },
          { key: 'hitRate', label: 'Hit', align: 'right', sortable: true },
          { key: 'avg', label: 'Avg', align: 'right', sortable: true },
          { key: 'p50', label: 'p50', align: 'right', sortable: true },
          { key: 'p99', label: 'p99', align: 'right', sortable: true },
          { key: 'total', label: 'Total time', align: 'right', sortable: true },
          { key: 'last', label: 'Last', align: 'right', sortable: true },
        ],
        rows: rows.map((r) => ({
          href: `/tasks/${enc(r.id)}`,
          filter: r.id.toLowerCase(),
          sort: {
            id: r.id,
            runs: r.runs,
            successRate: r.successRate,
            hitRate: r.hitRate,
            avg: r.avgDurationMs ?? 0,
            p50: r.p50DurationMs ?? 0,
            p99: r.p99DurationMs ?? 0,
            total: r.totalDurationMs,
            last: r.lastSeenAt ?? 0,
          },
          cells: {
            id: { kind: 'dots', dots: [modeColor(r.failureMode), paletteFor(r.project)], v: r.id },
            runs: String(r.runs),
            successRate: { kind: 'tone', v: formatPercent(r.successRate, 0), tone: r.failures > 0 && r.successRate < 0.9 ? 'danger' : 'default' },
            hitRate: { kind: 'tone', v: formatPercent(r.hitRate, 0), tone: 'cache' },
            avg: formatDuration(r.avgDurationMs ?? 0),
            p50: formatDuration(r.p50DurationMs ?? 0),
            p99: formatDuration(r.p99DurationMs ?? 0),
            total: { kind: 'bar', v: formatDuration(r.totalDurationMs), fraction: r.totalDurationMs / maxTotal, color: paletteFor(r.project) },
            last: { kind: 'tone', v: r.lastSeenAt !== undefined ? formatRelativeTime(r.lastSeenAt) : '—', tone: 'faint' },
          },
        })),
      }),
    ]),
  ])
}

export function Tasks() {
  const origin = getOriginSignal()
  const [history] = createResource(origin, () => getHistory(500))
  const spec = createMemo(() => toSpec(build(history())))
  return <DashRenderer spec={spec()} />
}
