// Insights → Speed: "make CI faster" as an action queue (Nx pattern).
// Visual-first: duration area chart, parallelism line, and the bottleneck
// queue as ranked bars — the burn IS the bar, not a number in a grid.

import type { JSX } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { Item } from '@astryxdesign/core/Item'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { Token } from '@astryxdesign/core/Token'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  getBottlenecks,
  getHeatmap,
  getParallelismHistory,
  getRunTrends,
} from '../api.ts'
import { formatDuration, plural } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Kpi, KpiRow, Page, PageHeader, QueryGate, SectionHeader } from '../components/page.tsx'
import { TaskRef } from '../components/ident.tsx'
import { WeekHeatmap, ChartCard as VizChartCard } from '../components/viz.tsx'

const VIOLET = 'var(--color-icon-purple, #a78bfa)'
const CYAN = 'var(--color-icon-cyan, #22d3ee)'
const GRID = 'var(--color-border, rgba(167,139,250,0.14))'
const TICK = { fontSize: 11, fill: 'var(--color-text-secondary)' }

function ChartCard(props: { title: string; hint?: string; children: JSX.Element }): JSX.Element {
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
        </HStack>
        {props.children}
      </VStack>
    </Card>
  )
}

export function InsightsSpeed(): JSX.Element {
  const trends = useQuery(() => getRunTrends({ bucket: 'day' }).then((r) => r.points), [])
  const parallelism = useQuery(() => getParallelismHistory(50), [])
  const bottlenecks = useQuery(() => getBottlenecks(14, 15), [])
  const heatmap = useQuery(() => getHeatmap(30), [])

  return (
    <Page>
      <PageHeader title="Speed" subtitle="Find and fix what burns your CI time" />
      <QueryGate query={bottlenecks} rows={2}>
        {(rows) => {
          const burn = rows.reduce((n, b) => n + b.totalDurationMs, 0)
          const savable = rows.reduce((n, b) => n + b.weeklySavingsAt25PctCutMs, 0)
          return (
            <KpiRow>
              <Kpi label="Task time burned (14d)" value={formatDuration(burn)} sub="across top offenders" />
              <Kpi
                label="Weekly savings at −25%"
                value={formatDuration(savable)}
                sub="if the queue below got 25% faster"
                tone="good"
              />
              <Kpi label="Offenders tracked" value={String(rows.length)} sub="ranked by total burn" />
            </KpiRow>
          )
        }}
      </QueryGate>

      <SectionHeader title="Where the time goes" hint="fix top-down — each bar is total burn, 14d" />
      <QueryGate query={bottlenecks} rows={6}>
        {(rows) => {
          const max = Math.max(1, ...rows.map((b) => b.totalDurationMs))
          return (
            <Card padding={0}>
              {rows.map((b, i) => (
                <Item
                  key={b.id}
                  density="balanced"
                  href={`#/tasks/${encodeURIComponent(b.id)}`}
                  startContent={
                    <Text type="supporting" color="secondary" style={{ minWidth: 20 }}>
                      {i + 1}
                    </Text>
                  }
                  label={
                    <VStack gap={1} style={{ width: '100%' }}>
                      <HStack gap={2} vAlign="center">
                        <TaskRef id={b.id} />
                        <Text type="supporting" color="secondary">
                          {plural(b.runsRecent, 'run')} · avg {formatDuration(b.avgDurationMs)} · {b.runsPerDay.toFixed(1)}/day
                        </Text>
                      </HStack>
                      <span
                        style={{
                          display: 'block',
                          height: 6,
                          width: `${(b.totalDurationMs / max) * 100}%`,
                          minWidth: 8,
                          borderRadius: 3,
                          background: `linear-gradient(90deg, ${VIOLET}, ${CYAN})`,
                        }}
                      />
                    </VStack>
                  }
                  endContent={<Text weight="medium">{formatDuration(b.totalDurationMs)}</Text>}
                />
              ))}
            </Card>
          )
        }}
      </QueryGate>

      <QueryGate query={trends} rows={4}>
        {(raw) => {
          const points = raw.map((t) => ({ ...t, day: new Date(t.t).toLocaleDateString([], { month: 'short', day: 'numeric' }) }))
          return (
          <ChartCard title="Run duration" hint="total wall time per day">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="speedFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#a78bfa" stopOpacity={0.02} />
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
                  tickFormatter={(v: number) => formatDuration(v)}
                />
                <Tooltip
                  formatter={(v) => formatDuration(Number(v))}
                  contentStyle={{
                    background: 'var(--color-background-popover)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 8,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="totalDurationMs"
                  name="wall time"
                  stroke={VIOLET}
                  strokeWidth={2}
                  fill="url(#speedFill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
          )
        }}
      </QueryGate>

      <QueryGate query={parallelism} rows={4}>
        {(points) => {
          const data = [...points].reverse()
          if (data.length === 0) return <></>
          const avg = data.reduce((n, p) => n + p.factor, 0) / data.length
          return (
            <ChartCard title="Parallelism" hint={`avg ×${avg.toFixed(1)} — higher = better use of your workers`}>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid horizontal vertical={false} stroke={GRID} />
                  <XAxis dataKey="runId" hide />
                  <YAxis
                    tick={TICK}
                    axisLine={false}
                    tickLine={false}
                    width={44}
                    domain={[0, 'dataMax']}
                    tickFormatter={(v: number) => `×${v.toFixed(1)}`}
                  />
                  <Tooltip
                    formatter={(v) => `×${Number(v).toFixed(2)}`}
                    contentStyle={{
                      background: 'var(--color-background-popover)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 8,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="factor"
                    name="factor"
                    stroke={CYAN}
                    strokeWidth={2}
                    dot={data.length <= 3}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          )
        }}
      </QueryGate>

      <QueryGate query={heatmap} rows={3}>
        {(cells) =>
          cells.some((c) => c.runs > 0) ? (
            <VizChartCard title="When CI burns time" hint="last 30 days, day-of-week × hour">
              <WeekHeatmap
                cells={cells.map((c) => ({
                  dow: c.dayOfWeek,
                  hour: c.hourOfDay,
                  runs: c.runs,
                  totalDurationMs: c.totalDurationMs,
                }))}
              />
            </VizChartCard>
          ) : (
            <></>
          )
        }
      </QueryGate>

      <HStack gap={2}>
        <Token label="tip" color="purple" size="sm" />
        <Text type="supporting" color="secondary">
          A flat parallelism line near ×1 with a deep bottleneck queue usually means a serial dependency chain —
          check the run graph of a slow run.
        </Text>
      </HStack>
    </Page>
  )
}
