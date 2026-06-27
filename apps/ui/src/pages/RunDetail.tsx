import { Show, createMemo, createResource } from 'solid-js'
import { useParams } from '@solidjs/router'
import { getOriginSignal, getRun } from '../api.ts'
import { Card, type Column, DataTable, Empty, Flamegraph, Grid, Metric, Page, Text } from '../jr/components.tsx'
import { formatDuration, formatRelativeTime } from '../format.ts'

const enc = encodeURIComponent

const COLUMNS: Column[] = [
  { key: 'task', label: 'Task', kind: 'projtask' },
  { key: 'status', label: 'Status', kind: 'status' },
  { key: 'durationMs', label: 'Duration', align: 'right', kind: 'duration' },
  { key: 'cpuMs', label: 'CPU', align: 'right', kind: 'duration', baseTone: 'faint' },
  { key: '_rss', label: 'Peak RSS', align: 'right', kind: 'bytes', baseTone: 'faint' },
  { key: 'cacheHit', label: 'Cache', align: 'right', kind: 'cache' },
]

export function RunDetail() {
  const params = useParams<{ id: string }>()
  const origin = getOriginSignal()
  const [run] = createResource(() => ({ id: params.id, o: origin() }), (args) => getRun(args.id))
  const rows = createMemo(() =>
    (run()?.tasks ?? []).map((t) => ({
      ...t,
      _rss: t.peakRssBytes && t.peakRssBytes > 0 ? t.peakRssBytes : null,
      _href: `/tasks/${enc(`${t.project}#${t.task}`)}`,
    })),
  )

  return (
    <Page backHref="/" backLabel="runs" title={`Run ${params.id.slice(0, 12)}`} mono>
      <Show when={run.loading}>
        <Text text="Loading…" tone="faint" />
      </Show>
      <Show when={run() === null}>
        <Empty title="Run not found" />
      </Show>
      <Show when={run()}>
        {(r) => {
          const tasks = () => r().tasks
          const total = createMemo(() => tasks().reduce((a, t) => a + (t.durationMs ?? 0), 0))
          const cpu = createMemo(() => tasks().reduce((a, t) => a + (t.cpuMs ?? 0), 0))
          const failures = createMemo(() => tasks().filter((t) => t.status === 'failed').length)
          const start = createMemo(() => Math.min(...tasks().map((x) => x.startedAt)))
          const wall = createMemo(() => Math.max(...tasks().map((x) => x.endedAt)) - start())
          return (
            <>
              <Grid variant="metrics-5">
                <Metric
                  label="Tasks"
                  value={String(tasks().length)}
                  sub={`${tasks().filter((t) => t.status === 'success').length} ok · ${failures()} fail · ${tasks().filter((t) => t.cacheHit === true).length} hits`}
                />
                <Metric label="Wall time" value={formatDuration(wall())} sub={`started ${formatRelativeTime(start())}`} />
                <Metric label="Total task time" value={formatDuration(total())} sub="sum across all tasks" />
                <Metric label="CPU time" value={formatDuration(cpu())} sub={wall() > 0 ? `${(cpu() / wall()).toFixed(2)}× parallelism` : ''} />
                <Metric label="Outcome" value={failures() > 0 ? 'failed' : 'success'} tone={failures() > 0 ? 'bad' : 'good'} />
              </Grid>

              <Card title="Timeline">
                <Flamegraph tasks={tasks()} />
              </Card>

              <Card title={`Tasks (${tasks().length})`} noPad>
                <DataTable rows={rows()} columns={COLUMNS} rowHrefKey="_href" emptyTitle="No tasks" />
              </Card>
            </>
          )
        }}
      </Show>
    </Page>
  )
}
