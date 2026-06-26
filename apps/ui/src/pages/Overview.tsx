import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js'
import { A, useNavigate } from '@solidjs/router'
import {
  getCacheSavings,
  getCacheStats,
  getFailures,
  getOriginSignal,
  getRunTrends,
  getTopTasks,
  listInvocations,
  listProjects,
  subscribeEvents,
} from '../api.ts'
import { LineChart, Treemap } from '../components/charts.tsx'
import { Card, EmptyState, MetricCard } from '../components/ui.tsx'
import { formatBytes, formatCount, formatDate, formatDuration, formatHour, formatPercent, formatRelativeTime, paletteFor } from '../format.ts'

export function Overview() {
  const origin = getOriginSignal()
  const navigate = useNavigate()

  const [stats] = createResource(origin, () => getCacheStats())
  const [savings] = createResource(origin, () => getCacheSavings())
  const [topTasks] = createResource(origin, () => getTopTasks(8))
  const [failures] = createResource(origin, () => getFailures(8))
  const [projects] = createResource(origin, () => listProjects(50))
  const [invocations] = createResource(origin, () => listInvocations(12))
  // 30-day day-bucketed series → real signal even on workspaces whose last
  // run was &gt;24h ago. A 24h hour-bucket chart goes blank too easily.
  const [trend30d] = createResource(origin, () => getRunTrends({ bucket: 'day' }))

  // Live event ticker — newest first, keep last 12.
  const [live, setLive] = createSignal<Array<{ id: number; kind: string; label: string; t: number }>>([])
  let liveSeq = 0
  onMount(() => {
    const unsub = subscribeEvents((env: unknown) => {
      const ev = (env as { params?: { kind?: string; node?: { id?: string }; outcome?: { node?: { id?: string }; status?: string } } }).params
      if (!ev?.kind) return
      let label = ''
      if (ev.kind === 'task:start') label = `▶ ${ev.node?.id ?? ''}`
      else if (ev.kind === 'task:complete') label = `${ev.outcome?.status === 'failed' ? '✗' : '✓'} ${ev.outcome?.node?.id ?? ''}`
      else if (ev.kind === 'run:start') label = '· run started'
      else if (ev.kind === 'run:end') label = '· run finished'
      else return
      setLive((prev) => [{ id: ++liveSeq, kind: ev.kind, label, t: Date.now() }, ...prev].slice(0, 12))
    })
    onCleanup(unsub)
  })

  // Lifetime totals — always have signal, unlike 24h windows.
  const totalRuns = createMemo(() => (projects() ?? []).reduce((a, p) => a + p.runs, 0))
  const totalHits = createMemo(() => (projects() ?? []).reduce((a, p) => a + p.hits, 0))
  const totalFails = createMemo(() => (projects() ?? []).reduce((a, p) => a + p.failures, 0))
  const lifetimeHitRate = createMemo(() => (totalRuns() > 0 ? totalHits() / totalRuns() : 0))

  const last30dRuns = createMemo(() => trend30d()?.points.reduce((a, p) => a + p.runs, 0) ?? 0)
  const last30dDur = createMemo(() => trend30d()?.points.reduce((a, p) => a + p.totalDurationMs, 0) ?? 0)
  const last30dHits = createMemo(() => trend30d()?.points.reduce((a, p) => a + p.hits, 0) ?? 0)

  const trendXs = () => trend30d()?.points.map((p) => p.t) ?? []
  const trendRuns = () => trend30d()?.points.map((p) => p.runs) ?? []

  return (
    <div class="flex flex-col gap-5">
      <Show when={stats() && savings()}>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MetricCard
            label="Time saved"
            value={formatDuration(savings()!.estimatedTimeSavedTotalMs)}
            sub={`${totalHits()} cache hits`}
            tone={savings()!.estimatedTimeSavedTotalMs > 0 ? 'good' : 'default'}
          />
          <MetricCard
            label="Hit rate"
            value={formatPercent(lifetimeHitRate(), 0)}
            sub={`${totalHits()} / ${totalRuns()} runs`}
            tone={lifetimeHitRate() > 0.5 ? 'good' : lifetimeHitRate() < 0.2 && totalRuns() > 5 ? 'warn' : 'default'}
          />
          <MetricCard
            label="Total runs"
            value={String(totalRuns())}
            sub={totalFails() > 0 ? `${totalFails()} failed (${formatPercent(totalFails() / Math.max(1, totalRuns()), 0)})` : 'no failures'}
            tone={totalFails() > 0 ? 'bad' : 'good'}
          />
          <MetricCard
            label="Cache footprint"
            value={formatBytes(stats()!.totalBytes)}
            sub={`${stats()!.entryCount} entries`}
          />
        </div>
      </Show>

      <div class="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
        <Card title="Activity — last 30 days" action={<span class="text-[10px] text-fg-3 font-mono">runs · failures</span>}>
          <Show when={last30dRuns() > 0} fallback={<EmptyState title="No runs in the last 30 days" cmd="vx run <task>" />}>
            <LineChart
              xs={trendXs()}
              series={[
                { name: 'runs', strokeClass: 'stroke-accent', areaClass: 'fill-accent/10', data: trendRuns() },
                { name: 'failures', strokeClass: 'stroke-danger', data: trend30d()?.points.map((p) => p.failures) ?? [] },
              ]}
              formatX={(t) => formatDate(t)}
              formatY={(v) => formatCount(v)}
              height={180}
            />
            <div class="text-[11px] text-fg-3 mt-2 font-mono">
              {last30dRuns()} runs · {formatDuration(last30dDur())} total · {last30dHits()} hits
            </div>
          </Show>
        </Card>

        <Card title="Live activity" action={<span class="inline-flex items-center gap-1 text-[10px] text-success font-mono"><span class="inline-block w-1.5 h-1.5 rounded-full bg-success animate-pulse" />SSE</span>}>
          <Show when={live().length > 0} fallback={<div class="text-fg-3 text-xs text-center py-6">Waiting for events…</div>}>
            <div class="flex flex-col gap-1 max-h-[200px] overflow-y-auto">
              <For each={live()}>
                {(e) => (
                  <div class="flex items-center gap-2 text-[11px] font-mono">
                    <span class="text-fg-3 w-12 shrink-0">{formatHour(e.t)}</span>
                    <span class={
                      e.kind === 'task:complete' && e.label.startsWith('✗') ? 'text-danger truncate' :
                      e.kind === 'task:complete' ? 'text-success truncate' :
                      e.kind.startsWith('run:') ? 'text-fg-3 truncate' :
                      'text-fg-1 truncate'
                    }>{e.label}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Card>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Top time-burners" action={<A href="/tasks" class="text-[11px] text-accent no-underline hover:underline">all tasks</A>} noPad>
          <Show when={topTasks()?.length} fallback={<EmptyState title="Nothing executed yet" cmd="vx run <task>" />}>
            <div class="flex flex-col">
              <For each={topTasks()!}>
                {(t, i) => (
                  <button
                    onClick={() => navigate(`/tasks/${encodeURIComponent(t.id)}`)}
                    class="flex items-center gap-2 px-4 py-2 hover:bg-surface-hover text-left border-t border-border first:border-t-0"
                  >
                    <span class="text-[10px] font-mono text-fg-3 w-4">{i() + 1}.</span>
                    <span class="text-[12px] font-mono truncate flex-1">{t.id}</span>
                    <span class="text-[11px] text-fg-3 font-mono">{t.runs}×</span>
                    <span class="text-[12px] font-mono text-fg ml-2">{formatDuration(t.totalDurationMs)}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Card>

        <Card title="Recent failures" action={<A href="/tasks" class="text-[11px] text-accent no-underline hover:underline">all tasks</A>} noPad>
          <Show when={failures()?.length} fallback={<div class="text-fg-3 text-xs text-center py-12">No failures. <span class="text-success">🎉</span></div>}>
            <div class="flex flex-col">
              <For each={failures()!}>
                {(f) => (
                  <button
                    onClick={() => navigate(`/tasks/${encodeURIComponent(`${f.project}#${f.task}`)}`)}
                    class="flex items-center gap-2 px-4 py-2 hover:bg-surface-hover text-left border-t border-border first:border-t-0"
                  >
                    <span class="text-[12px] font-mono truncate flex-1">{f.project}<span class="text-fg-3">#</span>{f.task}</span>
                    <span class="text-[10px] text-danger font-mono">exit {f.exitCode}</span>
                    <span class="text-[10px] text-fg-3 font-mono w-16 text-right">{formatRelativeTime(f.startedAt)}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Card>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <Card title="Cache footprint by project" action={<A href="/cache" class="text-[11px] text-accent no-underline hover:underline">cache</A>}>
          <Show when={projects()?.some((p) => p.cacheBytes > 0)} fallback={<EmptyState title="No cached output yet" />}>
            <Treemap
              data={(projects() ?? []).filter((p) => p.cacheBytes > 0).map((p) => ({
                label: p.project,
                value: p.cacheBytes,
                colorClass: `fill-${paletteFor(p.project)}`,
              }))}
              format={(v) => formatBytes(v)}
              height={240}
            />
          </Show>
        </Card>

        <Card title="Project leaderboard" action={<A href="/projects" class="text-[11px] text-accent no-underline hover:underline">all</A>} noPad>
          <Show when={projects()?.length} fallback={<EmptyState title="No projects discovered" />}>
            <div class="flex flex-col">
              <For each={(projects() ?? []).slice(0, 6)}>
                {(p) => {
                  const maxTime = Math.max(...(projects() ?? []).map((x) => x.totalDurationMs))
                  const pct = maxTime > 0 ? (p.totalDurationMs / maxTime) * 100 : 0
                  return (
                    <button
                      onClick={() => navigate(`/projects/${encodeURIComponent(p.project)}`)}
                      class="flex flex-col gap-1 px-4 py-2 hover:bg-surface-hover text-left border-t border-border first:border-t-0"
                    >
                      <div class="flex items-center gap-2 text-[12px]">
                        <span class="font-mono truncate flex-1">{p.project}</span>
                        <span class="text-fg-3 font-mono text-[10px]">{p.runs}×</span>
                        <span class="font-mono">{formatDuration(p.totalDurationMs)}</span>
                      </div>
                      <div class="h-1 bg-surface-2 rounded-full overflow-hidden">
                        <div class={`h-full bg-${paletteFor(p.project)}`} style={{ width: `${pct.toFixed(1)}%` }} />
                      </div>
                    </button>
                  )
                }}
              </For>
            </div>
          </Show>
        </Card>
      </div>

      <Card title="Recent invocations" noPad>
        <Show when={invocations()?.length} fallback={<EmptyState title="No invocations yet" cmd="vx run <task>" />}>
          <table class="w-full text-[12px]">
            <thead class="bg-surface-2/40">
              <tr class="text-fg-3 text-[10px] uppercase tracking-wider">
                <th class="text-left px-4 py-2 font-semibold">Run</th>
                <th class="text-right px-4 py-2 font-semibold">Started</th>
                <th class="text-right px-4 py-2 font-semibold">Duration</th>
                <th class="text-right px-4 py-2 font-semibold">Tasks</th>
                <th class="text-right px-4 py-2 font-semibold">Failed</th>
                <th class="text-right px-4 py-2 font-semibold">Hits</th>
              </tr>
            </thead>
            <tbody>
              <For each={invocations()!}>
                {(r) => (
                  <tr
                    class="border-t border-border hover:bg-surface-hover cursor-pointer"
                    onClick={() => navigate(`/runs/${r.runId}`)}
                  >
                    <td class="px-4 py-1.5 font-mono text-[11px] text-fg-2">{r.runId.slice(0, 8)}…</td>
                    <td class="px-4 py-1.5 text-right text-fg-3 font-mono">{formatRelativeTime(r.startedAt)}</td>
                    <td class="px-4 py-1.5 text-right font-mono">{formatDuration(r.totalDurationMs)}</td>
                    <td class="px-4 py-1.5 text-right font-mono">{r.taskCount}</td>
                    <td class="px-4 py-1.5 text-right font-mono" classList={{ 'text-danger': r.failedCount > 0 }}>{r.failedCount}</td>
                    <td class="px-4 py-1.5 text-right text-cache-local font-mono">{r.hitCount}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </Card>
    </div>
  )
}
