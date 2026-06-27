import { Show, createMemo, createResource } from 'solid-js'
import { useParams } from '@solidjs/router'
import { type RunSummaryRow, getOriginSignal, getTaskDetail } from '../api.ts'
import { Card, type Column, DataTable, Empty, Facts, Grid, LineChart, Metric, Page, Text } from '../jr/components.tsx'
import { formatBytes, formatDuration, formatPercent, formatRelativeTime } from '../format.ts'

// CPU utilization = cpuMs / wall durationMs (>100% = multi-core). Cache hits
// excluded (~0 duration → meaningless ratio).
function cpuPct(r: Pick<RunSummaryRow, 'cpuMs' | 'durationMs' | 'cacheHit'>): number | undefined {
  return r.cpuMs !== null && r.durationMs > 0 && r.cacheHit !== true ? (r.cpuMs / r.durationMs) * 100 : undefined
}

const RECENT_COLUMNS: Column[] = [
  { key: 'startedAt', label: 'When', kind: 'relativeTime', baseTone: 'faint' },
  { key: 'status', label: 'Status', kind: 'status' },
  { key: 'durationMs', label: 'Duration', align: 'right', kind: 'duration' },
  { key: 'cpuMs', label: 'CPU', align: 'right', kind: 'duration', baseTone: 'faint' },
  { key: '_cpuPct', label: 'CPU %', align: 'right', kind: 'cpuPct', tone: { gt: 100, tone: 'success', else: 'faint' } },
  { key: '_rss', label: 'Peak RSS', align: 'right', kind: 'bytes', baseTone: 'faint' },
  { key: '_hash', label: 'Hash', align: 'right', kind: 'muted' },
]

export function TaskDetail() {
  const params = useParams<{ id: string }>()
  const taskId = () => decodeURIComponent(params.id)
  const origin = getOriginSignal()
  const [detail] = createResource(
    () => ({ id: taskId(), o: origin() }),
    (args) => getTaskDetail(args.id),
  )

  const recent = () => detail()?.recent ?? []
  const cpu = createMemo(() => {
    const vals = recent().map(cpuPct).filter((v): v is number => v !== undefined && Number.isFinite(v))
    return vals.length ? { avg: vals.reduce((a, b) => a + b, 0) / vals.length, max: Math.max(...vals) } : undefined
  })
  const dur = createMemo(() => [...recent()].reverse())
  const recentRows = createMemo(() =>
    recent().map((r) => ({
      ...r,
      _cpuPct: cpuPct(r) ?? null,
      _rss: r.peakRssBytes && r.peakRssBytes > 0 ? r.peakRssBytes : null,
      _hash: `${r.hash.slice(0, 10)}…`,
    })),
  )

  return (
    <Page backHref="/tasks" backLabel="tasks" title={taskId()} mono>
      <Show when={detail.loading}>
        <Text text="Loading…" tone="faint" />
      </Show>
      <Show when={detail() === null}>
        <Empty title="No data for this task" cmd={`vx run ${taskId()}`} />
      </Show>
      <Show when={detail()}>
        {(d) => {
          const agg = () => d().aggregate
          const e = () => d().latestEntry
          return (
            <>
              <Show when={agg()}>
                <Grid variant="metrics-6">
                  <Metric label="Runs" value={String(agg()!.runs)} sub={`${agg()!.successes} ok · ${agg()!.failures} fail`} />
                  <Metric
                    label="Success rate"
                    value={formatPercent(agg()!.successRate, 0)}
                    sub={agg()!.failureMode}
                    tone={agg()!.failureMode === 'stable' ? 'good' : agg()!.failureMode === 'flaky-fatal' ? 'bad' : 'warn'}
                  />
                  <Metric label="Hit rate" value={formatPercent(agg()!.hitRate, 0)} sub={`${agg()!.hits} hits`} />
                  <Metric
                    label="Avg duration"
                    value={formatDuration(agg()!.avgDurationMs ?? 0)}
                    sub={`p50 ${formatDuration(agg()!.p50DurationMs ?? 0)} · p99 ${formatDuration(agg()!.p99DurationMs ?? 0)}`}
                  />
                  <Metric
                    label="CPU usage"
                    value={cpu() ? `${cpu()!.avg.toFixed(0)}%` : '—'}
                    sub={cpu() ? `avg · max ${cpu()!.max.toFixed(0)}%` : 'no timed runs'}
                  />
                  <Metric
                    label="Last run"
                    value={agg()!.lastSeenAt !== undefined ? formatRelativeTime(agg()!.lastSeenAt) : '—'}
                    sub={`min ${formatDuration(agg()!.minDurationMs ?? 0)} · max ${formatDuration(agg()!.maxDurationMs ?? 0)}`}
                  />
                </Grid>
              </Show>

              <Card title="Duration over recent runs" actionText="oldest → newest">
                <Show when={dur().length > 0} fallback={<Empty title="No runs yet" />}>
                  <LineChart
                    xs={dur().map((_, i) => i)}
                    series={[{ name: 'duration', strokeClass: 'stroke-accent', areaClass: 'fill-accent/10', data: dur().map((r) => r.durationMs) }]}
                    yFormat="duration"
                    height={280}
                  />
                </Show>
              </Card>

              <Show when={e()}>
                <Card title="Latest cache entry">
                  <Facts
                    items={[
                      { label: 'hash', value: `${e()!.hash.slice(0, 16)}…`, mono: true },
                      { label: 'size', value: formatBytes(e()!.sizeBytes) },
                      { label: 'duration', value: formatDuration(e()!.durationMs) },
                      { label: 'created', value: formatRelativeTime(e()!.createdAt) },
                      { label: 'accessed', value: formatRelativeTime(e()!.accessedAt) },
                      { label: 'exit', value: String(e()!.exitCode) },
                    ]}
                    command={e()!.command}
                  />
                </Card>
              </Show>

              <Card title={`Recent runs (${recent().length})`} noPad>
                <DataTable rows={recentRows()} columns={RECENT_COLUMNS} emptyTitle="No runs yet" />
              </Card>
            </>
          )
        }}
      </Show>
    </Page>
  )
}
