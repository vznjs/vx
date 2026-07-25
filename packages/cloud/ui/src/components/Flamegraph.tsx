import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js'
import type { RunSummaryRow } from '../api.ts'
import { formatDuration } from '../format.ts'
import { layout, type LayoutInput } from '../flamegraph-layout.ts'
import { STATUS, toVizState } from './status.tsx'

const LANE_HEIGHT = 22
const LANE_PAD = 5
const AXIS_TICKS = 5
// Below this width (% of the window) a bar can't hold its own label — the
// label moves OUTSIDE the bar, beside it, in normal ink.
const INSIDE_LABEL_PCT = 16

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
  // The chart grows with its lanes and scrolls past this bound — it never
  // paints a fixed-height empty canvas below a short run.
  maxHeight?: number
}) {
  // Use startedAt/endedAt (epoch ms, present for EVERY task) as the uniform
  // time base — wallclock ns spans are null for cache hits, so keying off them
  // dropped every restored task. The bar width is the task's real wall time
  // (for a cache hit that's the restore time, not the original run time).
  // durationMs rides along so the layout can detect a fabricated timeline
  // (every span = the run window) and fall back to honest duration bars.
  const inputs = (): LayoutInput[] =>
    props.tasks.map((t) => ({
      taskId: idOf(t),
      project: t.project,
      startNs: t.startedAt,
      endNs: t.endedAt,
      durationMs: t.durationMs,
      status: t.status,
      cacheHit: t.cacheHit === true,
    }))

  const l = createMemo(() => layout(inputs()))
  const barById = createMemo(() => new Map(l().bars.map((b) => [b.taskId, b])))
  const axisTotal = () => l().totalNs
  const chartHeight = () => Math.max(1, l().lanes.length) * (LANE_HEIGHT + LANE_PAD) + LANE_PAD

  // Which narrow bars get their OUTSIDE label. Greedy per lane, left→right:
  // a label renders only if it clears the previous label and fits before the
  // lane's next bar — a burst of instant cache hits on one lane otherwise
  // stacks its labels into unreadable soup. Suppressed bars keep the tooltip.
  const CHAR_PCT = 0.55 // ≈ one 10px character as % of a ~1100px chart
  const outsideLabels = createMemo(() => {
    const byLane = new Map<number, { id: string; left: number; right: number; wide: boolean }[]>()
    for (const b of l().bars) {
      const arr = byLane.get(b.lane) ?? []
      arr.push({
        id: b.taskId,
        left: b.leftPct,
        right: b.leftPct + b.widthPct,
        wide: b.widthPct >= INSIDE_LABEL_PCT,
      })
      byLane.set(b.lane, arr)
    }
    const show = new Set<string>()
    for (const lane of byLane.values()) {
      lane.sort((a, b) => a.left - b.left)
      let cursor = -Infinity
      for (let i = 0; i < lane.length; i++) {
        const b = lane[i]!
        if (b.wide) {
          cursor = Math.max(cursor, b.right)
          continue
        }
        const est = (b.id.length + 9) * CHAR_PCT // "id · 123ms" + padding
        const nextLeft = lane[i + 1]?.left ?? 101
        if (b.right >= cursor && b.right + est <= nextLeft) {
          show.add(b.id)
          cursor = b.right + est
        }
      }
    }
    return show
  })

  // Edge geometry, in the chart's coordinate space (x = 0..100 %, y = px).
  // `kind` drives emphasis: selected (touches the selected task) > critical
  // (both ends on the critical path) > plain (faint). Duration bars have no
  // time axis to connect along — edges only make sense on a real timeline.
  const edgeGeoms = createMemo(() => {
    if (l().mode === 'durations') return []
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
  // P6: don't force a layout (getBoundingClientRect) on every mousemove. Cache
  // the chart's horizontal geometry when the pointer enters (vertical scroll
  // doesn't affect the X math; a resize mid-hover is negligible), and coalesce
  // cursor updates to one per animation frame.
  let rectLeft = 0
  let rectWidth = 1
  let pendingX: number | null = null
  let rafId = 0
  const cacheRect = (): void => {
    const r = chartRef?.getBoundingClientRect()
    if (r) {
      rectLeft = r.left
      rectWidth = Math.max(1, r.width)
    }
  }
  const flushCursor = (): void => {
    rafId = 0
    if (pendingX === null) return
    setCursor(Math.max(0, Math.min(1, (pendingX - rectLeft) / rectWidth)))
  }
  const onMove = (e: MouseEvent): void => {
    pendingX = e.clientX
    if (rafId === 0) rafId = requestAnimationFrame(flushCursor)
  }
  const onLeave = (): void => {
    if (rafId !== 0) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    pendingX = null
    setCursor(null)
  }
  onCleanup(() => {
    if (rafId !== 0) cancelAnimationFrame(rafId)
  })

  const interiorTicks = Array.from({ length: AXIS_TICKS - 2 }, (_, i) => (i + 1) / (AXIS_TICKS - 1))

  return (
    <div
      class="relative overflow-auto rounded bg-surface-2"
      style={{ 'max-height': `${props.maxHeight ?? 460}px` }}
      onMouseEnter={cacheRect}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      {/* Sticky time axis — stays pinned at the top while the lanes scroll. */}
      <div class="sticky top-0 z-30 h-5 bg-surface-2 border-b border-border/60">
        <For each={Array.from({ length: AXIS_TICKS }, (_, i) => i / (AXIS_TICKS - 1))}>
          {(frac) => (
            <span
              class="absolute top-0.5 text-[9px] text-fg-3 font-mono"
              style={{ left: `${frac * 100}%`, transform: frac === 0 ? 'none' : frac === 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}
            >
              {frac === 0 ? '0' : formatDuration(frac * axisTotal())}
            </span>
          )}
        </For>
        <Show when={cursor() !== null}>
          <span
            class="absolute top-0.5 px-1 rounded bg-fg-1 text-bg text-[9px] font-mono z-10 pointer-events-none whitespace-nowrap"
            style={{ left: `${cursor()! * 100}%`, transform: cursor()! > 0.85 ? 'translateX(-100%)' : 'translateX(-50%)' }}
          >
            {formatDuration(cursor()! * axisTotal())}
          </span>
        </Show>
      </div>

      {/* Honesty note: this run recorded no per-task timeline, so bars show
          each task's duration (longest first) instead of a fabricated one. */}
      <Show when={l().mode === 'durations'}>
        <div class="px-2 py-1 text-[10px] text-fg-3 border-b border-border/40 bg-surface-2 sticky top-5 z-30">
          no per-task timeline recorded — bars show each task's duration, longest first
        </div>
      </Show>

      {/* Chart: gridlines + edges + bars + cursor line. */}
      <div ref={chartRef} class="relative" style={{ height: `${chartHeight()}px` }}>
        {/* recessive vertical gridlines at the tick positions */}
        <For each={interiorTicks}>
          {(frac) => (
            <div class="absolute top-0 bottom-0 w-px bg-border/30 pointer-events-none" style={{ left: `${frac * 100}%` }} />
          )}
        </For>

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
            const label = () => `${bar.taskId} · ${formatDuration(bar.durationMs)}`
            const inside = () => bar.widthPct >= INSIDE_LABEL_PCT
            // An outside label sits after the bar, unless the bar ends near the
            // right edge — then it sits before it, right-aligned.
            const outsideAfter = () => bar.leftPct + bar.widthPct <= 72
            const top = () => bar.lane * (LANE_HEIGHT + LANE_PAD) + LANE_PAD
            return (
              <>
                <div
                  class={`absolute rounded text-[10px] text-bg font-medium overflow-hidden whitespace-nowrap cursor-pointer transition-[outline] flex items-center gap-1 pl-1 ${viz().barBg}`}
                  classList={{
                    'outline outline-2 outline-fg-1 z-20': selected(),
                    'outline outline-2 outline-warn z-10': !selected() && onPath(),
                    'hover:brightness-110': !selected(),
                  }}
                  style={{
                    left: `${bar.leftPct}%`,
                    width: `${bar.widthPct}%`,
                    top: `${top()}px`,
                    height: `${LANE_HEIGHT}px`,
                  }}
                  title={`${bar.taskId} — ${viz().label} · ${formatDuration(bar.durationMs)}`}
                  onClick={() => {
                    const t = task()
                    if (t) props.onSelect?.(t)
                  }}
                >
                  <span class={`${viz().icon} shrink-0 text-[9px]`} classList={{ 'animate-spin': bar.status === 'running' }} />
                  <Show when={inside()}>
                    <span class="truncate">{label()}</span>
                  </Show>
                </div>
                <Show when={!inside() && (outsideLabels().has(bar.taskId) || !outsideAfter())}>
                  <span
                    class="absolute text-[10px] text-fg-2 whitespace-nowrap truncate max-w-[220px] pointer-events-none flex items-center"
                    style={{
                      top: `${top()}px`,
                      height: `${LANE_HEIGHT}px`,
                      ...(outsideAfter()
                        ? { left: `calc(${bar.leftPct + bar.widthPct}% + 6px)` }
                        : { right: `calc(${100 - bar.leftPct}% + 6px)` }),
                    }}
                  >
                    {label()}
                  </span>
                </Show>
              </>
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
