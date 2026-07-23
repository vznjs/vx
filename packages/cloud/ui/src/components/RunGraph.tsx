// The run DAG as a STAGED flow — left-to-right dependency-depth columns of
// cards, SVG dependency edges, the bottleneck (critical) path lit amber, and
// per-task duration / CPU% / peak-RAM chips. Custom DOM + SVG (not a canvas
// lib) so it stays on theme. All colors come from design tokens / the shared
// STATUS map so the graph never disagrees with the flame or tables.
//
// Deterministic fixed-grid layout (run-graph-layout.ts) → edges are drawn from
// computed pixel coords with no DOM measurement. Scroll to pan; the zoom
// control scales the canvas. Status/duration/selection/critical are plain
// props, so live ticks repaint in place. The absolutely-positioned internals
// are visualization geometry (the sanctioned SVG-internals exception); every
// color is a token.

import { useMemo, useState, type CSSProperties, type JSX } from 'react'
import { FireIcon, MinusIcon, PlusIcon } from '@heroicons/react/24/outline'
import { Button } from '@astryxdesign/core/Button'
import { Icon } from '@astryxdesign/core/Icon'
import { IconButton } from '@astryxdesign/core/IconButton'
import { HStack, StackItem, VStack } from '@astryxdesign/core/Layout'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Text } from '@astryxdesign/core/Text'
import { Token } from '@astryxdesign/core/Token'
import type { GraphNode } from '../api.ts'
import { cpuPct as cpuPctOf, formatBytes, formatDuration } from '../format.ts'
import { layoutLevels } from './run-graph-layout.ts'
import { PREDICTED, STATUS, type VizState } from './status.tsx'

/** Per-task CPU/RAM numbers shown as card chips. */
export interface RunGraphCpuStats {
  cpuMs?: number
  peakRssBytes?: number
}

export interface RunGraphProps {
  /** DAG nodes from /v1/graph (id, project, task, isGroup, deps, cacheStatus). */
  nodes: readonly GraphNode[]
  /**
   * Live/recorded VizState per task id; a missing id renders as 'queued'.
   * Groups (umbrella tasks) always render as 'group' regardless of this map.
   */
  states: ReadonlyMap<string, VizState>
  /** Duration (ms) per task id — live elapsed while running, recorded once done. */
  durations?: ReadonlyMap<string, number>
  /** CPU-time / peak-RSS per task id, for the card chips. */
  cpu?: ReadonlyMap<string, RunGraphCpuStats>
  /** Bottleneck — the critical (longest-duration) path: cards + edges glow amber. */
  criticalPath?: ReadonlySet<string>
  selected?: string | null
  onSelect?: (id: string) => void
  /**
   * Predicted-cache chip (from `node.cacheStatus`) on QUEUED cards only, so
   * predictions clear naturally as live events land. Disable for recorded
   * runs, where a predicted-now chip would be misleading. @default true
   */
  showPredicted?: boolean
}

const CARD_W = 212
const CARD_H = 96
const COL_GAP = 64
const ROW_GAP = 18
const HEADER_H = 34
const COL_STRIDE = CARD_W + COL_GAP
const ROW_STRIDE = CARD_H + ROW_GAP
// Canvas inset so the level guides (which extend 10px past the cards) never
// clip against the scroll container's edge.
const PAD = 16

const COLOR_WARN = 'var(--color-warning, #F2C00B)'
const COLOR_EDGE = 'var(--color-border-emphasized, #494D53)'
const COLOR_ACCENT = 'var(--color-accent, #2694FE)'

const xOf = (level: number): number => PAD + level * COL_STRIDE
const yOf = (row: number): number => PAD / 2 + HEADER_H + row * ROW_STRIDE

interface EdgeGeom {
  d: string
  crit: boolean
}

export function RunGraph(props: RunGraphProps): JSX.Element {
  const { nodes, states, durations, cpu, criticalPath, selected, onSelect } = props
  const showPredicted = props.showPredicted ?? true
  const [zoom, setZoom] = useState(1)
  const nudge = (d: number): void => {
    setZoom((z) => Math.min(1.6, Math.max(0.4, Math.round((z + d) * 10) / 10)))
  }

  const l = useMemo(() => layoutLevels(nodes), [nodes])
  const width = Math.max(1, l.levelCount) * COL_STRIDE - COL_GAP + PAD * 2
  const height = PAD / 2 + HEADER_H + Math.max(1, l.maxRows) * ROW_STRIDE + 8

  const edges = useMemo((): EdgeGeom[] => {
    const out: EdgeGeom[] = []
    for (const n of nodes) {
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
          crit: criticalPath?.has(dep) === true && criticalPath?.has(n.id) === true,
        })
      }
    }
    return out
  }, [nodes, l, criticalPath])

  const levels = useMemo(
    () =>
      Array.from({ length: l.levelCount }, (_, i) => ({
        i,
        x: xOf(i),
        count: l.levelSizes[i] ?? 0,
      })),
    [l],
  )

  const stateOf = (n: GraphNode): VizState => (n.isGroup ? 'group' : (states.get(n.id) ?? 'queued'))

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0, overflow: 'auto' }}>
      <div style={{ width: width * zoom, height: height * zoom }}>
        <div
          style={{
            position: 'relative',
            width,
            height,
            transform: `scale(${zoom})`,
            transformOrigin: '0 0',
          }}
        >
          {/* depth-level guides + headers (structure, NOT execution waves) */}
          {levels.map((s) => (
            <div key={s.i}>
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 8,
                  left: s.x - 10,
                  width: CARD_W + 20,
                  borderRadius: 'var(--radius-container, 12px)',
                  backgroundColor: 'var(--color-background-muted)',
                }}
              />
              <div style={{ position: 'absolute', left: s.x, top: 4, width: CARD_W }}>
                <HStack gap={2} vAlign="end">
                  <Text type="label" color="secondary">
                    Level {s.i + 1}
                  </Text>
                  <Text type="supporting" color="secondary">
                    {s.count} task{s.count === 1 ? '' : 's'}
                  </Text>
                </HStack>
              </div>
            </div>
          ))}

          {/* dependency edges */}
          <svg
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}
            width={width}
            height={height}
            aria-hidden="true"
          >
            {edges.map((e, i) => (
              <path
                key={i}
                d={e.d}
                fill="none"
                stroke={e.crit ? COLOR_WARN : COLOR_EDGE}
                strokeWidth={e.crit ? 2.5 : 1.5}
                strokeOpacity={e.crit ? 0.9 : 0.55}
              />
            ))}
          </svg>

          {/* task cards */}
          {nodes.map((n) => {
            const pos = l.pos.get(n.id)
            if (!pos) return null
            const state = stateOf(n)
            const viz = STATUS[state]
            const stats = cpu?.get(n.id)
            const durationMs = durations?.get(n.id)
            const pct = cpuPctOf(stats?.cpuMs, durationMs)
            const crit = criticalPath?.has(n.id) === true
            const isSelected = selected === n.id
            const predicted =
              showPredicted && state === 'queued' && !n.isGroup ? PREDICTED[n.cacheStatus] : null
            const cardStyle: CSSProperties = {
              position: 'absolute',
              left: xOf(pos.level),
              top: yOf(pos.row),
              width: CARD_W,
              height: CARD_H,
              padding: 0,
              textAlign: 'start',
              overflow: 'hidden',
              cursor: onSelect ? 'pointer' : 'default',
              borderRadius: 'var(--radius-element, 8px)',
              border: `var(--border-width, 1px) solid ${
                isSelected ? COLOR_ACCENT : crit ? COLOR_WARN : 'var(--color-border-emphasized)'
              }`,
              boxShadow: isSelected
                ? 'var(--shadow-inset-selected)'
                : crit
                  ? 'var(--shadow-inset-warning)'
                  : 'var(--shadow-low)',
              backgroundColor: 'var(--color-background-card)',
              color: 'var(--color-text-primary)',
            }
            return (
              <button
                key={n.id}
                type="button"
                title={n.id}
                onClick={onSelect === undefined ? undefined : () => onSelect(n.id)}
                style={cardStyle}
              >
                {/* status rail — token-based SVG-style fill from the STATUS map */}
                <span
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: 4,
                    backgroundColor: viz.fill,
                    opacity: n.isGroup ? 0.4 : 1,
                  }}
                />
                <VStack
                  gap={1}
                  padding={2}
                  style={{ height: '100%', paddingInlineStart: 'var(--spacing-3)', minWidth: 0 }}
                >
                  <HStack gap={1.5} vAlign="center">
                    <StatusDot variant={viz.dot} label={viz.label} isPulsing={viz.pulse} />
                    <StackItem size="fill" style={{ minWidth: 0 }}>
                      <Text type="code" size="sm" maxLines={1}>
                        {n.task}
                      </Text>
                    </StackItem>
                    {crit && <Icon icon={FireIcon} size="xsm" color="warning" aria-label="bottleneck" />}
                  </HStack>
                  <Text type="supporting" size="2xs" color="secondary" maxLines={1}>
                    {n.project}
                  </Text>
                  {n.isGroup ? (
                    <Text type="supporting" size="2xs" color="secondary">
                      group
                    </Text>
                  ) : (
                    <HStack gap={1} vAlign="center" wrap="nowrap" style={{ minWidth: 0 }}>
                      {durationMs !== undefined && durationMs > 0 && (
                        <Text type="code" size="2xs" color="secondary" hasTabularNumbers>
                          {formatDuration(durationMs)}
                        </Text>
                      )}
                      {pct !== undefined && <Token size="sm" color="gray" label={`${pct}% cpu`} />}
                      {stats?.peakRssBytes !== undefined && stats.peakRssBytes > 0 && (
                        <Token size="sm" color="gray" label={formatBytes(stats.peakRssBytes)} />
                      )}
                      {predicted !== null && predicted !== undefined && (
                        <Token size="sm" color={predicted.token} label={predicted.label} />
                      )}
                    </HStack>
                  )}
                </VStack>
              </button>
            )
          })}
        </div>
      </div>

      {/* honesty caption: columns are dependency depth, not timed waves */}
      <div
        style={{
          position: 'absolute',
          bottom: 'var(--spacing-3)',
          left: 'var(--spacing-3)',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      >
        <Text type="supporting" size="2xs" color="secondary">
          levels = dependency depth · cache hits restore immediately, ahead of their deps
        </Text>
      </div>

      {/* zoom controls */}
      <div style={{ position: 'absolute', bottom: 'var(--spacing-3)', right: 'var(--spacing-3)' }}>
        <HStack
          gap={0.5}
          vAlign="center"
          padding={0.5}
          style={{
            borderRadius: 'var(--radius-element, 8px)',
            border: 'var(--border-width, 1px) solid var(--color-border)',
            backgroundColor: 'var(--color-background-popover)',
            boxShadow: 'var(--shadow-low)',
          }}
        >
          <IconButton
            label="Zoom out"
            icon={<Icon icon={MinusIcon} size="sm" />}
            size="sm"
            variant="ghost"
            onClick={() => nudge(-0.1)}
          />
          <Button
            label={`${Math.round(zoom * 100)}%`}
            size="sm"
            variant="ghost"
            onClick={() => setZoom(1)}
            tooltip="reset zoom"
          />
          <IconButton
            label="Zoom in"
            icon={<Icon icon={PlusIcon} size="sm" />}
            size="sm"
            variant="ghost"
            onClick={() => nudge(0.1)}
          />
        </HStack>
      </div>
    </div>
  )
}
