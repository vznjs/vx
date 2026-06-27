import { Show, createMemo, createResource } from 'solid-js'
import { useParams } from '@solidjs/router'
import { getHistory, getOriginSignal, listProjects } from '../api.ts'
import { Card, type Column, DataTable, Empty, Grid, Metric, Page } from '../jr/components.tsx'
import { formatBytes, formatDuration, formatPercent, paletteFor } from '../format.ts'

const enc = encodeURIComponent

const COLUMNS: Column[] = [
  { key: 'task', label: 'Task', kind: 'projtask' },
  { key: 'runs', label: 'Runs', align: 'right' },
  { key: 'successRate', label: 'Success', align: 'right', kind: 'percent0', tone: { lt: 0.9, tone: 'danger' } },
  { key: 'hitRate', label: 'Hit', align: 'right', kind: 'percent0', baseTone: 'cache' },
  { key: 'avgDurationMs', label: 'Avg', align: 'right', kind: 'duration' },
  { key: 'p99DurationMs', label: 'p99', align: 'right', kind: 'duration' },
  { key: 'totalDurationMs', label: 'Total', align: 'right', kind: 'bar', format: 'duration' },
  { key: 'lastSeenAt', label: 'Last', align: 'right', kind: 'relativeTime', baseTone: 'faint' },
]

export function ProjectDetail() {
  const params = useParams<{ name: string }>()
  const name = () => decodeURIComponent(params.name)
  const origin = getOriginSignal()
  const [projects] = createResource(() => ({ name: name(), o: origin() }), () => listProjects(500))
  const [tasks] = createResource(
    () => ({ name: name(), o: origin() }),
    async (args) => (await getHistory(500)).filter((t) => t.project === args.name),
  )
  const summary = createMemo(() => (projects() ?? []).find((p) => p.project === name()))
  const rows = createMemo(() => {
    const ts = tasks() ?? []
    const max = Math.max(1, ...ts.map((t) => t.totalDurationMs))
    return ts.map((t) => ({ ...t, _frac: t.totalDurationMs / max, _color: paletteFor(t.project), _href: `/tasks/${enc(t.id)}` }))
  })

  return (
    <Page backHref="/projects" backLabel="projects" dotColor={paletteFor(name())} title={name()} mono>
      <Show when={summary()} fallback={<Empty title="No data for this project" />}>
        <Grid variant="metrics-5">
          <Metric label="Total runs" value={String(summary()!.runs)} sub={`${summary()!.taskCount} tasks`} />
          <Metric label="Total time" value={formatDuration(summary()!.totalDurationMs)} sub={`avg ${formatDuration(summary()!.avgDurationMs)}`} />
          <Metric label="Time saved" value={formatDuration(summary()!.estimatedTimeSavedMs)} sub={`${summary()!.hits} hits`} tone="good" />
          <Metric label="Hit rate" value={formatPercent(summary()!.hitRate, 0)} tone={summary()!.hitRate > 0.5 ? 'good' : 'default'} />
          <Metric label="Cache" value={formatBytes(summary()!.cacheBytes)} sub={`${summary()!.cacheEntries} entries`} />
        </Grid>
      </Show>

      <Card title={`Tasks (${(tasks() ?? []).length})`} noPad>
        <DataTable rows={rows()} columns={COLUMNS} rowHrefKey="_href" emptyTitle="No tasks recorded" />
      </Card>
    </Page>
  )
}
