// The run DAG as a STAGED flow — left-to-right stages (topological waves) of
// polished cards, with dependency edges, the bottleneck (critical) path lit,
// and per-task duration / CPU% / peak RAM. Custom DOM + SVG (not a canvas lib)
// so it inherits the dashboard's theme: gradients, borders, crisp type.
//
// Deterministic layout (fixed card grid) → edges are drawn from computed coords
// with no DOM measurement. Scroll to pan; zoom controls scale the canvas. State
// (status/duration/metrics/selection/critical) is plain reactive props, so live
// ticks repaint in place.
//
// NB: every status class below is a LITERAL string so UnoCSS's static extractor
// emits it — never interpolate token names into `border-${x}` (those get dropped
// from the build).

import { For, Show, createMemo, createSignal } from 'solid-js'
import { cpuPct as cpuPctOf, formatBytes, formatDuration } from '../format.ts'
import { contractGroups, layoutLevels } from './run-graph-layout.ts'
import { PREDICTED, STATUS, type PredictedStatus, type VizState } from './status.tsx'

export interface RunGraphNode {
  id: string
  project: string
  task: string
  isGroup: boolean
  deps: readonly string[]
}

/** Per-task numbers shown on the card. */
export interface RunGraphStats {
  durationMs?: number
  cpuMs?: number
  peakRssBytes?: number
}

// The graph speaks the shared VizState vocabulary (status.ts) so its colors /
// icons match the flame + cockpit exactly. Kept as a named re-export for callers.
export type RunGraphState = VizState

const CARD_W = 212
const CARD_H = 92
const COL_GAP = 64
const ROW_GAP = 18
const HEADER_H = 34
const COL_STRIDE = CARD_W + COL_GAP
const ROW_STRIDE = CARD_H + ROW_GAP

export function RunGraph(props: {
  nodes: readonly RunGraphNode[]
  stateOf: (id: string) => RunGraphState
  statsOf?: (id: string) => RunGraphStats
  selectedId?: string | null
  /** Bottleneck — the critical (longest-duration) path: cards + edges glow. */
  highlightIds?: ReadonlySet<string>
  /**
   * Predicted cache status (from /v1/graph) — rendered as a chip on QUEUED
   * cards only, so predictions clear naturally as live events arrive.
   */
  predictedOf?: (id: string) => PredictedStatus | undefined
  onSelect?: (id: string) => void
}) {
  const effState = (n: RunGraphNode): RunGraphState => props.stateOf(n.id)
  const statsFor = (id: string): RunGraphStats => props.statsOf?.(id) ?? {}

  // Groups are organizational folders (no exec) — hidden from the graph, with
  // edges contracted through them so the DAG stays connected.
  const visible = createMemo(() => contractGroups(props.nodes))
  const layout = createMemo(() => layoutLevels(visible()))
  const width = () => Math.max(1, layout().levelCount) * COL_STRIDE - COL_GAP + 24
  const height = () => HEADER_H + Math.max(1, layout().maxRows) * ROW_STRIDE + 8

  const [zoom, setZoom] = createSignal(1)
  const nudge = (d: number) => setZoom((z) => Math.min(1.6, Math.max(0.4, Math.round((z + d) * 10) / 10)))

  const xOf = (level: number) => level * COL_STRIDE
  const yOf = (row: number) => HEADER_H + row * ROW_STRIDE

  const edges = createMemo(() => {
    const l = layout()
    const out: Array<{ d: string; crit: boolean }> = []
    for (const n of visible()) {
      const to = l.pos.get(n.id)
      if (!to) continue
      for (const dep of n.deps) {
        const from = l.pos.get(dep)
        if (!from) continue
        const sx = xOf(from.level) + CARD_W
        const sy = yOf(from.row) + CARD_H / 2
        const tx = xOf(to.level)
        const ty = yOf(to.row) + CARD_H / 2
        const mx = sx + (tx - sx) / 2
        out.push({
          d: `M ${sx},${sy} C ${mx},${sy} ${mx},${ty} ${tx},${ty}`,
          crit: props.highlightIds?.has(dep) === true && props.highlightIds?.has(n.id) === true,
        })
      }
    }
    return out
  })

  const levels = createMemo(() =>
    Array.from({ length: layout().levelCount }, (_, i) => ({
      i,
      x: xOf(i),
      count: layout().levelSizes[i] ?? 0,
    })),
  )

  return (
    <div class="relative w-full h-full min-h-0 overflow-auto">
      <div style={{ width: `${width() * zoom()}px`, height: `${height() * zoom()}px` }}>
        <div
          class="relative"
          style={{
            width: `${width()}px`,
            height: `${height()}px`,
            transform: `scale(${zoom()})`,
            'transform-origin': '0 0',
          }}
        >
          {/* depth-level guides + headers (structure, NOT execution waves) */}
          <For each={levels()}>
            {(s) => (
              <>
                <div
                  class="absolute top-0 bottom-2 rounded-xl bg-surface-2/20"
                  style={{ left: `${s.x - 10}px`, width: `${CARD_W + 20}px` }}
                />
                <div class="absolute flex items-baseline gap-2" style={{ left: `${s.x}px`, top: '4px', width: `${CARD_W}px` }}>
                  <span class="text-[10px] font-semibold uppercase tracking-wider text-fg-3">Level {s.i + 1}</span>
                  <span class="text-[10px] font-mono text-fg-3/60 tabular-nums">
                    {s.count} task{s.count === 1 ? '' : 's'}
                  </span>
                </div>
              </>
            )}
          </For>

          {/* edges */}
          <svg class="absolute inset-0 pointer-events-none overflow-visible" width={width()} height={height()}>
            <For each={edges()}>
              {(e) => (
                <path
                  d={e.d}
                  fill="none"
                  class={e.crit ? 'stroke-warn' : 'stroke-border-strong'}
                  stroke-width={e.crit ? 2.5 : 1.5}
                  stroke-opacity={e.crit ? 0.9 : 0.55}
                />
              )}
            </For>
          </svg>

          {/* cards */}
          <For each={visible()}>
            {(n) => {
              const pos = () => layout().pos.get(n.id)
              const sty = () => STATUS[effState(n)]
              const stats = () => statsFor(n.id)
              const cpu = () => cpuPctOf(stats().cpuMs, stats().durationMs)
              const crit = () => props.highlightIds?.has(n.id) === true
              const selected = () => props.selectedId === n.id
              const predicted = () =>
                effState(n) === 'queued' ? PREDICTED[props.predictedOf?.(n.id) ?? 'group'] : null
              return (
                <Show when={pos()}>
                  <button
                    onClick={() => props.onSelect?.(n.id)}
                    class="absolute text-left rounded-xl border bg-gradient-to-b from-surface to-surface-2/60 shadow-card overflow-hidden transition-transform duration-150 hover:-translate-y-px hover:shadow-elevated"
                    classList={{
                      [sty().border]: !selected() && !crit(),
                      'border-accent ring-2 ring-accent/40': selected(),
                      'border-warn/70 ring-2 ring-warn/40': crit() && !selected(),
                    }}
                    style={{
                      left: `${xOf(pos()!.level)}px`,
                      top: `${yOf(pos()!.row)}px`,
                      width: `${CARD_W}px`,
                      height: `${CARD_H}px`,
                      // Big-graph perf: off-viewport cards skip layout + paint
                      // entirely (the fixed grid supplies the intrinsic size, so
                      // scroll geometry is exact). On a 1000-task graph this cuts
                      // the painted card count to the visible window.
                      'content-visibility': 'auto',
                      'contain-intrinsic-size': `${CARD_W}px ${CARD_H}px`,
                    }}
                    title={n.id}
                  >
                    <span class={`absolute left-0 top-0 bottom-0 w-1 ${sty().rail}`} />
                    <div class="pl-3 pr-2.5 py-2 flex flex-col h-full gap-1">
                      <div class="flex items-center gap-1.5 min-w-0">
                        <span class={`${sty().icon} ${sty().dot} text-[13px] shrink-0`} classList={{ 'animate-spin': effState(n) === 'running' }} />
                        <span class="font-mono text-[12.5px] text-fg-1 font-medium truncate">{n.task}</span>
                        <Show when={crit()}>
                          <span class="i-tabler-flame text-warn text-[12px] ml-auto shrink-0" title="bottleneck" />
                        </Show>
                      </div>
                      <div class="text-[10px] text-fg-3 font-mono truncate">{n.project}</div>
                      <div class="flex items-center gap-1 text-[10px] font-mono tabular-nums">
                        <Show when={(stats().durationMs ?? 0) > 0}>
                          <span class="text-fg-2">{formatDuration(stats().durationMs!)}</span>
                        </Show>
                        <Show when={cpu() !== undefined}>
                          <Chip icon="i-tabler-cpu" value={`${cpu()}%`} />
                        </Show>
                        <Show when={(stats().peakRssBytes ?? 0) > 0}>
                          <Chip icon="i-tabler-database" value={formatBytes(stats().peakRssBytes!)} />
                        </Show>
                        <Show when={predicted()}>
                          {(p) => (
                            <span class={`inline-flex items-center gap-0.5 rounded px-1 py-px ${p().cls}`} title="predicted from cache key">
                              <span class={`${p().icon} text-[10px]`} aria-hidden="true" />
                              {p().label}
                            </span>
                          )}
                        </Show>
                      </div>
                    </div>
                  </button>
                </Show>
              )
            }}
          </For>
        </div>
      </div>

      {/* honesty caption: columns are dependency depth, not timed waves */}
      <div class="absolute bottom-3 left-3 text-[10px] text-fg-3/70 font-mono pointer-events-none select-none">
        levels = dependency depth · cache hits restore immediately, ahead of their deps
      </div>

      {/* zoom controls */}
      <div class="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-lg border border-border bg-surface/95 p-0.5 shadow-card">
        <ZoomBtn icon="i-tabler-minus" onClick={() => nudge(-0.1)} />
        <button onClick={() => setZoom(1)} class="px-2 text-[11px] font-mono text-fg-3 hover:text-fg-1 tabular-nums w-12" title="reset zoom">
          {Math.round(zoom() * 100)}%
        </button>
        <ZoomBtn icon="i-tabler-plus" onClick={() => nudge(0.1)} />
      </div>
    </div>
  )
}

function Chip(props: { icon: string; value: string }) {
  return (
    <span class="inline-flex items-center gap-0.5 rounded bg-surface-2/70 px-1 py-px text-fg-3">
      <span class={`${props.icon} text-[10px]`} />
      {props.value}
    </span>
  )
}

function ZoomBtn(props: { icon: string; onClick: () => void }) {
  return (
    <button onClick={props.onClick} class="grid place-items-center w-6 h-6 rounded text-fg-3 hover:text-fg-1 hover:bg-surface-hover transition">
      <span class={`${props.icon} text-[13px]`} />
    </button>
  )
}
