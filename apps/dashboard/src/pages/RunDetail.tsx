import type { Component } from 'solid-js'
import { createMemo, createResource, For, Show } from 'solid-js'
import { A, useParams } from '@solidjs/router'
import { fetchJson, type RunDetailResponse } from '../api.ts'
import { formatAge, formatDurationMs, shortRunId } from '../format.ts'
import { AsyncView } from '../components/AsyncView.tsx'
import { Card } from '../components/Card.tsx'
import { Empty } from '../components/Empty.tsx'
import { Flamegraph } from '../components/Flamegraph.tsx'

export const RunDetail: Component = () => {
  const params = useParams<{ id: string }>()
  const [data] = createResource(
    () => params.id,
    (id) => fetchJson<RunDetailResponse>(`/api/runs/${encodeURIComponent(id)}`),
  )

  return (
    <section>
      <div class="flex items-baseline gap-3 mb-2">
        <A href="/runs" class="text-fg-muted hover:text-fg text-sm">
          ← Runs
        </A>
        <h1 class="text-fg text-2xl font-semibold tracking-tight font-mono">
          {shortRunId(params.id)}
        </h1>
      </div>
      <AsyncView resource={data}>{(d) => <RunBody detail={d} />}</AsyncView>
    </section>
  )
}

const RunBody: Component<{ detail: RunDetailResponse }> = (props) => {
  const summary = createMemo(() => {
    const tasks = props.detail.tasks
    if (tasks.length === 0) return null
    const startedAt = Math.min(...tasks.map((t) => t.startedAt))
    const endedAt = Math.max(...tasks.map((t) => t.endedAt))
    const success = tasks.filter((t) => t.status === 'success').length
    const failed = tasks.filter((t) => t.status === 'failed').length
    const cached = tasks.filter((t) => t.cacheHit === true || t.status === 'cache-hit').length
    return {
      startedAt,
      durationMs: endedAt - startedAt,
      count: tasks.length,
      success,
      failed,
      cached,
    }
  })

  return (
    <Show when={summary()} fallback={<Empty>no tasks recorded for this run</Empty>}>
      {(s) => (
        <>
          <div class="flex flex-wrap gap-3 mb-6">
            <Card label="Tasks" value={String(s().count)} />
            <Card label="Duration" value={formatDurationMs(s().durationMs)} />
            <Card
              label="Started"
              value={formatAge(s().startedAt)}
              sub={new Date(s().startedAt).toLocaleString()}
            />
            <Card label="OK" value={String(s().success)} />
            <Card label="Cached" value={String(s().cached)} />
            <Show when={s().failed > 0}>
              <Card label="Failed" value={String(s().failed)} />
            </Show>
          </div>
          <h2 class="text-fg text-lg font-semibold mb-3">Wallclock timeline</h2>
          <Flamegraph tasks={props.detail.tasks} />
          <h2 class="text-fg text-lg font-semibold mt-8 mb-3">Tasks</h2>
          <div class="bg-bg-elevated border border-border rounded-lg overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-fg-subtle uppercase text-xs tracking-wider">
                  <th class="text-left px-4 py-2.5 font-medium">Project</th>
                  <th class="text-left px-4 py-2.5 font-medium">Task</th>
                  <th class="text-left px-4 py-2.5 font-medium">Status</th>
                  <th class="text-right px-4 py-2.5 font-medium">Duration</th>
                  <th class="text-right px-4 py-2.5 font-medium">CPU</th>
                  <th class="text-right px-4 py-2.5 font-medium">Peak RSS</th>
                  <th class="text-right px-4 py-2.5 font-medium">Exit</th>
                </tr>
              </thead>
              <tbody>
                <For each={props.detail.tasks}>
                  {(t) => (
                    <tr class="border-t border-border-muted hover:bg-bg-muted">
                      <td class="px-4 py-2 font-mono text-fg">{t.project}</td>
                      <td class="px-4 py-2 font-mono text-fg">{t.task}</td>
                      <td class="px-4 py-2 text-fg-muted">
                        <StatusBadge status={t.status} cacheHit={t.cacheHit} />
                      </td>
                      <td class="px-4 py-2 text-right tabular-nums">
                        {formatDurationMs(t.durationMs)}
                      </td>
                      <td class="px-4 py-2 text-right tabular-nums text-fg-muted">
                        {t.cpuMs == null ? '—' : formatDurationMs(t.cpuMs)}
                      </td>
                      <td class="px-4 py-2 text-right tabular-nums text-fg-muted">
                        {t.peakRssBytes == null ? '—' : formatRss(t.peakRssBytes)}
                      </td>
                      <td class="px-4 py-2 text-right tabular-nums">
                        <Show when={t.exitCode !== 0} fallback="0">
                          <span class="text-err font-semibold">{t.exitCode}</span>
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </>
      )}
    </Show>
  )
}

const StatusBadge: Component<{ status: string; cacheHit: boolean | null }> = (props) => {
  const cached = () => props.cacheHit === true || props.status === 'cache-hit'
  return (
    <Show when={cached()} fallback={<RawStatus status={props.status} />}>
      <span class="text-accent">cache-hit</span>
    </Show>
  )
}

const RawStatus: Component<{ status: string }> = (props) => (
  <span
    classList={{
      'text-ok': props.status === 'success',
      'text-err': props.status === 'failed',
      'text-fg-muted': props.status !== 'success' && props.status !== 'failed',
    }}
  >
    {props.status}
  </span>
)

function formatRss(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`
  return `${mb.toFixed(1)} MB`
}
