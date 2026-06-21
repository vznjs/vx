import { For, Show, createResource } from 'solid-js'
import { A, useParams } from '@solidjs/router'
import { getRun } from '../api.ts'
import { Flamegraph } from '../components/Flamegraph.tsx'
import { formatDuration } from '../format.ts'

export function RunDetail() {
  const params = useParams<{ id: string }>()
  const [run] = createResource(() => params.id, getRun)

  return (
    <div class="flex flex-col gap-6">
      <div class="flex items-baseline gap-3">
        <A href="/" class="text-fg-muted hover:text-fg no-underline text-xs">
          ← back
        </A>
        <h1 class="text-xl font-semibold m-0 font-mono">Run {params.id.slice(0, 12)}</h1>
      </div>
      <Show when={run.loading}>
        <div class="text-fg-muted text-sm">Loading…</div>
      </Show>
      <Show when={run.error}>
        <div class="text-failure font-mono text-sm">Failed to load: {String(run.error)}</div>
      </Show>
      <Show when={run() !== null && run() !== undefined}>
        <div class="text-sm text-fg-muted">
          {run()!.tasks.length} task(s)
          {' · '}
          {formatDuration(
            run()!.tasks.reduce((acc, t) => acc + Number(t.durationMs ?? 0), 0),
          )}{' '}
          total
        </div>
        <Flamegraph tasks={run()!.tasks} />
        <div class="border border-border-muted rounded overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-bg-elevated text-fg-muted text-xs uppercase tracking-wider">
              <tr>
                <th class="text-left px-3 py-2 font-medium">Task</th>
                <th class="text-left px-3 py-2 font-medium">Status</th>
                <th class="text-right px-3 py-2 font-medium">Duration</th>
                <th class="text-right px-3 py-2 font-medium">Cache</th>
              </tr>
            </thead>
            <tbody>
              <For each={run()!.tasks}>
                {(t) => (
                  <tr class="border-t border-border-muted">
                    <td class="px-3 py-2 font-mono text-xs">
                      {t.project}#{t.task}
                    </td>
                    <td class="px-3 py-2 text-xs">{t.status}</td>
                    <td class="px-3 py-2 text-right">{formatDuration(t.durationMs)}</td>
                    <td class="px-3 py-2 text-right text-cache">
                      {t.cacheHit === true ? 'hit' : 'miss'}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
      <Show when={run() === null}>
        <div class="text-fg-muted text-sm">Run not found.</div>
      </Show>
    </div>
  )
}
