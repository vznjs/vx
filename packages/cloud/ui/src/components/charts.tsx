// Pure inline-SVG chart primitives. Tiny, dependency-free, designed to read
// well in a dense analytics dashboard. Each chart picks a sane default size
// but is fully containable via width/height props or `class`.
//
// Conventions:
//  - Charts assume the parent provides padding; they don't add their own.
//  - All numeric inputs are nullable-safe via the caller (no NaN propagates).
//  - Strokes use semantic / chart-palette CSS variables so theming Just Works.

import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js'

const MARGIN = { top: 10, right: 12, bottom: 22, left: 44 }

/**
 * Track a container element's width via ResizeObserver so an SVG can fill it.
 * Without this, a fixed-viewBox SVG with width=100% letterboxes its content
 * into a small centered box — the chart looks tiny in a wide column.
 */
function useContainerWidth(fallback: number): [() => number, (el: HTMLElement) => void] {
  const [w, setW] = createSignal(fallback)
  const ref = (el: HTMLElement) => {
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width
      if (cw && cw > 0) setW(Math.floor(cw))
    })
    ro.observe(el)
    onCleanup(() => ro.disconnect())
  }
  return [w, ref]
}

interface LineSeries {
  name: string
  /** Stroke class, e.g. 'stroke-accent', 'stroke-success'. */
  strokeClass: string
  /** Optional fill class for area under the line. */
  areaClass?: string
  data: readonly number[]
}

export interface LineChartProps {
  width?: number
  height?: number
  xs: readonly number[]
  series: readonly LineSeries[]
  /** Optional axis-label formatters. */
  formatX?: (x: number) => string
  formatY?: (y: number) => string
  /** Optional Y minimum (default: 0). */
  yMin?: number
}

export function LineChart(props: LineChartProps) {
  const [measuredW, containerRef] = useContainerWidth(props.width ?? 800)
  const W = () => props.width ?? measuredW()
  const H = () => props.height ?? 260
  const innerW = () => W() - MARGIN.left - MARGIN.right
  const innerH = () => H() - MARGIN.top - MARGIN.bottom

  const allY = createMemo(() => props.series.flatMap((s) => s.data))
  const yMin = () => props.yMin ?? Math.min(0, ...allY())
  const yMax = () => {
    const max = Math.max(1, ...allY())
    // Round up to a nice tick value (1/2/5 × 10ⁿ).
    const pow = Math.pow(10, Math.floor(Math.log10(max)))
    const norm = max / pow
    return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * pow
  }

  const xAt = (i: number, n: number) => {
    if (n <= 1) return innerW() / 2
    return (i / (n - 1)) * innerW()
  }
  const yAt = (v: number) => {
    const range = yMax() - yMin()
    if (range <= 0) return innerH()
    return innerH() - ((v - yMin()) / range) * innerH()
  }

  const pathFor = (data: readonly number[]) =>
    data
      .map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i, data.length).toFixed(1)},${yAt(v).toFixed(1)}`)
      .join(' ')
  const areaFor = (data: readonly number[]) => {
    if (data.length === 0) return ''
    const line = pathFor(data)
    return `${line} L${xAt(data.length - 1, data.length).toFixed(1)},${innerH()} L${xAt(0, data.length).toFixed(1)},${innerH()} Z`
  }

  // Y-axis ticks (3 ticks).
  const yTicks = createMemo(() => {
    const min = yMin()
    const max = yMax()
    return [min, (min + max) / 2, max]
  })
  // X-axis ticks (first, mid, last).
  const xTicks = createMemo(() => {
    const xs = props.xs
    if (xs.length === 0) return []
    if (xs.length === 1) return [{ i: 0, v: xs[0]! }]
    const mid = Math.floor(xs.length / 2)
    return [
      { i: 0, v: xs[0]! },
      { i: mid, v: xs[mid]! },
      { i: xs.length - 1, v: xs[xs.length - 1]! },
    ]
  })

  // Hover state — tracks the nearest point on mouse move. P8: cache the SVG's
  // left edge on pointer-enter (the chart doesn't scroll, so it's stable for
  // the hover) instead of forcing a layout read per mousemove, and coalesce to
  // one index update per animation frame.
  const [hoverIdx, setHoverIdx] = createSignal<number | null>(null)
  let svgLeft = 0
  let pendingX: number | null = null
  let rafId = 0
  const cacheRect = (e: MouseEvent): void => {
    svgLeft = (e.currentTarget as SVGSVGElement).getBoundingClientRect().left
  }
  const flush = (): void => {
    rafId = 0
    const n = props.xs.length
    if (pendingX === null || n === 0) return
    const x = pendingX - svgLeft - MARGIN.left
    setHoverIdx(Math.max(0, Math.min(n - 1, Math.round((x / innerW()) * (n - 1)))))
  }
  const onMove = (e: MouseEvent): void => {
    pendingX = e.clientX
    if (rafId === 0) rafId = requestAnimationFrame(flush)
  }
  const onLeave = (): void => {
    if (rafId !== 0) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    pendingX = null
    setHoverIdx(null)
  }
  onCleanup(() => {
    if (rafId !== 0) cancelAnimationFrame(rafId)
  })

  return (
    <div ref={containerRef} class="w-full">
    <svg
      viewBox={`0 0 ${W()} ${H()}`}
      width="100%"
      height={H()}
      class="block"
      onMouseEnter={cacheRect}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      {/* Grid */}
      <g transform={`translate(${MARGIN.left}, ${MARGIN.top})`}>
        <For each={yTicks()}>
          {(y) => (
            <line
              x1="0"
              x2={innerW()}
              y1={yAt(y)}
              y2={yAt(y)}
              class="stroke-border"
              stroke-width="1"
              stroke-dasharray="2 4"
            />
          )}
        </For>

        {/* Areas (if any) */}
        <For each={props.series}>
          {(s) => (
            <Show when={s.areaClass}>
              <path d={areaFor(s.data)} class={s.areaClass} />
            </Show>
          )}
        </For>

        {/* Lines */}
        <For each={props.series}>
          {(s) => (
            <path
              d={pathFor(s.data)}
              class={s.strokeClass}
              fill="none"
              stroke-width="1.5"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
          )}
        </For>

        {/* Hover indicator */}
        <Show when={hoverIdx() !== null}>
          {(() => {
            const i = hoverIdx()!
            const x = xAt(i, props.xs.length)
            return (
              <g>
                <line
                  x1={x}
                  x2={x}
                  y1={0}
                  y2={innerH()}
                  class="stroke-border-strong"
                  stroke-width="1"
                />
                <For each={props.series}>
                  {(s) =>
                    s.data[i] !== undefined ? (
                      <circle
                        cx={x}
                        cy={yAt(s.data[i]!)}
                        r="3"
                        class={s.strokeClass.replace('stroke-', 'fill-')}
                      />
                    ) : null
                  }
                </For>
              </g>
            )
          })()}
        </Show>
      </g>

      {/* Y-axis labels */}
      <g class="text-[10px] fill-fg-3" font-family="ui-monospace, monospace">
        <For each={yTicks()}>
          {(y) => (
            <text
              x={MARGIN.left - 4}
              y={MARGIN.top + yAt(y) + 3}
              text-anchor="end"
            >
              {props.formatY ? props.formatY(y) : Math.round(y)}
            </text>
          )}
        </For>
      </g>

      {/* X-axis labels */}
      <g class="text-[10px] fill-fg-3" font-family="ui-monospace, monospace">
        <For each={xTicks()}>
          {(t) => (
            <text
              x={MARGIN.left + xAt(t.i, props.xs.length)}
              y={H() - 4}
              text-anchor={t.i === 0 ? 'start' : t.i === props.xs.length - 1 ? 'end' : 'middle'}
            >
              {props.formatX ? props.formatX(t.v) : t.v}
            </text>
          )}
        </For>
      </g>

      {/* Hover tooltip — rendered ONCE with a stable structure (the series list
          doesn't change), so moving between points binds position + text in
          place instead of tearing down and recreating the whole subtree (P8). */}
      <Show when={hoverIdx() !== null}>
        <foreignObject
          x={Math.min(MARGIN.left + xAt(hoverIdx()!, props.xs.length) + 8, W() - 140)}
          y={MARGIN.top}
          width="140"
          height="80"
        >
          <div class="bg-surface-2 border border-border-strong rounded px-2 py-1 text-[11px] shadow-lg">
            <div class="text-fg-3 mb-1 font-mono">
              {props.formatX && props.xs[hoverIdx()!] !== undefined
                ? props.formatX(props.xs[hoverIdx()!]!)
                : props.xs[hoverIdx()!]}
            </div>
            <For each={props.series}>
              {(s) => (
                <div class="flex items-center gap-1.5">
                  <span class={`inline-block w-2 h-2 rounded-full ${s.strokeClass.replace('stroke-', 'bg-')}`} />
                  <span class="text-fg-2">{s.name}</span>
                  <span class="ml-auto font-mono text-fg">
                    {props.formatY && s.data[hoverIdx()!] !== undefined
                      ? props.formatY(s.data[hoverIdx()!]!)
                      : s.data[hoverIdx()!]}
                  </span>
                </div>
              )}
            </For>
          </div>
        </foreignObject>
      </Show>
    </svg>
    {/* Persistent legend on multi-series charts — color alone must never be
        the only key to which line is which (the astryx LegendRow rule). */}
    <Show when={props.series.length > 1}>
      <div class="flex items-center gap-4 px-2 pt-1.5 text-[11px] text-fg-2">
        <For each={props.series}>
          {(s) => (
            <span class="inline-flex items-center gap-1.5">
              <span class={`inline-block w-2.5 h-0.5 rounded-full ${s.strokeClass.replace('stroke-', 'bg-')}`} />
              {s.name}
            </span>
          )}
        </For>
      </div>
    </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Treemap — squarified layout for "where did the bytes/time go"
// ---------------------------------------------------------------------------

interface TreemapNode {
  label: string
  value: number
  colorClass?: string
}

export function Treemap(props: {
  data: readonly TreemapNode[]
  width?: number
  height?: number
  format?: (v: number) => string
}) {
  const W = () => props.width ?? 600
  const H = () => props.height ?? 200

  // Squarify algorithm (Bruls/Huijsen/van Wijk) on the normalized data.
  const tiles = createMemo(() => {
    const total = props.data.reduce((acc, d) => acc + Math.max(0, d.value), 0)
    if (total <= 0) return []
    const items = props.data
      .filter((d) => d.value > 0)
      .map((d, i) => ({ ...d, idx: i, value: (d.value / total) * W() * H() }))
      .sort((a, b) => b.value - a.value)
    const out: Array<{
      x: number
      y: number
      w: number
      h: number
      label: string
      value: number
      colorClass: string
      idx: number
    }> = []
    let x = 0
    let y = 0
    let w = W()
    let h = H()
    let row: typeof items = []
    let rowSum = 0

    const worst = (row: typeof items, side: number) => {
      if (row.length === 0) return Infinity
      const sum = row.reduce((a, r) => a + r.value, 0)
      const rMax = row.reduce((a, r) => Math.max(a, r.value), 0)
      const rMin = row.reduce((a, r) => Math.min(a, r.value), Infinity)
      const s2 = side * side
      return Math.max((s2 * rMax) / (sum * sum), (sum * sum) / (s2 * rMin))
    }
    const layoutRow = (row: typeof items) => {
      const sum = row.reduce((a, r) => a + r.value, 0)
      const horizontal = w >= h
      const side = horizontal ? h : w
      const strip = sum / side
      let cursor = horizontal ? y : x
      for (const r of row) {
        const len = r.value / strip
        out.push({
          x: horizontal ? x : cursor,
          y: horizontal ? cursor : y,
          w: horizontal ? strip : len,
          h: horizontal ? len : strip,
          label: r.label,
          value: r.value,
          // Treemap renders SVG <rect>; callers must pass `fill-…` classes.
          colorClass: r.colorClass ?? 'fill-chart-1',
          idx: r.idx,
        })
        cursor += len
      }
      if (horizontal) {
        x += strip
        w -= strip
      } else {
        y += strip
        h -= strip
      }
    }

    for (const item of items) {
      const side = Math.min(w, h)
      if (
        row.length === 0 ||
        worst([...row, item], side) <= worst(row, side)
      ) {
        row.push(item)
        rowSum += item.value
      } else {
        layoutRow(row)
        row = [item]
        rowSum = item.value
      }
    }
    if (row.length > 0) layoutRow(row)
    return out
  })

  return (
    <svg viewBox={`0 0 ${W()} ${H()}`} width="100%" height={H()} class="block">
      <For each={tiles()}>
        {(t) => {
          const showLabel = t.w > 60 && t.h > 26
          // Recover the raw value from props.data for the formatted label.
          const raw = props.data[t.idx]?.value ?? 0
          return (
            <g>
              <rect
                x={t.x}
                y={t.y}
                width={Math.max(0, t.w - 1)}
                height={Math.max(0, t.h - 1)}
                class={`${t.colorClass} opacity-80 hover:opacity-100 transition-opacity`}
                rx="2"
              >
                <title>
                  {t.label} — {props.format ? props.format(raw) : raw}
                </title>
              </rect>
              <Show when={showLabel}>
                <text
                  x={t.x + 6}
                  y={t.y + 14}
                  class="fill-bg text-[10px] font-mono font-bold pointer-events-none"
                >
                  {t.label}
                </text>
                <text
                  x={t.x + 6}
                  y={t.y + 26}
                  class="fill-bg/80 text-[9px] font-mono pointer-events-none"
                >
                  {props.format ? props.format(raw) : raw}
                </text>
              </Show>
            </g>
          )
        }}
      </For>
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Heatmap — 7×24 grid for run-frequency by day-of-week × hour-of-day
// ---------------------------------------------------------------------------

export interface HeatmapValue {
  dayOfWeek: number
  hourOfDay: number
  value: number
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function Heatmap(props: {
  data: readonly HeatmapValue[]
  cellSize?: number
  format?: (v: number) => string
}) {
  const cell = () => props.cellSize ?? 16
  const xOffset = 28
  const yOffset = 14
  const max = createMemo(() => Math.max(1, ...props.data.map((d) => d.value)))

  return (
    <svg
      viewBox={`0 0 ${24 * cell() + xOffset + 4} ${7 * cell() + yOffset + 4}`}
      width="100%"
      height={7 * cell() + yOffset + 4}
      class="block"
    >
      {/* Hour labels (every 4h) */}
      <g class="text-[9px] fill-fg-3" font-family="ui-monospace, monospace">
        <For each={[0, 4, 8, 12, 16, 20]}>
          {(h) => (
            <text x={xOffset + h * cell() + 1} y={yOffset - 4}>
              {String(h).padStart(2, '0')}
            </text>
          )}
        </For>
      </g>
      {/* Day labels */}
      <g class="text-[9px] fill-fg-3" font-family="ui-monospace, monospace">
        <For each={DAY_LABELS}>
          {(d, i) => (
            <text x={0} y={yOffset + i() * cell() + cell() / 2 + 3}>
              {d}
            </text>
          )}
        </For>
      </g>
      {/* Cells */}
      <For each={props.data}>
        {(c) => {
          const intensity = c.value / max()
          const opacity = c.value === 0 ? 0.05 : 0.15 + 0.85 * intensity
          return (
            <rect
              x={xOffset + c.hourOfDay * cell()}
              y={yOffset + c.dayOfWeek * cell()}
              width={cell() - 2}
              height={cell() - 2}
              class="fill-accent"
              opacity={opacity}
              rx="2"
            >
              <title>
                {DAY_LABELS[c.dayOfWeek]} {String(c.hourOfDay).padStart(2, '0')}:00 —{' '}
                {props.format ? props.format(c.value) : c.value}
              </title>
            </rect>
          )
        }}
      </For>
    </svg>
  )
}

// ---------------------------------------------------------------------------
// HBar — single horizontal bar with a fill % (used in rankings)
// ---------------------------------------------------------------------------

export function HBar(props: { fraction: number; colorClass?: string }) {
  const pct = () => Math.min(100, Math.max(0, props.fraction * 100))
  return (
    <div class="h-1.5 w-full bg-surface-2 rounded-full overflow-hidden">
      <div
        class={`h-full ${props.colorClass ?? 'bg-accent'} rounded-full transition-all`}
        style={{ width: `${pct().toFixed(1)}%` }}
      />
    </div>
  )
}

