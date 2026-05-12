import type { Component } from 'solid-js'
import { createResource, For, Show } from 'solid-js'
import { fetchJson, type RunSummary } from '../api.ts'
import { formatAge, formatDurationMs, shortRunId } from '../format.ts'
import { AsyncView } from '../components/AsyncView.tsx'
import { Empty } from '../components/Empty.tsx'

export const Runs: Component = () => {
  const [data] = createResource(() => fetchJson<RunSummary[]>('/api/runs?limit=200'))

  return (
    <section>
      <h1 class="text-fg text-2xl font-semibold tracking-tight mb-2">Runs</h1>
      <p class="text-fg-muted mb-6">
        Every <code class="font-mono text-fg">vzn run</code> invocation. Click a row to inspect each
        task's wall-clock span on the flamegraph.
      </p>
      <AsyncView resource={data}>
        {(rows) => (
          <Show
            when={rows.length > 0}
            fallback={
              <Empty>
                no runs recorded yet — invoke{' '}
                <code class="font-mono text-fg">vzn run &lt;task&gt;</code>
              </Empty>
            }
          >
            <div class="bg-bg-elevated border border-border rounded-lg overflow-hidden">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-fg-subtle uppercase text-xs tracking-wider">
                    <th class="text-left px-4 py-2.5 font-medium">Run</th>
                    <th class="text-left px-4 py-2.5 font-medium">Started</th>
                    <th class="text-right px-4 py-2.5 font-medium">Duration</th>
                    <th class="text-right px-4 py-2.5 font-medium">Tasks</th>
                    <th class="text-right px-4 py-2.5 font-medium">OK</th>
                    <th class="text-right px-4 py-2.5 font-medium">Cached</th>
                    <th class="text-right px-4 py-2.5 font-medium">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={rows}>
                    {(r) => (
                      <tr class="border-t border-border-muted hover:bg-bg-muted">
                        <td class="px-4 py-2 font-mono text-accent">
                          <a href={`#/runs/${encodeURIComponent(r.runId)}`}>
                            {shortRunId(r.runId)}
                          </a>
                        </td>
                        <td
                          class="px-4 py-2 text-fg-muted"
                          title={new Date(r.startedAt).toLocaleString()}
                        >
                          {formatAge(r.startedAt)}
                        </td>
                        <td class="px-4 py-2 text-right tabular-nums">
                          {formatDurationMs(r.durationMs)}
                        </td>
                        <td class="px-4 py-2 text-right tabular-nums">{r.taskCount}</td>
                        <td class="px-4 py-2 text-right tabular-nums">{r.successCount}</td>
                        <td class="px-4 py-2 text-right tabular-nums">{r.cacheHitCount}</td>
                        <td class="px-4 py-2 text-right tabular-nums">
                          <Show when={r.failedCount > 0} fallback="0">
                            <span class="text-err font-semibold">{r.failedCount}</span>
                          </Show>
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
