import type { Component } from 'solid-js'
import { createResource, For, Show } from 'solid-js'
import { fetchJson, type SlowestTask } from '../api.ts'
import { formatDurationMs } from '../format.ts'
import { AsyncView } from '../components/AsyncView.tsx'
import { Empty } from '../components/Empty.tsx'

export const Tasks: Component = () => {
  const [data] = createResource(() => fetchJson<SlowestTask[]>('/api/tasks/slowest?limit=200'))

  return (
    <section>
      <h1 class="text-fg text-2xl font-semibold tracking-tight mb-2">Tasks</h1>
      <p class="text-fg-muted mb-6 max-w-2xl">
        Ranked by average wall-clock duration. Cache hits are excluded so the ranking reflects work
        actually done, not cached.
      </p>
      <AsyncView resource={data}>
        {(rows) => (
          <Show when={rows.length > 0} fallback={<Empty>no successful task runs yet</Empty>}>
            <div class="bg-bg-elevated border border-border rounded-lg overflow-hidden">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-fg-subtle uppercase text-xs tracking-wider">
                    <th class="text-left px-4 py-2.5 font-medium">Project</th>
                    <th class="text-left px-4 py-2.5 font-medium">Task</th>
                    <th class="text-right px-4 py-2.5 font-medium">Runs</th>
                    <th class="text-right px-4 py-2.5 font-medium">Avg duration</th>
                    <th class="text-right px-4 py-2.5 font-medium">Max duration</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={rows}>
                    {(t) => (
                      <tr class="border-t border-border-muted hover:bg-bg-muted">
                        <td class="px-4 py-2 font-mono text-fg">{t.project}</td>
                        <td class="px-4 py-2 font-mono text-fg">{t.task}</td>
                        <td class="px-4 py-2 text-right tabular-nums">{t.runCount}</td>
                        <td class="px-4 py-2 text-right tabular-nums">
                          {formatDurationMs(t.avgDurationMs)}
                        </td>
                        <td class="px-4 py-2 text-right tabular-nums">
                          {formatDurationMs(t.maxDurationMs)}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        )}
      </AsyncView>
    </section>
  )
}
