import { Show, createMemo, createResource } from 'solid-js'
import {
  getCacheSavings,
  getCacheStats,
  getFailures,
  getOriginSignal,
  getRunTrends,
  getTopTasks,
  listInvocations,
  listProjects,
} from '../api.ts'
import { Card, DataTable, Empty, Grid, LineChart, LiveActivity, Metric, Page, RankList, Treemap } from '../jr/components.tsx'
import { formatBytes, formatDuration, formatPercent, paletteFor } from '../format.ts'

const enc = encodeURIComponent

export function Overview() {
  const origin = getOriginSignal()
  const [stats] = createResource(origin, () => getCacheStats())
  const [savings] = createResource(origin, () => getCacheSavings())
  const [topTasks] = createResource(origin, () => getTopTasks(8))
  const [failures] = createResource(origin, () => getFailures(8))
  const [projects] = createResource(origin, () => listProjects(50))
  const [invocations] = createResource(origin, () => listInvocations(12))
  const [trend] = createResource(origin, () => getRunTrends({ bucket: 'day' }))

  const ps = () => projects() ?? []
  const tr = () => trend()?.points ?? []
  const totalRuns = createMemo(() => ps().reduce((a, p) => a + p.runs, 0))
  const totalHits = createMemo(() => ps().reduce((a, p) => a + p.hits, 0))
  const totalFails = createMemo(() => ps().reduce((a, p) => a + p.failures, 0))
  const hitRate = createMemo(() => (totalRuns() > 0 ? totalHits() / totalRuns() : 0))
  const maxTime = createMemo(() => Math.max(1, ...ps().map((p) => p.totalDurationMs)))
  const trendRuns = createMemo(() => tr().reduce((a, p) => a + p.runs, 0))
  const trendSummary = createMemo(
    () => `${trendRuns()} runs · ${formatDuration(tr().reduce((a, p) => a + p.totalDurationMs, 0))} total · ${tr().reduce((a, p) => a + p.hits, 0)} hits`,
  )

  const topItems = createMemo(() => (topTasks() ?? []).map((t) => ({ ...t, _href: `/tasks/${enc(t.id)}` })))
  const failItems = createMemo(() =>
    (failures() ?? []).map((f) => ({ ...f, _label: `${f.project}#${f.task}`, _href: `/tasks/${enc(`${f.project}#${f.task}`)}` })),
  )
  const treemap = createMemo(() =>
    ps().filter((p) => p.cacheBytes > 0).map((p) => ({ label: p.project, value: p.cacheBytes, colorClass: `fill-${paletteFor(p.project)}` })),
  )
  const leaderboard = createMemo(() =>
    ps().slice(0, 6).map((p) => ({ ...p, _frac: p.totalDurationMs / maxTime(), _color: paletteFor(p.project), _href: `/projects/${enc(p.project)}` })),
  )
  const invItems = createMemo(() =>
    (invocations() ?? []).map((r) => ({ ...r, _runShort: `${r.runId.slice(0, 8)}…`, _href: `/runs/${r.runId}` })),
  )

  return (
    <Page>
      <Show when={stats() && savings()}>
        <Grid variant="metrics-4">
          <Metric
            label="Time saved"
            value={formatDuration(savings()!.estimatedTimeSavedTotalMs)}
            sub={`${totalHits()} cache hits`}
            tone={savings()!.estimatedTimeSavedTotalMs > 0 ? 'good' : 'default'}
          />
          <Metric
            label="Hit rate"
            value={formatPercent(hitRate(), 0)}
            sub={`${totalHits()} / ${totalRuns()} runs`}
            tone={hitRate() > 0.5 ? 'good' : hitRate() < 0.2 && totalRuns() > 5 ? 'warn' : 'default'}
          />
          <Metric
            label="Total runs"
            value={String(totalRuns())}
            sub={totalFails() > 0 ? `${totalFails()} failed` : 'no failures'}
            tone={totalFails() > 0 ? 'bad' : 'good'}
          />
          <Metric label="Cache footprint" value={formatBytes(stats()!.totalBytes)} sub={`${stats()!.entryCount} entries`} />
        </Grid>
      </Show>

      <Grid variant="main-280">
        <Card title="Activity — last 30 days" actionText="runs · failures">
          <Show when={trendRuns() > 0} fallback={<Empty title="No runs in the last 30 days" cmd="vx run <task>" />}>
            <LineChart
              xs={tr().map((p) => p.t)}
              series={[
                { name: 'runs', strokeClass: 'stroke-accent', areaClass: 'fill-accent/10', data: tr().map((p) => p.runs) },
                { name: 'failures', strokeClass: 'stroke-danger', data: tr().map((p) => p.failures) },
              ]}
              xFormat="date"
              yFormat="count"
              height={300}
            />
            <div class="text-[11px] text-fg-3 mt-2 font-mono">{trendSummary()}</div>
          </Show>
        </Card>
        <Card title="Live activity" actionText="SSE">
          <LiveActivity />
        </Card>
      </Grid>

      <Grid variant="cols-2">
        <Card title="Top time-burners" actionHref="/tasks" actionLabel="all tasks" noPad>
          <RankList
            items={topItems()}
            labelKey="id"
            valueKey="totalDurationMs"
            valueFormat="duration"
            indexed
            metaKey="runs"
            metaSuffix="×"
            emptyTitle="Nothing executed yet"
            emptyCmd="vx run <task>"
          />
        </Card>
        <Card title="Recent failures" actionHref="/tasks" actionLabel="all tasks" noPad>
          <RankList items={failItems()} labelKey="_label" valueKey="startedAt" valueFormat="relativeTime" metaKey="exitCode" metaPrefix="exit " emptyTitle="No failures 🎉" />
        </Card>
      </Grid>

      <Grid variant="main-320">
        <Card title="Cache footprint by project" actionHref="/cache" actionLabel="cache">
          <Show when={treemap().length > 0} fallback={<Empty title="No cached output yet" />}>
            <Treemap data={treemap()} height={240} valueFormat="bytes" />
          </Show>
        </Card>
        <Card title="Project leaderboard" actionHref="/projects" actionLabel="all" noPad>
          <RankList items={leaderboard()} labelKey="project" valueKey="totalDurationMs" valueFormat="duration" metaKey="runs" metaSuffix="×" emptyTitle="No projects discovered" />
        </Card>
      </Grid>

      <Card title="Recent invocations" noPad>
        <DataTable
          rows={invItems()}
          rowHrefKey="_href"
          emptyTitle="No invocations yet"
          emptyCmd="vx run <task>"
          columns={[
            { key: '_runShort', label: 'Run', baseTone: 'muted' },
            { key: 'startedAt', label: 'Started', align: 'right', kind: 'relativeTime', baseTone: 'faint' },
            { key: 'totalDurationMs', label: 'Duration', align: 'right', kind: 'duration' },
            { key: 'taskCount', label: 'Tasks', align: 'right' },
            { key: 'failedCount', label: 'Failed', align: 'right', tone: { gt: 0, tone: 'danger' } },
            { key: 'hitCount', label: 'Hits', align: 'right', baseTone: 'cache' },
          ]}
        />
      </Card>
    </Page>
  )
}
