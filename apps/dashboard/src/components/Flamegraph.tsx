import type { Component } from 'solid-js'
import { createMemo, createSignal, For, Show } from 'solid-js'
import type { TaskRow } from '../api.ts'
import { colorForTask, computeLayout, type BarColor } from '../flamegraph.ts'
import { formatDurationMs } from '../format.ts'

const LANE_H = 28
const COLOR_CLASS: Record<BarColor, string> = {
  ok: 'bg-ok/30 border-ok hover:bg-ok/50',
  cache: 'bg-accent/20 border-accent hover:bg-accent/40',
  err: 'bg-err/30 border-err hover:bg-err/50',
  neutral: 'bg-bg-muted border-border hover:bg-fg-subtle/20',
}

export const Flamegraph: Component<{ tasks: TaskRow[] }> = (props) => {
  const layout = createMemo(() => computeLayout(props.tasks))
  const [hovered, setHovered] = createSignal<TaskRow | null>(null)

  return (
    <Show
      when={layout().bars.length > 0}
      fallback={<div class="text-fg-muted py-8">no task spans recorded for this run</div>}
    >
      <div class="bg-bg-elevated border border-border rounded-lg overflow-hidden">
        <div class="flex border-b border-border-muted px-4 py-2 text-xs text-fg-subtle tabular-nums">
          <div>0ms</div>
          <div class="ml-auto">{formatDurationMs(layout().totalDurationMs)}</div>
        </div>
        <div
          class="relative px-4 py-3"
          style={{ height: `${layout().lanes.length * LANE_H + 8}px` }}
        >
          <For each={layout().lanes}>
            {(project, i) => (
              <div
                class="absolute left-4 right-4 text-xs text-fg-subtle font-mono pointer-events-none"
                style={{ top: `${i() * LANE_H + 4}px`, height: `${LANE_H - 8}px` }}
              >
                <div class="absolute left-0 top-1/2 -translate-y-1/2">{project}</div>
              </div>
            )}
          </For>
          <For each={layout().bars}>
            {(bar) => {
              const total = layout().totalDurationMs
              const leftPct = total === 0 ? 0 : (bar.startMs / total) * 100
              const widthPct =
                total === 0 ? 100 : Math.max(((bar.endMs - bar.startMs) / total) * 100, 0.5)
              const cls = COLOR_CLASS[colorForTask(bar.task)]
              return (
                <button
                  type="button"
                  class={`absolute rounded border ${cls} text-xs font-mono text-fg px-1.5 truncate text-left transition-colors`}
                  style={{
                    top: `${bar.laneIndex * LANE_H + 4}px`,
                    left: `calc(8rem + (100% - 8rem - 1rem) * ${leftPct / 100})`,
                    width: `calc((100% - 8rem - 1rem) * ${widthPct / 100})`,
                    height: `${LANE_H - 8}px`,
                  }}
                  onMouseEnter={() => setHovered(bar.task)}
                  onMouseLeave={() => setHovered(null)}
                  title={`${bar.task.project}:${bar.task.task} — ${formatDurationMs(bar.task.durationMs)}`}
                >
                  {bar.task.task}
                </button>
              )
            }}
          </For>
        </div>
        <Show when={hovered()}>
          {(t) => (
            <div class="border-t border-border-muted px-4 py-2 text-xs font-mono text-fg-muted flex gap-4">
              <span class="text-fg">
                {t().project}:{t().task}
              </span>
              <span>{formatDurationMs(t().durationMs)}</span>
              <span>{t().status}</span>
              <Show when={t().cacheHit}>
                <span class="text-accent">cache-hit</span>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </Show>
  )
}
