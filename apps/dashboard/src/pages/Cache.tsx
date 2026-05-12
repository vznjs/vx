import type { Component } from 'solid-js'
import { createResource, For, Show } from 'solid-js'
import { fetchJson, type CacheEntryRow } from '../api.ts'
import { formatAge, formatBytes, formatDurationMs, shortHash } from '../format.ts'
import { AsyncView } from '../components/AsyncView.tsx'
import { Card } from '../components/Card.tsx'
import { Empty } from '../components/Empty.tsx'

export const Cache: Component = () => {
  const [data] = createResource(() => fetchJson<CacheEntryRow[]>('/api/cache/entries?limit=500'))

  return (
    <section>
      <h1 class="text-fg text-2xl font-semibold tracking-tight mb-6">Cache</h1>
      <AsyncView resource={data}>
        {(entries) => (
          <Show
            when={entries.length > 0}
            fallback={
              <Empty>
                no cache entries yet — run a task with <code class="font-mono text-fg">cache:</code>{' '}
                declared
              </Empty>
            }
          >
            <div class="flex flex-wrap gap-3 mb-8">
              <Card label="Entries (showing)" value={entries.length.toLocaleString()} />
              <Card
                label="Size (showing)"
                value={formatBytes(entries.reduce((s, e) => s + (e.sizeBytes ?? 0), 0))}
              />
            </div>
            <div class="bg-bg-elevated border border-border rounded-lg overflow-hidden">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-fg-subtle uppercase text-xs tracking-wider">
                    <th class="text-left px-4 py-2.5 font-medium">Hash</th>
                    <th class="text-left px-4 py-2.5 font-medium">Project</th>
                    <th class="text-left px-4 py-2.5 font-medium">Task</th>
                    <th class="text-right px-4 py-2.5 font-medium">Size</th>
                    <th class="text-right px-4 py-2.5 font-medium">Duration</th>
                    <th class="text-left px-4 py-2.5 font-medium">Last access</th>
                    <th class="text-left px-4 py-2.5 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={entries}>
                    {(e) => (
                      <tr class="border-t border-border-muted hover:bg-bg-muted">
                        <td class="px-4 py-2 font-mono text-accent">{shortHash(e.hash)}</td>
                        <td class="px-4 py-2 font-mono text-fg">{e.project}</td>
                        <td class="px-4 py-2 font-mono text-fg">{e.task}</td>
                        <td class="px-4 py-2 text-right tabular-nums">
                          {formatBytes(e.sizeBytes)}
                        </td>
                        <td class="px-4 py-2 text-right tabular-nums">
                          {formatDurationMs(e.durationMs)}
                        </td>
                        <td class="px-4 py-2 text-fg-muted">{formatAge(e.accessedAt)}</td>
                        <td class="px-4 py-2 text-fg-muted">{formatAge(e.createdAt)}</td>
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
