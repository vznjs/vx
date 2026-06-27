import { For, Show, createMemo, createResource } from 'solid-js'
import { A, useParams } from '@solidjs/router'
import { getOriginSignal, getTaskDetail } from '../api.ts'
import { Card, EmptyState, MetricCard, StatusBadge } from '../components/ui.tsx'
import { LineChart } from '../components/charts.tsx'
import { formatBytes, formatCount, formatDuration, formatPercent, formatRelativeTime } from '../format.ts'

export function TaskDetail() {
  const params = useParams<{ id: string }>()
  // @solidjs/router gives the raw URL segment; decode for display + API use.
  const taskId = () => decodeURIComponent(params.id)
  const origin = getOriginSignal()
  const [detail] = createResource(
    () => ({ id: taskId(), o: origin() }),
    (args) => getTaskDetail(args.id),
  )

  // Series for the duration chart — oldest left, newest right.
  const durSeries = createMemo(() => {
    const recent = detail()?.recent ?? []
    return [...recent].reverse()
  })

  // CPU utilization = cpuMs / wall durationMs. >100% means the task used more
  // than one core's worth of CPU (multithreaded). Computed over real runs
  // (cache hits have ~0 duration → meaningless ratio).
  const cpuPct = (r: { cpuMs: number | null; durationMs: number; cacheHit: boolean | null }) =>
    r.cpuMs !== null && r.durationMs > 0 && r.cacheHit !== true
      ? (r.cpuMs / r.durationMs) * 100
      : undefined
  const cpuStats = createMemo(() => {
    const vals = (detail()?.recent ?? [])
      .map((r) => cpuPct(r))
      .filter((v): v is number => v !== undefined && Number.isFinite(v))
    if (vals.length === 0) return undefined
    return {
      avg: vals.reduce((a, b) => a + b, 0) / vals.length,
      max: Math.max(...vals),
    }
  })

  return (
    <div class="flex flex-col gap-5">
      <div class="flex items-center gap-3">
        <A href="/tasks" class="text-fg-3 hover:text-fg no-underline text-[11px] font-mono">← tasks</A>
        <h1 class="text-base font-semibold m-0 font-mono">{taskId()}</h1>
      </div>

      <Show when={detail.loading}>
        <div class="text-fg-3 text-sm">Loading…</div>
      </Show>
      <Show when={detail.error}>
        <div class="text-danger font-mono text-sm">Failed to load: {String(detail.error)}</div>
      </Show>
      <Show when={detail() === null}>
        <EmptyState title="No data for this task" cmd={`vx run ${taskId()}`} />
      </Show>

      <Show when={detail() !== undefined && detail() !== null}>
        {(() => {
          const d = detail() as NonNullable<ReturnType<typeof detail>>
          const agg = d.aggregate
          return (
            <>
              <Show when={agg}>
                <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                  <MetricCard label="Runs" value={String(agg!.runs)} sub={`${agg!.successes} ok · ${agg!.failures} fail`} />
                  <MetricCard
                    label="Success rate"
                    value={formatPercent(agg!.successRate, 0)}
                    tone={agg!.failureMode === 'stable' ? 'good' : agg!.failureMode === 'flaky-fatal' ? 'bad' : 'warn'}
                    sub={agg!.failureMode}
                  />
                  <MetricCard label="Hit rate" value={formatPercent(agg!.hitRate, 0)} sub={`${agg!.hits} hits`} />
                  <MetricCard label="Avg duration" value={formatDuration(agg!.avgDurationMs ?? 0)} sub={`p50 ${formatDuration(agg!.p50DurationMs ?? 0)} · p99 ${formatDuration(agg!.p99DurationMs ?? 0)}`} />
                  <MetricCard
                    label="CPU usage"
                    value={cpuStats() ? `${cpuStats()!.avg.toFixed(0)}%` : '—'}
                    sub={cpuStats() ? `avg · max ${cpuStats()!.max.toFixed(0)}%` : 'no timed runs'}
                  />
                  <MetricCard label="Last run" value={agg!.lastSeenAt !== undefined ? formatRelativeTime(agg!.lastSeenAt) : '—'} sub={`min ${formatDuration(agg!.minDurationMs ?? 0)} · max ${formatDuration(agg!.maxDurationMs ?? 0)}`} />
                </div>
              </Show>

              {/* Duration trend */}
              <Card title="Duration over recent runs" action={<span class="text-[10px] text-fg-3 font-mono">cache hits in cyan</span>}>
                <Show when={durSeries().length > 0} fallback={<EmptyState title="No runs yet" />}>
                  <LineChart
                    xs={durSeries().map((_, i) => i)}
                    series={[
                      {
                        name: 'duration',
                        strokeClass: 'stroke-accent',
                        areaClass: 'fill-accent/10',
                        data: durSeries().map((r) => r.durationMs),
                      },
                    ]}
                    formatX={(i) => `run ${i + 1}`}
                    formatY={(v) => formatDuration(v)}
                    height={280}
                  />
                </Show>
              </Card>

              {/* Latest cache entry */}
              <Show when={d.latestEntry}>
                {(() => {
                  const e = d.latestEntry!
                  return (
                    <Card title="Latest cache entry">
                      <div class="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-2 text-[12px]">
                        <KV label="hash" value={<code class="font-mono text-fg-1">{e.hash.slice(0, 16)}…</code>} />
                        <KV label="size" value={formatBytes(e.sizeBytes)} />
                        <KV label="duration" value={formatDuration(e.durationMs)} />
                        <KV label="created" value={formatRelativeTime(e.createdAt)} />
                        <KV label="accessed" value={formatRelativeTime(e.accessedAt)} />
                        <KV label="exit" value={String(e.exitCode)} />
                      </div>
                      <div class="mt-3 text-[11px] text-fg-3">$ <code class="text-fg-1 font-mono">{e.command}</code></div>
                    </Card>
                  )
                })()}
              </Show>

              {/* Full history */}
              <Card title={`Recent runs (${d.recent.length})`} noPad>
                <table class="w-full text-[12px]">
                  <thead class="bg-surface-2/40">
                    <tr class="text-fg-3 text-[10px] uppercase tracking-wider">
                      <th class="text-left px-4 py-2 font-semibold">When</th>
                      <th class="text-left px-4 py-2 font-semibold">Status</th>
                      <th class="text-right px-4 py-2 font-semibold">Duration</th>
                      <th class="text-right px-4 py-2 font-semibold">CPU</th>
                      <th class="text-right px-4 py-2 font-semibold">CPU %</th>
                      <th class="text-right px-4 py-2 font-semibold">Peak RSS</th>
                      <th class="text-right px-4 py-2 font-semibold">Hash</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={d.recent}>
                      {(r) => {
                        const pct = cpuPct(r)
                        return (
                          <tr class="border-t border-border">
                            <td class="px-4 py-1.5 text-fg-3 text-[10px] font-mono">{formatRelativeTime(r.startedAt)}</td>
                            <td class="px-4 py-1.5">
                              <StatusBadge status={r.status} cacheHit={r.cacheHit} />
                            </td>
                            <td class="px-4 py-1.5 text-right font-mono">{formatDuration(r.durationMs)}</td>
                            <td class="px-4 py-1.5 text-right text-fg-3 font-mono">{r.cpuMs !== null ? formatDuration(r.cpuMs) : '—'}</td>
                            <td class="px-4 py-1.5 text-right font-mono" classList={{ 'text-chart-3': pct !== undefined && pct > 100, 'text-fg-3': pct === undefined || pct <= 100 }}>{pct !== undefined ? `${pct.toFixed(0)}%` : '—'}</td>
                            <td class="px-4 py-1.5 text-right text-fg-3 font-mono">{r.peakRssBytes !== null && r.peakRssBytes > 0 ? formatBytes(r.peakRssBytes) : '—'}</td>
                            <td class="px-4 py-1.5 text-right font-mono text-[10px] text-fg-3">{r.hash.slice(0, 10)}…</td>
                          </tr>
                        )
                      }}
                    </For>
                  </tbody>
                </table>
              </Card>
            </>
          )
        })()}
      </Show>
    </div>
  )
}

function KV(props: { label: string; value: any }) {
  return (
    <div class="flex gap-3 items-baseline">
      <span class="text-fg-3 text-[10px] uppercase tracking-wider w-20">{props.label}</span>
      <span>{props.value}</span>
    </div>
  )
}
