// Trends — patterns over time: daily run activity / duration / hit-rate from
// the trends endpoint, a day×hour build heatmap, parallelism history per
// invocation, and cache storage growth. Charts follow the astryx analytics
// dashboard recharts pattern; the heatmap is a hand-rolled token-colored SVG.

import type { JSX } from 'react'
import { StopIcon } from '@heroicons/react/24/solid'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Grid } from '@astryxdesign/core/Grid'
import { Icon } from '@astryxdesign/core/Icon'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Heading, Text } from '@astryxdesign/core/Text'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  getHeatmap,
  getParallelismHistory,
  getRunTrends,
  getStorageGrowth,
  type HeatmapCellApi,
  type ParallelismPoint,
  type TrendPoint,
} from '../api.ts'
import { CHART_PALETTE, formatBytes, formatCount, formatDate, formatDuration, formatPercent } from '../format.ts'
import { STATUS } from '../components/status.tsx'
import { useQuery } from '../hooks.ts'
import { Kpi, KpiRow, Page, QueryGate, SectionHeader } from '../components/page.tsx'

const COLOR_RUNS = CHART_PALETTE[0]!
const COLOR_HITS = STATUS['cache-hit'].fill
const COLOR_FAILURES = STATUS.failed.fill
const COLOR_DURATION = CHART_PALETTE[1]!
const COLOR_PARALLELISM = CHART_PALETTE[2]!
const COLOR_STORAGE = CHART_PALETTE[3]!
const AXIS_TICK = {
  fontSize: 'var(--font-size-sm, 12px)',
  fill: 'var(--color-text-secondary, #4E606F)',
} as const
const GRID_STROKE = 'var(--color-border, rgba(5, 54, 89, 0.1))'

const formatMultiplier = (v: number): string => `${v.toFixed(1)}×`

// ---------------------------------------------------------------------------
// Chart glue (astryx dashboard-template pattern)
// ---------------------------------------------------------------------------

interface TipEntry {
  name?: string | number
  value?: string | number
  color?: string
  dataKey?: string | number
}

/** Per-series value formatters keyed by recharts `dataKey`. */
type FormatMap = Readonly<Record<string, (v: number) => string>>

function ChartTip(props: {
  active?: boolean
  payload?: readonly TipEntry[]
  label?: unknown
  formats: FormatMap
}): JSX.Element | null {
  if (props.active !== true || props.payload === undefined || props.payload.length === 0) {
    return null
  }
  return (
    <Card padding={3}>
      <VStack gap={1}>
        <Text type="supporting" color="secondary">
          {formatDate(Number(props.label))}
        </Text>
        {props.payload.map((e) => {
          const fmt = props.formats[String(e.dataKey)] ?? ((v: number) => String(v))
          return (
            <HStack key={String(e.name)} gap={2} vAlign="center">
              <Icon icon={StopIcon} size="xsm" style={{ color: e.color }} />
              <Text type="supporting">
                {String(e.name)}: {fmt(Number(e.value))}
              </Text>
            </HStack>
          )
        })}
      </VStack>
    </Card>
  )
}

function LegendItem(props: { color: string; label: string }): JSX.Element {
  return (
    <HStack gap={2} vAlign="center">
      <Icon icon={StopIcon} size="xsm" style={{ color: props.color }} />
      <Text type="supporting" color="secondary">
        {props.label}
      </Text>
    </HStack>
  )
}

interface SeriesSpec {
  dataKey: string
  name: string
  color: string
  format: (v: number) => string
}

function TrendLineChart(props: {
  rows: readonly object[]
  xKey: string
  series: readonly SeriesSpec[]
  yFormat: (v: number) => string
  yDomain?: [number, number]
  height?: number
}): JSX.Element {
  const formats: Record<string, (v: number) => string> = {}
  for (const s of props.series) formats[s.dataKey] = s.format
  return (
    <VStack gap={3}>
      <ResponsiveContainer width="100%" height={props.height ?? 260}>
        <LineChart data={[...props.rows]} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid horizontal vertical={false} stroke={GRID_STROKE} />
          <XAxis
            dataKey={props.xKey}
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v: number) => formatDate(v)}
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={props.yDomain}
            tickFormatter={(v: number) => props.yFormat(v)}
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            width={56}
          />
          <Tooltip content={<ChartTip formats={formats} />} cursor={{ stroke: GRID_STROKE }} />
          {props.series.map((s) => (
            <Line
              key={s.dataKey}
              type="linear"
              dataKey={s.dataKey}
              name={s.name}
              stroke={s.color}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <HStack gap={6} vAlign="center">
        {props.series.map((s) => (
          <LegendItem key={s.dataKey} color={s.color} label={s.name} />
        ))}
      </HStack>
    </VStack>
  )
}

// ---------------------------------------------------------------------------
// Build heatmap — 7×24 day-of-week × hour-of-day grid (hand-rolled SVG,
// token colors only; pixel values below are SVG geometry).
// ---------------------------------------------------------------------------

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const CELL = 16
const X_OFF = 34
const Y_OFF = 16

function BuildHeatmap({ cells }: { cells: readonly HeatmapCellApi[] }): JSX.Element {
  const max = Math.max(1, ...cells.map((c) => c.runs))
  const width = X_OFF + 24 * CELL + 4
  const height = Y_OFF + 7 * CELL + 4
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      role="img"
      aria-label="Runs by day of week and hour of day"
      style={{ display: 'block' }}
    >
      {[0, 4, 8, 12, 16, 20].map((h) => (
        <text
          key={h}
          x={X_OFF + h * CELL}
          y={Y_OFF - 5}
          fontSize={9}
          fontFamily="ui-monospace, monospace"
          fill="var(--color-text-secondary, #4E606F)"
        >
          {String(h).padStart(2, '0')}
        </text>
      ))}
      {DAY_LABELS.map((d, i) => (
        <text
          key={d}
          x={0}
          y={Y_OFF + i * CELL + CELL / 2 + 3}
          fontSize={9}
          fontFamily="ui-monospace, monospace"
          fill="var(--color-text-secondary, #4E606F)"
        >
          {d}
        </text>
      ))}
      {cells.map((c) => {
        const intensity = c.runs / max
        const opacity = c.runs === 0 ? 0.06 : 0.2 + 0.8 * intensity
        return (
          <rect
            key={`${c.dayOfWeek}-${c.hourOfDay}`}
            x={X_OFF + c.hourOfDay * CELL}
            y={Y_OFF + c.dayOfWeek * CELL}
            width={CELL - 2}
            height={CELL - 2}
            rx={2}
            fill="var(--color-accent, #2694FE)"
            opacity={opacity}
          >
            <title>
              {`${DAY_LABELS[c.dayOfWeek] ?? ''} ${String(c.hourOfDay).padStart(2, '0')}:00 — ${c.runs} runs · ${formatDuration(c.totalDurationMs)}`}
            </title>
          </rect>
        )
      })}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface TrendChartRow extends TrendPoint {
  hitRate: number
}

export function Trends(): JSX.Element {
  const trends = useQuery(() => getRunTrends({ bucket: 'day' }), [])
  const heatmap = useQuery(() => getHeatmap(30), [])
  const parallelism = useQuery(() => getParallelismHistory(50), [])
  const storage = useQuery(() => getStorageGrowth(30), [])

  return (
    <Page>
      <SectionHeader title="Activity" hint="runs · hits · failures per day, last 30d" />
      <QueryGate query={trends} rows={5}>
        {(t) => {
          const rows: TrendChartRow[] = t.points.map((p) => ({
            ...p,
            hitRate: p.runs > 0 ? p.hits / p.runs : 0,
          }))
          if (rows.length === 0) {
            return (
              <EmptyState
                title="No runs recorded yet"
                description="Run `vx run <task>` in a connected workspace to start the trend."
              />
            )
          }
          return (
            <VStack gap={3}>
              <Card>
                <TrendLineChart
                  rows={rows}
                  xKey="t"
                  yFormat={formatCount}
                  height={300}
                  series={[
                    { dataKey: 'runs', name: 'runs', color: COLOR_RUNS, format: formatCount },
                    { dataKey: 'hits', name: 'cache hits', color: COLOR_HITS, format: formatCount },
                    { dataKey: 'failures', name: 'failures', color: COLOR_FAILURES, format: formatCount },
                  ]}
                />
              </Card>
              <Grid columns={{ minWidth: 420 }} gap={3}>
                <Card>
                  <VStack gap={3}>
                    <Heading level={4}>Total duration per day</Heading>
                    <TrendLineChart
                      rows={rows}
                      xKey="t"
                      yFormat={formatDuration}
                      height={240}
                      series={[
                        {
                          dataKey: 'totalDurationMs',
                          name: 'total duration',
                          color: COLOR_DURATION,
                          format: formatDuration,
                        },
                      ]}
                    />
                  </VStack>
                </Card>
                <Card>
                  <VStack gap={3}>
                    <Heading level={4}>Hit rate per day</Heading>
                    <TrendLineChart
                      rows={rows}
                      xKey="t"
                      yFormat={(v) => formatPercent(v, 0)}
                      yDomain={[0, 1]}
                      height={240}
                      series={[
                        {
                          dataKey: 'hitRate',
                          name: 'hit rate',
                          color: COLOR_HITS,
                          format: (v) => formatPercent(v, 0),
                        },
                      ]}
                    />
                  </VStack>
                </Card>
              </Grid>
            </VStack>
          )
        }}
      </QueryGate>

      <SectionHeader title="When you build" hint="runs by day of week × hour of day, last 30d" />
      <QueryGate query={heatmap} rows={3}>
        {(cells) => {
          const total = cells.reduce((n, c) => n + c.runs, 0)
          if (total === 0) {
            return <EmptyState title="No runs in the last 30 days" />
          }
          return (
            <Card maxWidth={640}>
              <BuildHeatmap cells={cells} />
            </Card>
          )
        }}
      </QueryGate>

      <SectionHeader title="Parallelism" hint="cpu sum / wall time per invocation — 1.0× = serial" />
      <QueryGate query={parallelism} rows={4}>
        {(points: ParallelismPoint[]) => {
          if (points.length === 0) {
            return <EmptyState title="No executed runs yet" description="Cache-hit-only runs carry no CPU time." />
          }
          const ordered = [...points].sort((a, b) => a.startedAt - b.startedAt)
          const avg = ordered.reduce((n, p) => n + p.factor, 0) / ordered.length
          const best = Math.max(...ordered.map((p) => p.factor))
          const cpuTotal = ordered.reduce((n, p) => n + p.cpuSumMs, 0)
          return (
            <VStack gap={3}>
              <KpiRow>
                <Kpi label="Avg parallelism" value={formatMultiplier(avg)} sub="across recent runs" />
                <Kpi label="Best invocation" value={formatMultiplier(best)} />
                <Kpi label="Total CPU time" value={formatDuration(cpuTotal)} />
              </KpiRow>
              <Card>
                <TrendLineChart
                  rows={ordered}
                  xKey="startedAt"
                  yFormat={formatMultiplier}
                  height={240}
                  series={[
                    {
                      dataKey: 'factor',
                      name: 'parallelism',
                      color: COLOR_PARALLELISM,
                      format: formatMultiplier,
                    },
                  ]}
                />
              </Card>
            </VStack>
          )
        }}
      </QueryGate>

      <SectionHeader title="Cache storage growth" hint="bytes added per day, last 30d" />
      <QueryGate query={storage} rows={3}>
        {(points) => {
          if (points.length === 0) {
            return (
              <EmptyState
                title="No cache-entry data on this serve"
                description="Storage growth reads the workspace's cache.db — start vx-cloud serve inside the repo to see it."
              />
            )
          }
          return (
            <Card>
              <TrendLineChart
                rows={points}
                xKey="t"
                yFormat={formatBytes}
                height={240}
                series={[
                  { dataKey: 'bytesAdded', name: 'bytes added', color: COLOR_STORAGE, format: formatBytes },
                ]}
              />
            </Card>
          )
        }}
      </QueryGate>
    </Page>
  )
}
