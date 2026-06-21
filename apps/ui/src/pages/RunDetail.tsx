import { For, Show, createMemo, createResource } from 'solid-js'
import { A, useNavigate, useParams } from '@solidjs/router'
import { getOriginSignal, getRun } from '../api.ts'
import { Flamegraph } from '../components/Flamegraph.tsx'
import { Card, EmptyState, MetricCard, StatusBadge } from '../components/ui.tsx'
import { formatBytes, formatDuration, formatRelativeTime } from '../format.ts'

export function RunDetail() {
  const params = useParams<{ id: string }>()
  const origin = getOriginSignal()
  const navigate = useNavigate()
  const [run] = createResource(() => ({ id: params.id, o: origin() }), (args) => getRun(args.id))

  const totals = createMemo(() => {
    const tasks = run()?.tasks ?? []
    return {
      total: tasks.reduce((a, t) => a + (t.durationMs ?? 0), 0),
      successes: tasks.filter((t) => t.status === 'success').length,
      failures: tasks.filter((t) => t.status === 'failed').length,
      hits: tasks.filter((t) => t.cacheHit === true).length,
      cpu: tasks.reduce((a, t) => a + (t.cpuMs ?? 0), 0),
    }
  })

  return (
    <div class="flex flex-col gap-5">
      <div class="flex items-center gap-3">
        <A href="/" class="text-fg-3 hover:text-fg no-underline text-[11px] font-mono">← runs</A>
        <h1 class="text-base font-semibold m-0 font-mono">Run {params.id.slice(0, 12)}</h1>
      </div>

      <Show when={run.loading}><div class="text-fg-3 text-sm">Loading…</div></Show>
      <Show when={run.error}><div class="text-danger font-mono text-sm">Failed to load: {String(run.error)}</div></Show>
      <Show when={run() === null}><EmptyState title="Run not found" /></Show>

      <Show when={run() !== undefined && run() !== null}>
        {(() => {
          const r = run()!
          const t = totals()
          const startMs = Math.min(...r.tasks.map((x) => x.startedAt))
          const wall = Math.max(...r.tasks.map((x) => x.endedAt)) - startMs
          return (
            <>
              <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
                <MetricCard label="Tasks" value={String(r.tasks.length)} sub={`${t.successes} ok · ${t.failures} fail · ${t.hits} hits`} />
                <MetricCard label="Wall time" value={formatDuration(wall)} sub={`started ${formatRelativeTime(startMs)}`} />
                <MetricCard label="Total task time" value={formatDuration(t.total)} sub="sum across all tasks" />
                <MetricCard label="CPU time" value={formatDuration(t.cpu)} sub={wall > 0 ? `${(t.cpu / wall).toFixed(2)}× parallelism` : ''} />
                <MetricCard label="Outcome" value={t.failures > 0 ? 'failed' : 'success'} tone={t.failures > 0 ? 'bad' : 'good'} />
              </div>

              <Card title="Timeline">
                <Flamegraph tasks={r.tasks} />
              </Card>

              <Card title={`Tasks (${r.tasks.length})`} noPad>
                <table class="w-full text-[12px]">
                  <thead class="bg-surface-2/40">
                    <tr class="text-fg-3 text-[10px] uppercase tracking-wider">
                      <th class="text-left px-4 py-2 font-semibold">Task</th>
                      <th class="text-left px-4 py-2 font-semibold">Status</th>
                      <th class="text-right px-4 py-2 font-semibold">Duration</th>
                      <th class="text-right px-4 py-2 font-semibold">CPU</th>
                      <th class="text-right px-4 py-2 font-semibold">Peak RSS</th>
                      <th class="text-right px-4 py-2 font-semibold">Cache</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={r.tasks}>
                      {(task) => (
                        <tr
                          class="border-t border-border hover:bg-surface-hover cursor-pointer"
                          onClick={() => navigate(`/tasks/${encodeURIComponent(`${task.project}#${task.task}`)}`)}
                        >
                          <td class="px-4 py-1.5 font-mono">
                            <span class="text-fg-3">{task.project}#</span>{task.task}
                          </td>
                          <td class="px-4 py-1.5"><StatusBadge status={task.status} cacheHit={task.cacheHit} /></td>
                          <td class="px-4 py-1.5 text-right font-mono">{formatDuration(task.durationMs)}</td>
                          <td class="px-4 py-1.5 text-right font-mono text-fg-3">{task.cpuMs !== null ? formatDuration(task.cpuMs) : '—'}</td>
                          <td class="px-4 py-1.5 text-right font-mono text-fg-3">{task.peakRssBytes !== null && task.peakRssBytes > 0 ? formatBytes(task.peakRssBytes) : '—'}</td>
                          <td class="px-4 py-1.5 text-right font-mono text-cache-local">{task.cacheHit === true ? 'hit' : 'miss'}</td>
                        </tr>
                      )}
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
