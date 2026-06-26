import { For, Show, createMemo, createResource } from 'solid-js'
import { A, useNavigate, useParams } from '@solidjs/router'
import { getHistory, getOriginSignal, listProjects, type ProjectRollup, type TaskHistoryRow } from '../api.ts'
import { Card, EmptyState, MetricCard } from '../components/ui.tsx'
import { HBar } from '../components/charts.tsx'
import { formatBytes, formatDuration, formatPercent, formatRelativeTime, paletteFor } from '../format.ts'

export function ProjectDetail() {
  const params = useParams<{ name: string }>()
  // @solidjs/router gives the raw URL segment; decode for display + API use.
  const projectName = () => decodeURIComponent(params.name)
  const origin = getOriginSignal()
  const navigate = useNavigate()

  const [projects] = createResource(() => ({ name: projectName(), o: origin() }), async () => listProjects(500))
  const [tasks] = createResource(
    () => ({ name: projectName(), o: origin() }),
    async (args) => {
      const all = await getHistory(500)
      return all.filter((t: TaskHistoryRow) => t.project === args.name)
    },
  )

  const summary = createMemo<ProjectRollup | undefined>(() =>
    (projects() ?? []).find((p) => p.project === projectName()),
  )
  const maxTotal = createMemo(() => Math.max(1, ...(tasks() ?? []).map((t) => t.totalDurationMs)))

  return (
    <div class="flex flex-col gap-5">
      <div class="flex items-center gap-3">
        <A href="/projects" class="text-fg-3 hover:text-fg no-underline text-[11px] font-mono">← projects</A>
        <span class={`inline-block w-2 h-2 rounded-full bg-${paletteFor(projectName())}`} />
        <h1 class="text-base font-semibold m-0 font-mono">{projectName()}</h1>
      </div>

      <Show when={summary()} fallback={<EmptyState title="No data for this project" />}>
        <div class="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <MetricCard label="Total runs" value={String(summary()!.runs)} sub={`${summary()!.taskCount} tasks`} />
          <MetricCard label="Total time" value={formatDuration(summary()!.totalDurationMs)} sub={`avg ${formatDuration(summary()!.avgDurationMs)}`} />
          <MetricCard label="Time saved" value={formatDuration(summary()!.estimatedTimeSavedMs)} sub={`${summary()!.hits} hits`} tone="good" />
          <MetricCard label="Hit rate" value={formatPercent(summary()!.hitRate, 0)} tone={summary()!.hitRate > 0.5 ? 'good' : 'default'} />
          <MetricCard label="Cache" value={formatBytes(summary()!.cacheBytes)} sub={`${summary()!.cacheEntries} entries`} />
        </div>
      </Show>

      <Card title={`Tasks (${(tasks() ?? []).length})`} noPad>
        <Show when={(tasks() ?? []).length > 0} fallback={<EmptyState title="No tasks recorded" />}>
          <table class="w-full text-[12px]">
            <thead class="bg-surface-2/40">
              <tr class="text-fg-3 text-[10px] uppercase tracking-wider">
                <th class="text-left px-4 py-2 font-semibold">Task</th>
                <th class="text-right px-4 py-2 font-semibold">Runs</th>
                <th class="text-right px-4 py-2 font-semibold">Success</th>
                <th class="text-right px-4 py-2 font-semibold">Hit</th>
                <th class="text-right px-4 py-2 font-semibold">Avg</th>
                <th class="text-right px-4 py-2 font-semibold">p99</th>
                <th class="text-right px-4 py-2 font-semibold">Total</th>
                <th class="text-right px-4 py-2 font-semibold">Last</th>
              </tr>
            </thead>
            <tbody>
              <For each={tasks()!}>
                {(t) => (
                  <tr
                    class="border-t border-border hover:bg-surface-hover cursor-pointer"
                    onClick={() => navigate(`/tasks/${encodeURIComponent(t.id)}`)}
                  >
                    <td class="px-4 py-2 font-mono">
                      <span class="text-fg-3">{t.project}#</span>{t.task}
                    </td>
                    <td class="px-4 py-2 text-right font-mono">{t.runs}</td>
                    <td class="px-4 py-2 text-right font-mono" classList={{ 'text-danger': t.successRate < 0.9 }}>
                      {formatPercent(t.successRate, 0)}
                    </td>
                    <td class="px-4 py-2 text-right font-mono text-cache-local">{formatPercent(t.hitRate, 0)}</td>
                    <td class="px-4 py-2 text-right font-mono">{formatDuration(t.avgDurationMs ?? 0)}</td>
                    <td class="px-4 py-2 text-right font-mono">{formatDuration(t.p99DurationMs ?? 0)}</td>
                    <td class="px-4 py-2 text-right font-mono">
                      <div class="flex items-center gap-2 justify-end">
                        <span class="w-14">{formatDuration(t.totalDurationMs)}</span>
                        <div class="w-16"><HBar fraction={t.totalDurationMs / maxTotal()} colorClass={`bg-${paletteFor(t.project)}`} /></div>
                      </div>
                    </td>
                    <td class="px-4 py-2 text-right text-fg-3 font-mono text-[10px]">{t.lastSeenAt !== undefined ? formatRelativeTime(t.lastSeenAt) : '—'}</td>
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
