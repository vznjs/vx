import { createMemo, createResource } from 'solid-js'
import { type TaskHistoryRow, getHistory, getOriginSignal } from '../api.ts'
import { S, el, toSpec } from '../jr/spec.ts'
import { Dash } from '../jr/renderer.tsx'
import { paletteFor } from '../format.ts'

const enc = encodeURIComponent
const modeColor = (m: TaskHistoryRow['failureMode']) => (m === 'stable' ? 'success' : m === 'flaky-recoverable' ? 'warn' : 'danger')

const SPEC = toSpec(
  el('Page', { title: 'Tasks' }, [
    el('Card', { noPad: true }, [
      el('DataTable', {
        rows: S('/rows'),
        rowHrefKey: '_href',
        filter: true,
        filterKey: '_filter',
        filterPlaceholder: 'filter by project#task…',
        initialSort: { key: 'totalDurationMs', desc: true },
        emptyTitle: 'No task history yet',
        emptyCmd: 'vx run <task>',
        columns: [
          { key: 'id', label: 'Task', sortable: true, kind: 'dots', dotsKeys: ['_modeColor', '_projColor'] },
          { key: 'runs', label: 'Runs', align: 'right', sortable: true },
          { key: 'successRate', label: 'Success', align: 'right', sortable: true, kind: 'percent0', tone: { lt: 0.9, tone: 'danger' } },
          { key: 'hitRate', label: 'Hit', align: 'right', sortable: true, kind: 'percent0', baseTone: 'cache' },
          { key: 'avgDurationMs', label: 'Avg', align: 'right', sortable: true, kind: 'duration' },
          { key: 'p50DurationMs', label: 'p50', align: 'right', sortable: true, kind: 'duration' },
          { key: 'p99DurationMs', label: 'p99', align: 'right', sortable: true, kind: 'duration' },
          { key: 'totalDurationMs', label: 'Total time', align: 'right', sortable: true, kind: 'bar', format: 'duration' },
          { key: 'lastSeenAt', label: 'Last', align: 'right', sortable: true, kind: 'relativeTime', baseTone: 'faint' },
        ],
      }),
    ]),
  ]),
)

export function Tasks() {
  const origin = getOriginSignal()
  const [history] = createResource(origin, () => getHistory(500))
  const state = createMemo<Record<string, unknown>>(() => {
    const rows = history() ?? []
    const maxTotal = Math.max(1, ...rows.map((t) => t.totalDurationMs))
    return {
      rows: rows.map((r) => ({
        ...r,
        _modeColor: modeColor(r.failureMode),
        _projColor: paletteFor(r.project),
        _frac: r.totalDurationMs / maxTotal,
        _color: paletteFor(r.project),
        _href: `/tasks/${enc(r.id)}`,
        _filter: r.id.toLowerCase(),
      })),
    }
  })
  return <Dash spec={SPEC} state={state()} />
}
