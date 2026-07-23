// Shared visualization kit — every chart in the app builds from these so
// series colors, axes, tooltips, and legends never drift between views.
//
// Method notes (dataviz procedure): series hues are the validated
// --vx-chart-* steps (per-mode, see brand.css); status-job charts use the
// reserved status tokens WITH labels; one axis per chart (never dual);
// every multi-series chart carries a legend; marks are thin (2px lines,
// small rounded bars); mount animation is off app-wide so charts show the
// data instantly.

import { Fragment, type CSSProperties, type JSX, type ReactNode } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatCount, formatDuration, formatPercent } from '../format.ts'
import { STATUS, type VizState } from './status.tsx'

export const SERIES_1 = 'var(--vx-chart-1, #7c3aed)'
export const SERIES_2 = 'var(--vx-chart-2, #0891b2)'
export const SERIES_3 = 'var(--vx-chart-3, #db2777)'
const GOOD = 'var(--color-success, #0D8626)'
const BAD = 'var(--color-error, #F5394F)'
const GRID = 'var(--color-border, rgba(120,120,140,0.16))'

export const TICK = { fontSize: 11, fill: 'var(--color-text-secondary)' }
export const TOOLTIP_STYLE: CSSProperties = {
  background: 'var(--color-background-popover)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
}

/** Chart card frame: label + optional hint, consistent padding. */
export function ChartCard(props: {
  title: string
  hint?: string
  end?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <Card padding={4}>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <Text type="label">{props.title}</Text>
          {props.hint !== undefined && (
            <Text type="supporting" color="secondary">
              {props.hint}
            </Text>
          )}
          {props.end !== undefined && (
            <HStack gap={2} style={{ marginInlineStart: 'auto' }}>
              {props.end}
            </HStack>
          )}
        </HStack>
        {props.children}
      </VStack>
    </Card>
  )
}

/** Legend row — swatch + label per series (identity never color-alone). */
export function LegendRow(props: {
  items: ReadonlyArray<{ color: string; label: string }>
}): JSX.Element {
  return (
    <HStack gap={3} vAlign="center" wrap="wrap">
      {props.items.map((it) => (
        <HStack key={it.label} gap={1} vAlign="center">
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 3,
              backgroundColor: it.color,
              display: 'inline-block',
            }}
          />
          <Text type="supporting" size="2xs" color="secondary">
            {it.label}
          </Text>
        </HStack>
      ))}
    </HStack>
  )
}

export interface DayPoint {
  day: string
  [k: string]: string | number | null
}

/** Epoch ms → short day label for daily x-axes. */
export const dayLabel = (t: number): string =>
  new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })

/**
 * The activity pulse: one stacked bar per day — green passed tasks, red
 * failed tasks (status job → status tokens, labeled by the legend). The
 * trends `runs` field counts task executions, not invocations.
 */
export function PulseStrip(props: {
  points: ReadonlyArray<{ t: number; runs: number; failures: number }>
  height?: number
}): JSX.Element {
  const data = props.points.map((p) => ({
    day: dayLabel(p.t),
    passed: Math.max(0, p.runs - p.failures),
    failed: p.failures,
  }))
  return (
    <VStack gap={1}>
      <ResponsiveContainer width="100%" height={props.height ?? 84}>
        <BarChart data={data} margin={{ top: 2, right: 8, left: 8, bottom: 0 }} barCategoryGap="28%">
          <XAxis dataKey="day" tick={TICK} axisLine={false} tickLine={false} minTickGap={28} />
          <YAxis hide domain={[0, 'dataMax']} />
          <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'transparent' }} />
          <Bar
            dataKey="passed"
            name="tasks passed"
            stackId="runs"
            fill={GOOD}
            isAnimationActive={false}
          />
          <Bar
            dataKey="failed"
            name="tasks failed"
            stackId="runs"
            fill={BAD}
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
      <LegendRow
        items={[
          { color: GOOD, label: 'tasks passed' },
          { color: BAD, label: 'tasks failed' },
        ]}
      />
    </VStack>
  )
}

/** Single-series daily area (durations, counts). One axis, one hue. */
export function DailyArea(props: {
  points: ReadonlyArray<{ t: number; value: number }>
  name: string
  color?: string
  format?: (v: number) => string
  height?: number
}): JSX.Element {
  const color = props.color ?? SERIES_1
  const fmt = props.format ?? ((v: number) => formatCount(v))
  const gid = `fill-${props.name.replace(/\W+/g, '-')}`
  const data = props.points.map((p) => ({ day: dayLabel(p.t), value: p.value }))
  return (
    <ResponsiveContainer width="100%" height={props.height ?? 200}>
      <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" style={{ color }} stopOpacity={0.4} />
            <stop offset="100%" stopColor="currentColor" style={{ color }} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid horizontal vertical={false} stroke={GRID} />
        <XAxis dataKey="day" tick={TICK} axisLine={false} tickLine={false} minTickGap={28} />
        <YAxis
          tick={TICK}
          axisLine={false}
          tickLine={false}
          width={52}
          domain={[0, 'dataMax']}
          allowDecimals={false}
          tickFormatter={fmt}
        />
        <Tooltip formatter={(v) => fmt(Number(v))} contentStyle={TOOLTIP_STYLE} />
        <Area
          type="monotone"
          dataKey="value"
          name={props.name}
          stroke={color}
          strokeWidth={2}
          fill={`url(#${gid})`}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

/** Single-series rate line (0..1 values shown as %). Gaps stay gaps. */
export function RateLine(props: {
  points: ReadonlyArray<{ t: number; value: number | null }>
  name: string
  color?: string
  height?: number
}): JSX.Element {
  const color = props.color ?? SERIES_2
  const data = props.points.map((p) => ({ day: dayLabel(p.t), value: p.value }))
  return (
    <ResponsiveContainer width="100%" height={props.height ?? 180}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid horizontal vertical={false} stroke={GRID} />
        <XAxis dataKey="day" tick={TICK} axisLine={false} tickLine={false} minTickGap={28} />
        <YAxis
          tick={TICK}
          axisLine={false}
          tickLine={false}
          width={44}
          domain={[0, 1]}
          tickFormatter={(v: number) => formatPercent(v, 0)}
        />
        <Tooltip
          formatter={(v) => formatPercent(Number(v), 0)}
          contentStyle={TOOLTIP_STYLE}
        />
        <Line
          type="monotone"
          dataKey="value"
          name={props.name}
          stroke={color}
          strokeWidth={2}
          // Dots, not just the line: with null gaps an isolated day would
          // otherwise be invisible (a lone point draws no segment).
          dot={{ r: 3, strokeWidth: 0, fill: color }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Day-of-week × hour-of-day heatmap (sequential job: one hue, alpha ramp =
 * monotonic lightness over the surface). Hover carries the exact numbers.
 */
export function WeekHeatmap(props: {
  cells: ReadonlyArray<{ dow: number; hour: number; runs: number; totalDurationMs: number }>
}): JSX.Element {
  const byKey = new Map(props.cells.map((c) => [c.dow * 24 + c.hour, c]))
  let max = 0
  for (const c of props.cells) max = Math.max(max, c.totalDurationMs)
  const alpha = (v: number): number => (max === 0 || v === 0 ? 0 : 0.15 + 0.85 * (v / max))
  return (
    <VStack gap={1}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `34px repeat(24, 1fr)`,
          gap: 2,
          alignItems: 'center',
        }}
      >
        {WEEKDAYS.map((wd, dow) => (
          <Fragment key={wd}>
            <Text type="supporting" size="2xs" color="secondary">
              {wd}
            </Text>
            {Array.from({ length: 24 }, (_, hour) => {
              const c = byKey.get(dow * 24 + hour)
              const v = c?.totalDurationMs ?? 0
              const a = alpha(v)
              return (
                <span
                  key={`${dow}-${hour}`}
                  title={`${wd} ${String(hour).padStart(2, '0')}:00 — ${c?.runs ?? 0} runs · ${formatDuration(v)}`}
                  style={{
                    display: 'block',
                    aspectRatio: '1 / 1',
                    minWidth: 0,
                    borderRadius: 3,
                    backgroundColor:
                      a === 0 ? 'var(--color-background-muted)' : `rgba(139, 92, 246, ${a})`,
                  }}
                />
              )
            })}
          </Fragment>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <Text
            key={h}
            type="supporting"
            size="2xs"
            color="secondary"
            style={{ textAlign: 'center' }}
          >
            {h % 6 === 0 ? String(h).padStart(2, '0') : ''}
          </Text>
        ))}
      </div>
      <HStack gap={2} vAlign="center">
        <Text type="supporting" size="2xs" color="secondary">
          quiet
        </Text>
        {[0.15, 0.35, 0.6, 1].map((a) => (
          <span
            key={a}
            style={{
              width: 14,
              height: 10,
              borderRadius: 2,
              backgroundColor: `rgba(139, 92, 246, ${a})`,
              display: 'inline-block',
            }}
          />
        ))}
        <Text type="supporting" size="2xs" color="secondary">
          busy · cell = total task time
        </Text>
      </HStack>
    </VStack>
  )
}

/**
 * Per-run duration history for one task: dots on a time axis, colored by
 * the shared STATUS map (labeled by the legend below — never color alone).
 */
export function DurationHistory(props: {
  rows: ReadonlyArray<{ startedAt: number; durationMs: number; state: VizState }>
  height?: number
}): JSX.Element {
  const rows = [...props.rows].sort((a, b) => a.startedAt - b.startedAt)
  const data = rows.map((r) => ({
    at: new Date(r.startedAt).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
    durationMs: r.durationMs,
    state: r.state,
  }))
  const seen = new Set(rows.map((r) => r.state))
  return (
    <VStack gap={1}>
      <ResponsiveContainer width="100%" height={props.height ?? 200}>
        <LineChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid horizontal vertical={false} stroke={GRID} />
          <XAxis dataKey="at" tick={TICK} axisLine={false} tickLine={false} minTickGap={40} />
          <YAxis
            tick={TICK}
            axisLine={false}
            tickLine={false}
            width={52}
            domain={[0, 'dataMax']}
            tickFormatter={(v: number) => formatDuration(v)}
          />
          <Tooltip
            formatter={(v) => formatDuration(Number(v))}
            contentStyle={TOOLTIP_STYLE}
          />
          <Line
            type="monotone"
            dataKey="durationMs"
            name="duration"
            stroke={SERIES_1}
            strokeWidth={1.5}
            strokeOpacity={0.5}
            isAnimationActive={false}
            dot={(p: { cx?: number; cy?: number; index?: number }) => {
              const st = data[p.index ?? 0]?.state ?? 'success'
              return (
                <circle
                  key={p.index}
                  cx={p.cx}
                  cy={p.cy}
                  r={4}
                  fill={STATUS[st].fill}
                  stroke="var(--color-background-card)"
                  strokeWidth={2}
                />
              )
            }}
          />
        </LineChart>
      </ResponsiveContainer>
      <LegendRow
        items={Array.from(seen).map((s) => ({ color: STATUS[s].fill, label: STATUS[s].label }))}
      />
    </VStack>
  )
}

/**
 * Horizontal diverging delta bars (Compare): faster grows left in green,
 * slower grows right in red, shared zero baseline in the middle.
 */
export function DeltaBars(props: {
  entries: ReadonlyArray<{ id: string; deltaMs: number }>
}): JSX.Element {
  const max = Math.max(1, ...props.entries.map((e) => Math.abs(e.deltaMs)))
  return (
    <VStack gap={1}>
      {props.entries.map((e) => {
        const frac = Math.abs(e.deltaMs) / max
        const w = `${Math.max(1.5, frac * 50)}%`
        const faster = e.deltaMs < 0
        return (
          <HStack key={e.id} gap={2} vAlign="center">
            <span style={{ width: 220, minWidth: 220 }}>
              <Text type="code" size="sm" maxLines={1}>
                {e.id}
              </Text>
            </span>
            <span
              title={`${e.deltaMs > 0 ? '+' : ''}${formatDuration(e.deltaMs)}`}
              style={{ position: 'relative', flex: 1, height: 14 }}
            >
              <span
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: 0,
                  bottom: 0,
                  width: 1,
                  backgroundColor: GRID,
                }}
              />
              {e.deltaMs !== 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    bottom: 2,
                    ...(faster ? { right: '50%', width: w } : { left: '50%', width: w }),
                    backgroundColor: faster ? GOOD : BAD,
                    borderRadius: 3,
                  }}
                />
              )}
            </span>
            <span style={{ width: 72, minWidth: 72, textAlign: 'end' }}>
              <Text
                type="code"
                size="sm"
                hasTabularNumbers
                style={{ color: faster ? GOOD : e.deltaMs > 0 ? BAD : undefined }}
              >
                {e.deltaMs === 0 ? '±0' : `${e.deltaMs > 0 ? '+' : '−'}${formatDuration(Math.abs(e.deltaMs))}`}
              </Text>
            </span>
          </HStack>
        )
      })}
      <LegendRow
        items={[
          { color: GOOD, label: 'faster than previous' },
          { color: BAD, label: 'slower than previous' },
        ]}
      />
    </VStack>
  )
}

/** In-table percentage cell: mini bar + the number (visual, never bar-alone). */
export function BarCell(props: { frac: number; color?: string; digits?: number }): JSX.Element {
  const frac = Math.max(0, Math.min(1, props.frac))
  return (
    <HStack gap={1.5} vAlign="center" style={{ justifyContent: 'flex-end' }}>
      <span
        style={{
          width: 44,
          height: 5,
          borderRadius: 2.5,
          backgroundColor: 'var(--color-neutral)',
          overflow: 'hidden',
          display: 'inline-block',
        }}
      >
        <span
          style={{
            display: 'block',
            height: '100%',
            width: `${frac * 100}%`,
            backgroundColor: props.color ?? SERIES_2,
          }}
        />
      </span>
      <Text hasTabularNumbers>{formatPercent(frac, props.digits ?? 0)}</Text>
    </HStack>
  )
}
