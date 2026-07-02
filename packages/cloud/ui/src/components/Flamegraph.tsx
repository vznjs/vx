import { For, Show, createMemo, createSignal } from 'solid-js'
import type { RunSummaryRow } from '../api.ts'
import { formatDuration } from '../format.ts'
import { layout, type LayoutInput } from '../flamegraph-layout.ts'
import { STATUS, toVizState } from './status.tsx'

const LANE_HEIGHT = 22
const LANE_PAD = 4
const AXIS_TICKS = 5

const idOf = (t: RunSummaryRow): string => `${t.project}#${t.task}`
const laneMid = (lane: number): number => lane * (LANE_HEIGHT + LANE_PAD) + LANE_PAD + LANE_HEIGHT / 2

/** A dependency edge: `from` (the task that unlocked) → `to` (what it unlocked). */
export interface FlameEdge {
  from: string
  to: string
}

/** Flatten graph nodes (id + deps) into dep → dependent flame edges. */
export function flameEdgesOf(nodes: readonly { id: string; deps: readonly string[] }[]): FlameEdge[] {
  const out: FlameEdge[] = []
  for (const n of nodes) for (const d of n.deps) out.push({ from: d, to: n.id })
  return out
}

export function Flamegraph(props: {
  tasks: readonly RunSummaryRow[]
  selectedId?: string
  // Bars whose `${project}#${task}` id is in this set get a critical-path ring.
  highlightIds?: ReadonlySet<string>
  // Dependency edges (dep → dependent). Drawn faint; the selected task's edges
  // and the critical path are emphasized so you can see what unlocked what.
  edges?: readonly FlameEdge[]
  onSelect?: (task: RunSummaryRow) => void
}) {
  // Use startedAt/endedAt (epoch ms, present for EVERY task) as the uniform
  // time base — wallclock ns spans are null for cache hits, so keying off them
  // dropped every restored task. The bar width is the task's real wall time
  // (for a cache hit that's the restore time, not the original run time).
  const inputs = (): LayoutInput[] =>
    props.tasks.map((t) => ({
      taskId: idOf(t),
      project: t.project,
      startNs: t.startedAt,
      endNs: t.endedAt,
      status: t.status,
      cacheHit: t.cacheHit === true,
    }))

  const l = createMemo(() => layout(inputs()))
  const barById = createMemo(() => new Map(l().bars.map((b) => [b.taskId, b])))
  const window = () => {
    const ts = props.tasks
    if (ts.length === 0) return { min: 0, total: 1 }
    const min = Math.min(...ts.map((t) => t.startedAt))
    const max = Math.max(...ts.map((t) => t.endedAt))
    return { min, total: Math.max(1, max - min) }
  }
  const chartHeight = () => Math.max(1, l().lanes.length) * (LANE_HEIGHT + LANE_PAD) + LANE_PAD

  // Edge geometry, in the chart's coordinate space (x = 0..100 %, y = px).
  // `kind` drives emphasis: selected (touches the selected task) > critical
  // (both ends on the critical path) > plain (faint).
  const edgeGeoms = createMemo(() => {
    const map = barById()
    const sel = props.selectedId
    const crit = props.highlightIds
    const out: Array<{ d: string; kind: 'sel' | 'crit' | 'plain' }> = []
    for (const e of props.edges ?? []) {
      const a = map.get(e.from)
      const b = map.get(e.to)
      if (!a || !b) continue
      const x1 = a.leftPct + a.widthPct
      const y1 = laneMid(a.lane)
      const x2 = b.leftPct
      const y2 = laneMid(b.lane)
      const dx = Math.max(2, (x2 - x1) / 2)
      const kind =
        sel !== undefined && (e.from === sel || e.to === sel)
          ? 'sel'
          : crit?.has(e.from) === true && crit?.has(e.to) === true
            ? 'crit'
            : 'plain'
      out.push({ d: `M ${x1},${y1} C ${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, kind })
    }
    // Emphasized edges last so they paint on top.
    return out.sort((p, q) => rank(p.kind) - rank(q.kind))
  })

  const [cursor, setCursor] = createSignal<number | null>(null) // fraction 0..1
  let chartRef: HTMLDivElement | undefined
  const onMove = (e: MouseEvent) => {
    if (!chartRef) return
    const rect = chartRef.getBoundingClientRect()
    setCursor(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
  }

  return (
    <div class="relative h-full overflow-auto rounded bg-surface-2" onMouseMove={onMove} onMouseLeave={() => setCursor(null)}>
      {/* Sticky time axis — stays pinned at the top while the lanes scroll. */}
      <div class="sticky top-0 z-30 h-5 bg-surface-2/95 backdrop-blur-sm border-b border-border/60">
        <For each={Array.from({ length: AXIS_TICKS }, (_, i) => i / (AXIS_TICKS - 1))}>
          {(frac) => (
            <span
              class="absolute top-0.5 text-[9px] text-fg-3 font-mono"
              style={{ left: `${frac * 100}%`, transform: frac === 0 ? 'none' : frac === 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}
            >
              {formatDuration(frac * window().total)}
            </span>
          )}
        </For>
        <Show when={cursor() !== null}>
          <span
            class="absolute top-0.5 px-1 rounded bg-fg-1 text-bg text-[9px] font-mono z-10 pointer-events-none whitespace-nowrap"
            style={{ left: `${cursor()! * 100}%`, transform: cursor()! > 0.85 ? 'translateX(-100%)' : 'translateX(-50%)' }}
          >
            {formatDuration(cursor()! * window().total)}
          </span>
        </Show>
      </div>

      {/* Chart: edges + bars + cursor line. */}
      <div ref={chartRef} class="relative" style={{ height: `${chartHeight()}px` }}>
        {/* dependency connectors (dep → dependent) */}
        <svg class="absolute inset-0 pointer-events-none" width="100%" height={chartHeight()} viewBox={`0 0 100 ${chartHeight()}`} preserveAspectRatio="none">
          <For each={edgeGeoms()}>
            {(e) => (
              <path
                d={e.d}
                fill="none"
                vector-effect="non-scaling-stroke"
                class={e.kind === 'sel' ? 'stroke-accent' : e.kind === 'crit' ? 'stroke-warn' : 'stroke-fg-3'}
                stroke-width={e.kind === 'plain' ? 1 : 1.75}
                stroke-opacity={e.kind === 'sel' ? 0.9 : e.kind === 'crit' ? 0.7 : 0.16}
              />
            )}
          </For>
        </svg>

        <For each={l().bars}>
          {(bar, i) => {
            const task = () => props.tasks[i()]
            const viz = () => STATUS[toVizState(bar.status, bar.cacheHit)]
            const selected = () => props.selectedId === bar.taskId
            const onPath = () => props.highlightIds?.has(bar.taskId) === true
            return (
              <div
                class={`absolute rounded text-[10px] text-bg font-medium overflow-hidden whitespace-nowrap cursor-pointer transition-[outline] flex items-center gap-0.5 pl-1 ${viz().barBg}`}
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
                <span class={`${viz().icon} shrink-0 text-[9px]`} classList={{ 'animate-spin': bar.status === 'running' }} />
                <span class="truncate">{bar.taskId}</span>
              </div>
            )
          }}
        </For>

        <Show when={cursor() !== null}>
          <div class="absolute top-0 bottom-0 w-px bg-fg-1/50 z-10 pointer-events-none" style={{ left: `${cursor()! * 100}%` }} />
        </Show>
      </div>
    </div>
  )
}

function rank(kind: 'sel' | 'crit' | 'plain'): number {
  return kind === 'plain' ? 0 : kind === 'crit' ? 1 : 2
}
