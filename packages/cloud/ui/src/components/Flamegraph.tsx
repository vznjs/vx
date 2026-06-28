import { For, Show, createSignal } from 'solid-js'
import type { RunSummaryRow } from '../api.ts'
import { formatDuration } from '../format.ts'
import { layout, type LayoutInput } from '../flamegraph-layout.ts'

const LANE_HEIGHT = 22
const LANE_PAD = 4
const AXIS_TICKS = 5

function colorFor(status: string, cacheHit: boolean): string {
  if (status === 'failed') return 'bg-danger/80'
  if (status === 'running') return 'bg-accent/70'
  if (status === 'skipped') return 'bg-warn/70'
  if (cacheHit) return 'bg-cache-local/70'
  return 'bg-success/70'
}

function iconFor(status: string, cacheHit: boolean): string {
  if (status === 'failed') return 'i-tabler-circle-x'
  if (status === 'running') return 'i-tabler-loader-2'
  if (status === 'skipped') return 'i-tabler-circle-minus'
  if (cacheHit) return 'i-tabler-bolt'
  return 'i-tabler-circle-check'
}

const idOf = (t: RunSummaryRow): string => `${t.project}#${t.task}`

export function Flamegraph(props: {
  tasks: readonly RunSummaryRow[]
  selectedId?: string
  // Bars whose `${project}#${task}` id is in this set get a critical-path ring.
  highlightIds?: ReadonlySet<string>
  onSelect?: (task: RunSummaryRow) => void
}) {
  // Use startedAt/endedAt (epoch ms, present for EVERY task) as the uniform
  // time base — wallclock ns spans are null for cache hits, so keying off them
  // dropped every restored task from the chart. ms units are fine: the layout
  // normalizes against the run window, so only relative proportions matter.
  const inputs = (): LayoutInput[] =>
    props.tasks.map((t) => ({
      taskId: idOf(t),
      project: t.project,
      startNs: t.startedAt,
      endNs: t.endedAt,
      status: t.status,
      cacheHit: t.cacheHit === true,
    }))

  const l = () => layout(inputs())
  // Run window in ms, for the time axis + cursor readout.
  const window = () => {
    const ts = props.tasks
    if (ts.length === 0) return { min: 0, total: 1 }
    const min = Math.min(...ts.map((t) => t.startedAt))
    const max = Math.max(...ts.map((t) => t.endedAt))
    return { min, total: Math.max(1, max - min) }
  }

  const [cursor, setCursor] = createSignal<number | null>(null) // fraction 0..1
  let chartRef: HTMLDivElement | undefined
  const onMove = (e: MouseEvent) => {
    if (!chartRef) return
    const rect = chartRef.getBoundingClientRect()
    setCursor(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
  }
  const chartHeight = () => Math.max(1, l().lanes.length) * (LANE_HEIGHT + LANE_PAD) + LANE_PAD

  return (
    <div class="flex flex-col gap-1">
      <div
        ref={chartRef}
        class="relative rounded bg-surface-2"
        style={{ height: `${chartHeight()}px` }}
        onMouseMove={onMove}
        onMouseLeave={() => setCursor(null)}
      >
        <For each={l().bars}>
          {(bar, i) => {
            const task = () => props.tasks[i()]
            const selected = () => props.selectedId === bar.taskId
            const onPath = () => props.highlightIds?.has(bar.taskId) === true
            return (
              <div
                class={`absolute rounded text-[10px] text-bg font-medium overflow-hidden whitespace-nowrap cursor-pointer transition-[outline] flex items-center gap-0.5 pl-1 ${colorFor(bar.status, bar.cacheHit)}`}
                classList={{
                  'outline outline-2 outline-fg-1 z-20': selected(),
                  'outline outline-2 outline-warn z-10': !selected() && onPath(),
                  'hover:brightness-110': !selected(),
                }}
                style={{
                  left: `${bar.leftPct}%`,
                  width: `${bar.widthPct}%`,
                  top: `${bar.lane * (LANE_HEIGHT + LANE_PAD) + LANE_PAD}px`,
                  height: `${LANE_HEIGHT}px`,
                }}
                title={bar.taskId}
                onClick={() => {
                  const t = task()
                  if (t) props.onSelect?.(t)
                }}
              >
                <span class={`${iconFor(bar.status, bar.cacheHit)} shrink-0 text-[9px]`} classList={{ 'animate-spin': bar.status === 'running' }} />
                <span class="truncate">{bar.taskId}</span>
              </div>
            )
          }}
        </For>
        {/* Point-of-time cursor: a vertical line at the hovered x + a time readout. */}
        <Show when={cursor() !== null}>
          <div class="absolute top-0 bottom-0 w-px bg-fg-1/60 z-10 pointer-events-none" style={{ left: `${cursor()! * 100}%` }} />
          <div
            class="absolute -top-5 px-1 rounded bg-fg-1 text-bg text-[9px] font-mono z-30 pointer-events-none whitespace-nowrap"
            style={{ left: `${cursor()! * 100}%`, transform: cursor()! > 0.85 ? 'translateX(-100%)' : 'translateX(-50%)' }}
          >
            {formatDuration(cursor()! * window().total)}
          </div>
        </Show>
      </div>
      {/* Time axis: ticks at even fractions of the run window. */}
      <div class="relative h-4 text-[9px] text-fg-3 font-mono">
        <For each={Array.from({ length: AXIS_TICKS }, (_, i) => i / (AXIS_TICKS - 1))}>
          {(frac) => (
            <span
              class="absolute top-0"
              style={{ left: `${frac * 100}%`, transform: frac === 0 ? 'none' : frac === 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}
            >
              {formatDuration(frac * window().total)}
            </span>
          )}
        </For>
      </div>
    </div>
  )
}
