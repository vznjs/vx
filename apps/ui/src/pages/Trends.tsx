import { Show, createMemo, createResource } from 'solid-js'
import { getHeatmap, getOriginSignal, getParallelismHistory, getRunTrends, getStorageGrowth } from '../api.ts'
import { Card, Empty, Grid, Heatmap, LineChart, Metric, Page, Stack } from '../jr/components.tsx'
import { formatDuration } from '../format.ts'

export function Trends() {
  const origin = getOriginSignal()
  const [trend] = createResource(origin, () => getRunTrends({ bucket: 'day' }))
  const [storage] = createResource(origin, () => getStorageGrowth(30))
  const [heat] = createResource(origin, () => getHeatmap(30))
  const [parallel] = createResource(origin, () => getParallelismHistory(50))

  const tr = () => trend()?.points ?? []
  const sg = () => storage() ?? []
  const hm = () => heat() ?? []
  const par = () => parallel() ?? []
  const parAsc = createMemo(() => [...par()].reverse())
  const heatData = createMemo(() => hm().map((c) => ({ dayOfWeek: c.dayOfWeek, hourOfDay: c.hourOfDay, value: c.runs })))

  return (
    <Page title="Trends" subtitle="Patterns over time — when builds happen, how the cache grows, how parallel you run.">
      <Card title="Runs per day (last 30d)">
        <Show when={tr().length > 0} fallback={<Empty title="No data yet" />}>
          <LineChart
            xs={tr().map((p) => p.t)}
            series={[
              { name: 'runs', strokeClass: 'stroke-accent', areaClass: 'fill-accent/10', data: tr().map((p) => p.runs) },
              { name: 'hits', strokeClass: 'stroke-cache-local', data: tr().map((p) => p.hits) },
              { name: 'failures', strokeClass: 'stroke-danger', data: tr().map((p) => p.failures) },
            ]}
            xFormat="date"
            yFormat="count"
            height={320}
          />
        </Show>
      </Card>

      <Grid variant="main-320">
        <Card title="Total duration per day (last 30d)">
          <Show when={tr().length > 0} fallback={<Empty title="No data" />}>
            <LineChart
              xs={tr().map((p) => p.t)}
              series={[{ name: 'duration', strokeClass: 'stroke-info', areaClass: 'fill-info/10', data: tr().map((p) => p.totalDurationMs) }]}
              xFormat="date"
              yFormat="duration"
              height={320}
            />
          </Show>
        </Card>
        <Card title="When you build" actionText="last 30d">
          <Show when={hm().some((c) => c.runs > 0)} fallback={<Empty title="No runs in the window" />}>
            <Heatmap data={heatData()} cellSize={14} />
          </Show>
        </Card>
      </Grid>

      <Card title="Cache storage growth (entries added per day)">
        <Show when={sg().length > 0} fallback={<Empty title="No cached output yet" />}>
          <LineChart
            xs={sg().map((p) => p.t)}
            series={[{ name: 'bytes', strokeClass: 'stroke-accent-2', areaClass: 'fill-accent-2/10', data: sg().map((p) => p.bytesAdded) }]}
            xFormat="date"
            yFormat="bytes"
            height={280}
          />
        </Show>
      </Card>

      <Card title="Parallelism factor per invocation" actionText="cpu sum / wall time — 1.0 = serial">
        <Show when={par().length > 0} fallback={<Empty title="No invocations recorded" />}>
          <Stack gap="4">
            <Grid variant="cols-3">
              <Metric
                label="Avg parallelism"
                value={`${(par().reduce((a, p) => a + p.factor, 0) / Math.max(1, par().length)).toFixed(2)}×`}
                sub="across recent runs"
              />
              <Metric label="Best invocation" value={`${Math.max(0, ...par().map((p) => p.factor)).toFixed(2)}×`} />
              <Metric label="Total CPU time" value={formatDuration(par().reduce((a, p) => a + p.cpuSumMs, 0))} />
            </Grid>
            <LineChart
              xs={parAsc().map((p) => p.startedAt)}
              series={[{ name: 'parallelism', strokeClass: 'stroke-chart-3', areaClass: 'fill-chart-3/10', data: parAsc().map((p) => p.factor) }]}
              xFormat="date"
              yFormat="multiplier"
              height={240}
            />
          </Stack>
        </Show>
      </Card>
    </Page>
  )
}
