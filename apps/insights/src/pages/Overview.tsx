import { For, Show, createResource } from 'solid-js'
import { useNavigate, A } from '@solidjs/router'
import {
  getCacheBreakdown,
  getCacheSavings,
  getCacheStats,
  getFailures,
  getOriginSignal,
  getTopTasks,
  listInvocations,
} from '../api.ts'
import { formatBytes, formatDuration, formatPercent, formatRelativeTime } from '../format.ts'

export function Overview() {
  const origin = getOriginSignal()
  const [runs] = createResource(origin, () => listInvocations(25))
  const [stats] = createResource(origin, () => getCacheStats())
  const [savings] = createResource(origin, () => getCacheSavings())
  const [topTasks] = createResource(origin, () => getTopTasks(10))
  const [failures] = createResource(origin, () => getFailures(10))
  const [breakdown] = createResource(origin, () => getCacheBreakdown(5))
  const navigate = useNavigate()

  return (
    <div class="flex flex-col gap-6">
      {/* Hero stats: the four numbers a dev cares about */}
      <Show when={stats() !== undefined && savings() !== undefined}>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat
            label="Time saved (24h)"
            value={formatDuration(savings()!.estimatedTimeSavedMs)}
            sub={`${savings()!.hitsLast24h} cache hits`}
            highlight={savings()!.estimatedTimeSavedMs > 0}
          />
          <Stat
            label="Hit rate (24h)"
            value={formatPercent(stats()!.hitRate24h)}
            sub={`${stats()!.hitCountLast24h} / ${stats()!.runCountLast24h} runs`}
          />
          <Stat
            label="Cache entries"
            value={String(stats()!.entryCount)}
            sub={formatBytes(stats()!.totalBytes)}
          />
          <Stat
            label="Time saved (total)"
            value={formatDuration(savings()!.estimatedTimeSavedTotalMs)}
            sub="all-time, estimated"
          />
        </div>
      </Show>

      {/* Two-column layout: top time burners + recent failures */}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="Top time-burners" linkHref="/tasks" linkLabel="all tasks →">
          <Show
            when={topTasks() !== undefined && topTasks()!.length > 0}
            fallback={<EmptyHint />}
          >
            <table class="w-full text-sm">
              <tbody>
                <For each={topTasks()}>
                  {(t) => (
                    <tr
                      class="border-t border-border-muted hover:bg-bg-elevated cursor-pointer"
                      onClick={() => navigate(`/tasks/${encodeURIComponent(t.id)}`)}
                    >
                      <td class="px-3 py-2 font-mono text-xs">{t.id}</td>
                      <td class="px-3 py-2 text-right text-fg-muted text-xs">{t.runs} runs</td>
                      <td class="px-3 py-2 text-right">
                        {formatDuration(t.totalDurationMs)}
                      </td>
                      <td class="px-3 py-2 text-right text-fg-muted text-xs">
                        ~{formatDuration(t.avgDurationMs)} avg
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Card>

        <Card title="Recent failures" linkHref="/tasks" linkLabel="">
          <Show
            when={failures() !== undefined && failures()!.length > 0}
            fallback={<div class="px-3 py-6 text-fg-muted text-sm">No failures recorded.</div>}
          >
            <table class="w-full text-sm">
              <tbody>
                <For each={failures()}>
                  {(f) => (
                    <tr
                      class="border-t border-border-muted hover:bg-bg-elevated cursor-pointer"
                      onClick={() =>
                        navigate(`/tasks/${encodeURIComponent(`${f.project}#${f.task}`)}`)
                      }
                    >
                      <td class="px-3 py-2 font-mono text-xs">
                        {f.project}#{f.task}
                      </td>
                      <td class="px-3 py-2 text-failure text-xs">exit {f.exitCode}</td>
                      <td class="px-3 py-2 text-right text-fg-muted text-xs">
                        {formatRelativeTime(f.startedAt)}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Card>
      </div>

      {/* Cache breakdown by project */}
      <Card title="Cache by project" linkHref="/cache" linkLabel="all entries →">
        <Show
          when={breakdown() !== undefined && breakdown()!.length > 0}
          fallback={<EmptyHint />}
        >
          <table class="w-full text-sm">
            <tbody>
              <For each={breakdown()}>
                {(p) => {
                  const widthPct = () => {
                    const max = Math.max(...(breakdown() ?? []).map((x) => x.totalBytes))
                    return max > 0 ? (p.totalBytes / max) * 100 : 0
                  }
                  return (
                    <tr class="border-t border-border-muted">
                      <td class="px-3 py-2 font-mono text-xs w-1/4">{p.project}</td>
                      <td class="px-3 py-2">
                        <div class="h-2 bg-bg rounded overflow-hidden">
                          <div
                            class="h-full bg-accent/60"
                            style={{ width: `${widthPct().toFixed(1)}%` }}
                          />
                        </div>
                      </td>
                      <td class="px-3 py-2 text-right text-xs text-fg-muted">{p.entries} entries</td>
                      <td class="px-3 py-2 text-right">{formatBytes(p.totalBytes)}</td>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
        </Show>
      </Card>

      {/* Recent invocations */}
      <Card title="Recent invocations" linkHref="" linkLabel="">
        <Show when={runs.loading}>
          <div class="px-3 py-6 text-fg-muted text-sm">Loading…</div>
        </Show>
        <Show when={runs() !== undefined && runs()!.length > 0} fallback={<EmptyHint />}>
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
        </Show>
      </Card>
    </div>
  )
}

function Stat(props: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div
      class="border border-border-muted rounded px-3 py-2 bg-bg-elevated"
      classList={{ 'border-success/40 bg-success/5': props.highlight === true }}
    >
      <div class="text-fg-muted text-[10px] uppercase tracking-wider">{props.label}</div>
      <div class="text-lg font-mono">{props.value}</div>
      <Show when={props.sub}>
        <div class="text-[10px] text-fg-muted">{props.sub}</div>
      </Show>
    </div>
  )
}

function Card(props: {
  title: string
  linkHref: string
  linkLabel: string
  children: ReturnType<typeof Element>
}) {
  return (
    <div class="border border-border-muted rounded overflow-hidden">
      <div class="flex items-center justify-between px-3 py-2 bg-bg-elevated border-b border-border-muted">
        <h2 class="text-xs font-semibold m-0 uppercase tracking-wider text-fg-muted">
          {props.title}
        </h2>
        <Show when={props.linkHref && props.linkLabel}>
          <A href={props.linkHref} class="text-xs text-accent no-underline">
            {props.linkLabel}
          </A>
        </Show>
      </div>
      {props.children}
    </div>
  )
}

function EmptyHint() {
  return (
    <div class="px-3 py-6 text-fg-muted text-sm">
      No data yet. Run a task with <code>vx run</code> to populate this view.
    </div>
  )
}
