import type { Component } from 'solid-js'
import { createResource, For, Show } from 'solid-js'
import { fetchJson, type OverviewResponse, type RunSummary } from '../api.ts'
import { formatAge, formatBytes, formatDurationMs, formatPercent, shortRunId } from '../format.ts'
import { AsyncView } from '../components/AsyncView.tsx'
import { Card } from '../components/Card.tsx'
import { Empty } from '../components/Empty.tsx'

export const Overview: Component = () => {
  const [data] = createResource(() => fetchJson<OverviewResponse>('/api/overview'))

  return (
    <section>
      <h1 class="text-fg text-2xl font-semibold tracking-tight mb-6">Overview</h1>
      <AsyncView resource={data}>
        {(d) => (
          <>
            <div class="flex flex-wrap gap-3 mb-8">
              <Card
                label="Cache entries"
                value={d.cache.entryCount.toLocaleString()}
                sub={formatBytes(d.cache.totalBytes)}
              />
              <Card label="Runs (24h)" value={d.cache.runCountLast24h.toLocaleString()} />
              <Card label="Cache hits (24h)" value={d.cache.hitCountLast24h.toLocaleString()} />
              <Card label="Hit rate (24h)" value={formatPercent(d.cache.hitRateLast24h)} />
            </div>
            <h2 class="text-fg text-lg font-semibold mb-3">Recent runs</h2>
            <Show
              when={d.recentRuns.length > 0}
              fallback={
                <Empty>
                  no runs recorded yet — run{' '}
                  <code class="font-mono text-fg">vzn run &lt;task&gt;</code>
                </Empty>
              }
            >
              <RunsTable runs={d.recentRuns} />
            </Show>
          </>
        )}
      </AsyncView>
    </section>
  )
}

const RunsTable: Component<{ runs: RunSummary[] }> = (props) => (
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
        <For each={props.runs}>
          {(r) => (
            <tr class="border-t border-border-muted hover:bg-bg-muted">
              <td class="px-4 py-2 font-mono text-accent">
                <a href={`#/runs/${encodeURIComponent(r.runId)}`}>{shortRunId(r.runId)}</a>
              </td>
              <td class="px-4 py-2 text-fg-muted" title={new Date(r.startedAt).toLocaleString()}>
                {formatAge(r.startedAt)}
              </td>
              <td class="px-4 py-2 text-right tabular-nums">{formatDurationMs(r.durationMs)}</td>
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
)
