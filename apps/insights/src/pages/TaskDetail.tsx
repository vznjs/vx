import { For, Show, createMemo, createResource } from 'solid-js'
import { A, useParams } from '@solidjs/router'
import { getOriginSignal, getTaskDetail } from '../api.ts'
import { Sparkline } from '../components/Sparkline.tsx'
import { formatBytes, formatDuration, formatPercent, formatRelativeTime } from '../format.ts'

export function TaskDetail() {
  const params = useParams<{ id: string }>()
  const origin = getOriginSignal()
  const [detail] = createResource(
    () => ({ id: params.id, o: origin() }),
    (args) => getTaskDetail(args.id),
  )

  const sparkPoints = createMemo(() => {
    const recent = detail()?.recent ?? []
    // Reverse so the sparkline reads left-to-right oldest→newest.
    return [...recent]
      .reverse()
      .map((r) => ({ value: r.durationMs, hit: r.cacheHit === true }))
  })

  return (
    <div class="flex flex-col gap-6">
      <div class="flex items-baseline gap-3">
        <A href="/tasks" class="text-fg-muted hover:text-fg no-underline text-xs">
          ← all tasks
        </A>
        <h1 class="text-xl font-semibold m-0 font-mono">{params.id}</h1>
      </div>
      <Show when={detail.loading}>
        <div class="text-fg-muted text-sm">Loading…</div>
      </Show>
      <Show when={detail.error}>
        <div class="text-failure font-mono text-sm">Failed to load: {String(detail.error)}</div>
      </Show>
      <Show when={detail() === null}>
        <div class="text-fg-muted text-sm">No data for this task.</div>
      </Show>
      <Show when={detail() !== undefined && detail() !== null}>
        {(() => {
          const d = detail() as NonNullable<ReturnType<typeof detail>>
          const agg = d.aggregate
          return (
            <>
              {/* Per-task stats grid */}
              <Show when={agg}>
                <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <Stat label="Total runs" value={String(agg!.runs)} />
                  <Stat
                    label="Success rate"
                    value={formatPercent(agg!.successRate)}
                    sub={`${agg!.successes} / ${agg!.runs}`}
                  />
                  <Stat
                    label="Hit rate"
                    value={formatPercent(agg!.hitRate)}
                    sub={`${agg!.hits} hits`}
                  />
                  <Stat
                    label="Failure mode"
                    value={agg!.failureMode}
                    sub={`${agg!.failures} failed`}
                  />
                  <Stat
                    label="Last run"
                    value={
                      agg!.lastSeenAt !== undefined ? formatRelativeTime(agg!.lastSeenAt) : '—'
                    }
                  />
                </div>
                <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <Stat label="Min" value={formatDuration(agg!.minDurationMs ?? 0)} />
                  <Stat label="Avg" value={formatDuration(agg!.avgDurationMs ?? 0)} />
                  <Stat label="p50" value={formatDuration(agg!.p50DurationMs ?? 0)} />
                  <Stat label="p99" value={formatDuration(agg!.p99DurationMs ?? 0)} />
                  <Stat label="Max" value={formatDuration(agg!.maxDurationMs ?? 0)} />
                </div>
              </Show>

              {/* Duration sparkline */}
              <Show when={sparkPoints().length > 0}>
                <div class="border border-border-muted rounded p-3">
                  <div class="text-fg-muted text-xs uppercase tracking-wider mb-2">
                    Duration (last {sparkPoints().length} runs · cache hits in cyan)
                  </div>
                  <Sparkline data={sparkPoints()} width={800} height={80} />
                </div>
              </Show>

              {/* Latest cache entry */}
              <Show when={d.latestEntry}>
                {(() => {
                  const e = d.latestEntry!
                  return (
                    <div class="border border-border-muted rounded p-3">
                      <div class="text-fg-muted text-xs uppercase tracking-wider mb-2">
                        Latest cache entry
                      </div>
                      <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                        <KV label="hash" value={<code class="font-mono">{e.hash.slice(0, 16)}…</code>} />
                        <KV label="size" value={formatBytes(e.sizeBytes)} />
                        <KV label="exec" value={<code class="font-mono text-xs">{e.command}</code>} />
                        <KV label="duration" value={formatDuration(e.durationMs)} />
                        <KV label="created" value={formatRelativeTime(e.createdAt)} />
                        <KV label="accessed" value={formatRelativeTime(e.accessedAt)} />
                      </div>
                    </div>
                  )
                })()}
              </Show>

              {/* Full history table */}
              <div class="border border-border-muted rounded overflow-hidden">
                <div class="flex items-center px-3 py-2 bg-bg-elevated border-b border-border-muted">
                  <h2 class="text-xs font-semibold m-0 uppercase tracking-wider text-fg-muted">
                    Recent runs ({d.recent.length})
                  </h2>
                </div>
                <table class="w-full text-sm">
                  <thead class="bg-bg-elevated text-fg-muted text-xs uppercase tracking-wider">
                    <tr>
                      <th class="text-left px-3 py-2 font-medium">When</th>
                      <th class="text-left px-3 py-2 font-medium">Status</th>
                      <th class="text-right px-3 py-2 font-medium">Duration</th>
                      <th class="text-right px-3 py-2 font-medium">CPU</th>
                      <th class="text-right px-3 py-2 font-medium">Peak RSS</th>
                      <th class="text-right px-3 py-2 font-medium">Hash</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={d.recent}>
                      {(r) => (
                        <tr class="border-t border-border-muted">
                          <td class="px-3 py-2 text-fg-muted text-xs">
                            {formatRelativeTime(r.startedAt)}
                          </td>
                          <td class="px-3 py-2 text-xs">
                            <StatusBadge
                              status={r.status}
                              exitCode={r.exitCode}
                              cacheHit={r.cacheHit}
                            />
                          </td>
                          <td class="px-3 py-2 text-right">{formatDuration(r.durationMs)}</td>
                          <td class="px-3 py-2 text-right text-fg-muted">
                            {r.cpuMs !== null ? formatDuration(r.cpuMs) : '—'}
                          </td>
                          <td class="px-3 py-2 text-right text-fg-muted">
                            {r.peakRssBytes !== null && r.peakRssBytes > 0
                              ? formatBytes(r.peakRssBytes)
                              : '—'}
                          </td>
                          <td class="px-3 py-2 text-right font-mono text-xs text-fg-muted">
                            {r.hash.slice(0, 10)}…
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </>
          )
        })()}
      </Show>
    </div>
  )
}

function Stat(props: { label: string; value: string; sub?: string }) {
  return (
    <div class="border border-border-muted rounded px-3 py-2 bg-bg-elevated">
      <div class="text-fg-muted text-[10px] uppercase tracking-wider">{props.label}</div>
      <div class="text-base font-mono">{props.value}</div>
      <Show when={props.sub}>
        <div class="text-[10px] text-fg-muted">{props.sub}</div>
      </Show>
    </div>
  )
}

function KV(props: { label: string; value: ReturnType<typeof Element> | string }) {
  return (
    <div class="flex gap-3 items-baseline">
      <span class="text-fg-muted text-[10px] uppercase tracking-wider w-20">{props.label}</span>
      <span>{props.value}</span>
    </div>
  )
}

function StatusBadge(props: { status: string; exitCode: number; cacheHit: boolean | null }) {
  const tone = () =>
    props.status === 'failed'
      ? 'text-failure'
      : props.cacheHit
        ? 'text-cache'
        : props.status === 'success'
          ? 'text-success'
          : 'text-fg-muted'
  return (
    <span class={`font-mono ${tone()}`}>
      {props.status}
      {props.status === 'failed' && <> (exit {props.exitCode})</>}
    </span>
  )
}
