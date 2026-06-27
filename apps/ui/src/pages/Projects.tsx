import { createMemo, createResource } from 'solid-js'
import { getOriginSignal, listProjects } from '../api.ts'
import { Card, type Column, DataTable, Page } from '../jr/components.tsx'
import { paletteFor } from '../format.ts'

const enc = encodeURIComponent

const COLUMNS: Column[] = [
  { key: 'project', label: 'Project', sortable: true, kind: 'dots', dotsKeys: ['_projColor'], subKey: '_tasks' },
  { key: 'runs', label: 'Runs', align: 'right', sortable: true },
  { key: 'failures', label: 'Failures', align: 'right', sortable: true, tone: { gt: 0, tone: 'danger' } },
  { key: 'hitRate', label: 'Hit %', align: 'right', sortable: true, kind: 'percent0', baseTone: 'cache' },
  { key: 'totalDurationMs', label: 'Total time', align: 'right', sortable: true, kind: 'bar', format: 'duration' },
  { key: 'estimatedTimeSavedMs', label: 'Saved', align: 'right', sortable: true, kind: 'duration', baseTone: 'success' },
  { key: 'cacheBytes', label: 'Cache', align: 'right', sortable: true, kind: 'bytes' },
  { key: 'lastRunAt', label: 'Last run', align: 'right', sortable: true, kind: 'relativeTime', baseTone: 'faint' },
]

export function Projects() {
  const origin = getOriginSignal()
  const [data] = createResource(origin, () => listProjects(500))
  const rows = createMemo(() => {
    const rs = data() ?? []
    const max = Math.max(1, ...rs.map((p) => p.totalDurationMs))
    return rs.map((p) => ({
      ...p,
      _projColor: paletteFor(p.project),
      _tasks: `· ${p.taskCount} tasks`,
      _frac: p.totalDurationMs / max,
      _color: paletteFor(p.project),
      _href: `/projects/${enc(p.project)}`,
      _filter: p.project.toLowerCase(),
    }))
  })

  return (
    <Page title="Projects">
      <Card noPad>
        <DataTable
          rows={rows()}
          columns={COLUMNS}
          rowHrefKey="_href"
          filter
          filterKey="_filter"
          filterPlaceholder="filter…"
          initialSort={{ key: 'totalDurationMs', desc: true }}
          emptyTitle="No projects discovered"
          emptyCmd="vx run <task>"
        />
      </Card>
    </Page>
  )
}
