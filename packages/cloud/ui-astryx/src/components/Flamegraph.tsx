// Time-packed flamegraph of a run: bars are greedily packed into lanes
// (flamegraph-layout.ts) so lanes reveal parallelism; a sticky time axis, a
// hover point-of-time cursor + readout, clickable bars → select a task, and
// dependency connectors (dep → dependent). Cache hits (≈0ms) render as thin
// clickable marks via the layout's min-width floor.
//
// Uses startedAt/endedAt (epoch ms, present on EVERY row) as the uniform time
// base — wallclock ns spans are null for cache hits, so keying off them would
// drop every restored task. Bar geometry is computed pixel/percent math (the
// visualization-internals exception); every color comes from the shared
// STATUS map / design tokens.

import { useMemo, useRef, useState, type JSX, type MouseEvent } from 'react'
import { Text } from '@astryxdesign/core/Text'
import type { RunSummaryRow } from '../api.ts'
import { formatDuration } from '../format.ts'
import { layout, type LayoutInput } from '../flamegraph-layout.ts'
import { STATUS, toVizState } from './status.tsx'

const LANE_HEIGHT = 22
const LANE_PAD = 4
const AXIS_TICKS = 5

const idOf = (t: RunSummaryRow): string => `${t.project}#${t.task}`
const laneMid = (lane: number): number => lane * (LANE_HEIGHT + LANE_PAD) + LANE_PAD + LANE_HEIGHT / 2

const COLOR_WARN = 'var(--color-warning, #F2C00B)'
const COLOR_ACCENT = 'var(--color-accent, #2694FE)'
const COLOR_EDGE = 'var(--color-icon-gray, #748695)'
const COLOR_OUTLINE = 'var(--color-text-primary)'

/** A dependency edge: `from` (the task that unlocked) → `to` (what it unlocked). */
export interface FlameEdge {
  from: string
  to: string
}

/** Flatten graph nodes (id + deps) into dep → dependent flame edges. */
export function flameEdgesOf(
  nodes: readonly { id: string; deps: readonly string[] }[],
): FlameEdge[] {
  const out: FlameEdge[] = []
  for (const n of nodes) for (const d of n.deps) out.push({ from: d, to: n.id })
  return out
}

export interface FlamegraphProps {
  tasks: readonly RunSummaryRow[]
  /** `${project}#${task}` of the selected task — its bar gets an outline. */
  selectedId?: string
  /** Bars whose `${project}#${task}` id is in this set get a critical-path ring. */
  highlightIds?: ReadonlySet<string>
  /**
   * Dependency edges (dep → dependent). Drawn faint; the selected task's
   * edges and the critical path are emphasized.
   */
  edges?: readonly FlameEdge[]
  onSelect?: (task: RunSummaryRow) => void
}

type EdgeKind = 'sel' | 'crit' | 'plain'

const rank = (kind: EdgeKind): number => (kind === 'plain' ? 0 : kind === 'crit' ? 1 : 2)

export function Flamegraph(props: FlamegraphProps): JSX.Element {
  const { tasks, selectedId, highlightIds, edges, onSelect } = props

  const l = useMemo(() => {
    const inputs: LayoutInput[] = tasks.map((t) => ({
      taskId: idOf(t),
      project: t.project,
      startNs: t.startedAt,
      endNs: t.endedAt,
      status: t.status,
      cacheHit: t.cacheHit === true,
    }))
    return layout(inputs)
  }, [tasks])

  const barById = useMemo(() => new Map(l.bars.map((b) => [b.taskId, b])), [l])

  const window = useMemo(() => {
    if (tasks.length === 0) return { min: 0, total: 1 }
    const min = Math.min(...tasks.map((t) => t.startedAt))
    const max = Math.max(...tasks.map((t) => t.endedAt))
    return { min, total: Math.max(1, max - min) }
  }, [tasks])

  const chartHeight = Math.max(1, l.lanes.length) * (LANE_HEIGHT + LANE_PAD) + LANE_PAD

  // Edge geometry in the chart's coordinate space (x = 0..100 units, y = px).
  // `kind` drives emphasis: selected > critical > plain (faint).
  const edgeGeoms = useMemo(() => {
    const out: Array<{ d: string; kind: EdgeKind }> = []
    for (const e of edges ?? []) {
      const a = barById.get(e.from)
      const b = barById.get(e.to)
      if (!a || !b) continue
      const x1 = a.leftPct + a.widthPct
      const y1 = laneMid(a.lane)
      const x2 = b.leftPct
      const y2 = laneMid(b.lane)
      const dx = Math.max(2, (x2 - x1) / 2)
      const kind: EdgeKind =
        selectedId !== undefined && (e.from === selectedId || e.to === selectedId)
          ? 'sel'
          : highlightIds?.has(e.from) === true && highlightIds?.has(e.to) === true
            ? 'crit'
            : 'plain'
      out.push({ d: `M ${x1},${y1} C ${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, kind })
    }
    // Emphasized edges last so they paint on top.
    return out.sort((p, q) => rank(p.kind) - rank(q.kind))
  }, [edges, barById, selectedId, highlightIds])

  const [cursor, setCursor] = useState<number | null>(null) // fraction 0..1
  const chartRef = useRef<HTMLDivElement | null>(null)
  const onMove = (e: MouseEvent<HTMLDivElement>): void => {
    const el = chartRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setCursor(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
  }

  const ticks = useMemo(
    () => Array.from({ length: AXIS_TICKS }, (_, i) => i / (AXIS_TICKS - 1)),
    [],
  )

  return (
    <div
      style={{
        position: 'relative',
        height: '100%',
        overflow: 'auto',
        borderRadius: 'var(--radius-element, 8px)',
        backgroundColor: 'var(--color-background-muted)',
      }}
      onMouseMove={onMove}
      onMouseLeave={() => setCursor(null)}
    >
      {/* Sticky time axis — pinned at the top while the lanes scroll. */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 30,
          height: 20,
          backgroundColor: 'var(--color-background-surface)',
          borderBottom: 'var(--border-width, 1px) solid var(--color-border)',
        }}
      >
        {ticks.map((frac) => (
          <span
            key={frac}
            style={{
              position: 'absolute',
              top: 2,
              left: `${frac * 100}%`,
              transform: frac === 0 ? 'none' : frac === 1 ? 'translateX(-100%)' : 'translateX(-50%)',
            }}
          >
            <Text type="code" size="2xs" color="secondary" hasTabularNumbers>
              {formatDuration(frac * window.total)}
            </Text>
          </span>
        ))}
        {cursor !== null && (
          <span
            style={{
              position: 'absolute',
              top: 2,
              zIndex: 10,
              left: `${cursor * 100}%`,
              transform: cursor > 0.85 ? 'translateX(-100%)' : 'translateX(-50%)',
              padding: '0 var(--spacing-1)',
              borderRadius: 'var(--radius-inner, 4px)',
              backgroundColor: 'var(--color-background-inverted)',
              color: 'var(--color-background-card)',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            <Text type="code" size="2xs" color="inherit" hasTabularNumbers>
              {formatDuration(cursor * window.total)}
            </Text>
          </span>
        )}
      </div>

      {/* Chart: edges + bars + cursor line. */}
      <div ref={chartRef} style={{ position: 'relative', height: chartHeight }}>
        {/* dependency connectors (dep → dependent) */}
        <svg
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          width="100%"
          height={chartHeight}
          viewBox={`0 0 100 ${chartHeight}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {edgeGeoms.map((e, i) => (
            <path
              key={i}
              d={e.d}
              fill="none"
              vectorEffect="non-scaling-stroke"
              stroke={e.kind === 'sel' ? COLOR_ACCENT : e.kind === 'crit' ? COLOR_WARN : COLOR_EDGE}
              strokeWidth={e.kind === 'plain' ? 1 : 1.75}
              strokeOpacity={e.kind === 'sel' ? 0.9 : e.kind === 'crit' ? 0.7 : 0.16}
            />
          ))}
        </svg>

        {l.bars.map((bar, i) => {
          const task = tasks[i]
          const viz = STATUS[toVizState(bar.status, bar.cacheHit)]
          const isSelected = selectedId === bar.taskId
          const onPath = highlightIds?.has(bar.taskId) === true
          return (
            <button
              key={bar.taskId}
              type="button"
              title={bar.taskId}
              onClick={() => {
                if (task && onSelect) onSelect(task)
              }}
              style={{
                position: 'absolute',
                left: `${bar.leftPct}%`,
                width: `${bar.widthPct}%`,
                top: bar.lane * (LANE_HEIGHT + LANE_PAD) + LANE_PAD,
                height: LANE_HEIGHT,
                zIndex: isSelected ? 20 : onPath ? 10 : undefined,
                padding: '0 0 0 var(--spacing-1)',
                border: 'none',
                borderRadius: 'var(--radius-inner, 4px)',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
                textAlign: 'start',
                cursor: 'pointer',
                backgroundColor: viz.fill,
                color: 'var(--color-background-body)',
                fontFamily: 'var(--font-family-code, monospace)',
                fontSize: 10,
                fontWeight: 500,
                outline: isSelected
                  ? `2px solid ${COLOR_OUTLINE}`
                  : onPath
                    ? `2px solid ${COLOR_WARN}`
                    : 'none',
                outlineOffset: -1,
              }}
            >
              {bar.taskId}
            </button>
          )
        })}

        {cursor !== null && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              width: 1,
              left: `${cursor * 100}%`,
              backgroundColor: 'var(--color-text-primary)',
              opacity: 0.5,
              zIndex: 10,
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
    </div>
  )
}
