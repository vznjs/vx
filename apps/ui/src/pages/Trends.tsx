import { Show, createResource } from 'solid-js'
import {
  getHeatmap,
  getOriginSignal,
  getParallelismHistory,
  getRunTrends,
  getStorageGrowth,
} from '../api.ts'
import { Card, EmptyState, MetricCard } from '../components/ui.tsx'
import { Heatmap, LineChart } from '../components/charts.tsx'
import { formatBytes, formatCount, formatDate, formatDuration, formatHour } from '../format.ts'

export function Trends() {
  const origin = getOriginSignal()
  const [trend7d] = createResource(origin, () => getRunTrends({ bucket: 'day' }))
  const [storage] = createResource(origin, () => getStorageGrowth(30))
  const [heat] = createResource(origin, () => getHeatmap(30))
  const [parallel] = createResource(origin, () => getParallelismHistory(50))

  return (
    <div class="flex flex-col gap-5">
      <div>
        <h1 class="text-base font-semibold m-0">Trends</h1>
        <p class="text-fg-3 text-[12px] mt-1">Patterns over time — when builds happen, how the cache grows, how parallel you run.</p>
      </div>

      <Card title="Runs per day (last 30d)">
        <Show when={trend7d()?.points.length} fallback={<EmptyState title="No data yet" />}>
          <LineChart
            xs={trend7d()?.points.map((p) => p.t) ?? []}
            series={[
              { name: 'runs', strokeClass: 'stroke-accent', areaClass: 'fill-accent/10', data: trend7d()?.points.map((p) => p.runs) ?? [] },
              { name: 'hits', strokeClass: 'stroke-cache-local', data: trend7d()?.points.map((p) => p.hits) ?? [] },
              { name: 'failures', strokeClass: 'stroke-danger', data: trend7d()?.points.map((p) => p.failures) ?? [] },
            ]}
            formatX={(t) => formatDate(t)}
            formatY={(v) => formatCount(v)}
            height={320}
          />
        </Show>
      </Card>

      <div class="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <Card title="Total duration per day (last 30d)">
          <Show when={trend7d()?.points.length} fallback={<EmptyState title="No data" />}>
            <LineChart
              xs={trend7d()?.points.map((p) => p.t) ?? []}
              series={[
                { name: 'duration', strokeClass: 'stroke-info', areaClass: 'fill-info/10', data: trend7d()?.points.map((p) => p.totalDurationMs) ?? [] },
              ]}
              formatX={(t) => formatDate(t)}
              formatY={(v) => formatDuration(v)}
              height={320}
            />
          </Show>
        </Card>

        <Card title="When you build" action={<span class="text-[10px] text-fg-3 font-mono">last 30d</span>}>
          <Show when={heat()?.some((c) => c.runs > 0)} fallback={<EmptyState title="No runs in the window" />}>
            <Heatmap
              data={(heat() ?? []).map((c) => ({ dayOfWeek: c.dayOfWeek, hourOfDay: c.hourOfDay, value: c.runs }))}
              cellSize={14}
              format={(v) => `${v} runs`}
            />
          </Show>
        </Card>
      </div>

      <Card title="Cache storage growth (entries added per day)">
        <Show when={storage()?.length} fallback={<EmptyState title="No cached output yet" />}>
          <LineChart
            xs={storage()?.map((p) => p.t) ?? []}
            series={[
              { name: 'bytes', strokeClass: 'stroke-accent-2', areaClass: 'fill-accent-2/10', data: storage()?.map((p) => p.bytesAdded) ?? [] },
            ]}
            formatX={(t) => formatDate(t)}
            formatY={(v) => formatBytes(v)}
            height={280}
          />
        </Show>
      </Card>

      <Card title="Parallelism factor per invocation" action={<span class="text-[10px] text-fg-3 font-mono">cpu sum / wall time — 1.0 = serial</span>}>
        <Show when={(parallel() ?? []).length > 0} fallback={<EmptyState title="No invocations recorded" />}>
          <div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <MetricCard
              label="Avg parallelism"
              value={((parallel() ?? []).reduce((a, p) => a + p.factor, 0) / Math.max(1, (parallel() ?? []).length)).toFixed(2) + '×'}
              sub="across recent runs"
            />
            <MetricCard
              label="Best invocation"
              value={Math.max(...(parallel() ?? []).map((p) => p.factor)).toFixed(2) + '×'}
            />
            <MetricCard
              label="Total CPU time"
              value={formatDuration((parallel() ?? []).reduce((a, p) => a + p.cpuSumMs, 0))}
            />
          </div>
          <div class="mt-4">
            <LineChart
              xs={[...(parallel() ?? [])].reverse().map((p) => p.startedAt)}
              series={[
                {
                  name: 'parallelism',
                  strokeClass: 'stroke-chart-3',
                  areaClass: 'fill-chart-3/10',
                  data: [...(parallel() ?? [])].reverse().map((p) => p.factor),
                },
              ]}
              formatX={(t) => formatDate(t)}
              formatY={(v) => v.toFixed(1) + '×'}
              height={240}
            />
          </div>
        </Show>
      </Card>
    </div>
  )
}
