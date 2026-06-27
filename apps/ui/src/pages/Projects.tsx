import { createMemo, createResource } from 'solid-js'
import { getOriginSignal, listProjects } from '../api.ts'
import { S, el, toSpec } from '../jr/spec.ts'
import { Dash } from '../jr/renderer.tsx'
import { paletteFor } from '../format.ts'

const enc = encodeURIComponent

const SPEC = toSpec(
  el('Page', { title: 'Projects' }, [
    el('Card', { noPad: true }, [
      el('DataTable', {
        rows: S('/rows'),
        rowHrefKey: '_href',
        filter: true,
        filterKey: '_filter',
        filterPlaceholder: 'filter…',
        initialSort: { key: 'totalDurationMs', desc: true },
        emptyTitle: 'No projects discovered',
        emptyCmd: 'vx run <task>',
        columns: [
          { key: 'project', label: 'Project', sortable: true, kind: 'dots', dotsKeys: ['_projColor'], subKey: '_tasks' },
          { key: 'runs', label: 'Runs', align: 'right', sortable: true },
          { key: 'failures', label: 'Failures', align: 'right', sortable: true, tone: { gt: 0, tone: 'danger' } },
          { key: 'hitRate', label: 'Hit %', align: 'right', sortable: true, kind: 'percent0', baseTone: 'cache' },
          { key: 'totalDurationMs', label: 'Total time', align: 'right', sortable: true, kind: 'bar', format: 'duration' },
          { key: 'estimatedTimeSavedMs', label: 'Saved', align: 'right', sortable: true, kind: 'duration', baseTone: 'success' },
          { key: 'cacheBytes', label: 'Cache', align: 'right', sortable: true, kind: 'bytes' },
          { key: 'lastRunAt', label: 'Last run', align: 'right', sortable: true, kind: 'relativeTime', baseTone: 'faint' },
        ],
      }),
    ]),
  ]),
)

export function Projects() {
  const origin = getOriginSignal()
  const [data] = createResource(origin, () => listProjects(500))
  const state = createMemo<Record<string, unknown>>(() => {
    const rows = data() ?? []
    const maxTime = Math.max(1, ...rows.map((p) => p.totalDurationMs))
    return {
      rows: rows.map((p) => ({
        ...p,
        _projColor: paletteFor(p.project),
        _tasks: `· ${p.taskCount} tasks`,
        _frac: p.totalDurationMs / maxTime,
        _color: paletteFor(p.project),
        _href: `/projects/${enc(p.project)}`,
        _filter: p.project.toLowerCase(),
      })),
    }
  })
  return <Dash spec={SPEC} state={state()} />
}
