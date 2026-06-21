import { For, Show, createResource } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { listRuns } from '../api.ts'
import { formatDuration, formatRelativeTime } from '../format.ts'

export function Overview() {
  const [runs] = createResource(() => listRuns(50))
  const navigate = useNavigate()
  return (
    <div class="flex flex-col gap-4">
      <h1 class="text-xl font-semibold m-0">Recent runs</h1>
      <Show when={runs.error}>
        <div class="text-failure font-mono text-sm">
          Failed to load runs: {String(runs.error)}
        </div>
      </Show>
      <Show when={runs.loading}>
        <div class="text-fg-muted text-sm">Loading DuckDB (one-time, ~30MB)…</div>
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
                    onClick={() => navigate(`/runs/${r.run_id}`)}
                  >
                    <td class="px-3 py-2 font-mono text-xs">{r.run_id.slice(0, 8)}…</td>
                    <td class="px-3 py-2 text-right text-fg-muted">
                      {formatRelativeTime(Number(r.started_at))}
                    </td>
                    <td class="px-3 py-2 text-right">{formatDuration(Number(r.duration_ms))}</td>
                    <td class="px-3 py-2 text-right">{Number(r.total)}</td>
                    <td
                      class="px-3 py-2 text-right"
                      classList={{ 'text-failure': Number(r.failed) > 0 }}
                    >
                      {Number(r.failed)}
                    </td>
                    <td class="px-3 py-2 text-right text-cache">{Number(r.cache_hits)}</td>
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
