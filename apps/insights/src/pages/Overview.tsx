import { For, Show, createResource } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { getCacheStats, getOriginSignal, listInvocations } from '../api.ts'
import { formatDuration, formatRelativeTime } from '../format.ts'

export function Overview() {
  const origin = getOriginSignal()
  const [runs] = createResource(origin, () => listInvocations(50))
  const [stats] = createResource(origin, () => getCacheStats())
  const navigate = useNavigate()
  return (
    <div class="flex flex-col gap-6">
      <Show when={stats() !== undefined}>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Cache entries" value={String(stats()!.entryCount)} />
          <Stat
            label="Cache size"
            value={`${(stats()!.totalBytes / 1024 / 1024).toFixed(1)} MB`}
          />
          <Stat label="Runs (24h)" value={String(stats()!.runCountLast24h)} />
          <Stat
            label="Hit rate (24h)"
            value={`${(stats()!.hitRate24h * 100).toFixed(0)}%`}
          />
        </div>
      </Show>
      <h2 class="text-base font-semibold m-0">Recent invocations</h2>
      <Show when={runs.error}>
        <div class="text-failure font-mono text-sm">
          Failed to load: {String(runs.error)}. Is vx serve running at <code>{origin()}</code>?
        </div>
      </Show>
      <Show when={runs.loading}>
        <div class="text-fg-muted text-sm">Loading…</div>
      </Show>
      <Show when={runs() !== undefined}>
        <div class="border border-border-muted rounded overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-bg-elevated text-fg-muted text-xs uppercase tracking-wider">
              <tr>
                <th class="text-left px-3 py-2 font-medium">Run</th>
                <th class="text-right px-3 py-2 font-medium">Started</th>
                <th class="text-right px-3 py-2 font-medium">Duration</th>
                <th class="text-right px-3 py-2 font-medium">Tasks</th>
                <th class="text-right px-3 py-2 font-medium">Failed</th>
                <th class="text-right px-3 py-2 font-medium">Cache hits</th>
              </tr>
            </thead>
            <tbody>
              <For each={runs() ?? []}>
                {(r) => (
                  <tr
                    class="border-t border-border-muted hover:bg-bg-elevated cursor-pointer"
                    onClick={() => navigate(`/runs/${r.runId}`)}
                  >
                    <td class="px-3 py-2 font-mono text-xs">{r.runId.slice(0, 8)}…</td>
                    <td class="px-3 py-2 text-right text-fg-muted">
                      {formatRelativeTime(r.startedAt)}
                    </td>
                    <td class="px-3 py-2 text-right">{formatDuration(r.totalDurationMs)}</td>
                    <td class="px-3 py-2 text-right">{r.taskCount}</td>
                    <td
                      class="px-3 py-2 text-right"
                      classList={{ 'text-failure': r.failedCount > 0 }}
                    >
                      {r.failedCount}
                    </td>
                    <td class="px-3 py-2 text-right text-cache">{r.hitCount}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <Show when={(runs() ?? []).length === 0}>
            <div class="px-3 py-8 text-fg-muted text-sm text-center">
              No runs recorded yet. Run a task with <code>vx run</code> to populate this view.
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function Stat(props: { label: string; value: string }) {
  return (
    <div class="border border-border-muted rounded px-3 py-2 bg-bg-elevated">
      <div class="text-fg-muted text-[10px] uppercase tracking-wider">{props.label}</div>
      <div class="text-lg font-mono">{props.value}</div>
    </div>
  )
}
