// Insights → Speed: "make CI faster" as an action queue (Nx pattern).
// Visual-first: duration area chart, parallelism line, the day×hour burn
// heatmap, and the bottleneck queue as ranked bars — the burn IS the bar.
// Everything renders through the shared viz/page library (ChartCard,
// DailyArea, RankedRow, MeterBar geometry) so nothing here drifts.

import type { JSX } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { HStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { Token } from '@astryxdesign/core/Token'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { getBottlenecks, getHeatmap, getParallelismHistory, getRunTrends } from '../api.ts'
import { formatDuration, plural } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Kpi, KpiRow, Page, PageHeader, QueryGate, SectionHeader } from '../components/page.tsx'
import { TaskRef } from '../components/ident.tsx'
import {
  ChartCard,
  DailyArea,
  GRID_STROKE,
  RankedRow,
  SERIES_1,
  SERIES_2,
  TICK,
  TOOLTIP_STYLE,
  WeekHeatmap,
} from '../components/viz.tsx'

const BURN_GRADIENT = `linear-gradient(90deg, ${SERIES_1}, ${SERIES_2})`

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
                <RankedRow
                  key={b.id}
                  rank={i + 1}
                  href={`#/tasks/${encodeURIComponent(b.id)}`}
                  label={<TaskRef id={b.id} />}
                  sub={`${plural(b.runsRecent, 'run')} · avg ${formatDuration(b.avgDurationMs)} · ${b.runsPerDay.toFixed(1)}/day`}
                  frac={b.totalDurationMs / max}
                  color={BURN_GRADIENT}
                  end={<Text weight="medium">{formatDuration(b.totalDurationMs)}</Text>}
                />
              ))}
            </Card>
          )
        }}
      </QueryGate>

      <QueryGate query={trends} rows={4}>
        {(points) => (
          <ChartCard title="Run duration" hint="total wall time per day">
            <DailyArea
              points={points.map((p) => ({ t: p.t, value: p.totalDurationMs }))}
              name="wall time"
              color={SERIES_1}
              format={(v) => formatDuration(v)}
              height={220}
            />
          </ChartCard>
        )}
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
                  <CartesianGrid horizontal vertical={false} stroke={GRID_STROKE} />
                  <XAxis dataKey="runId" hide />
                  <YAxis
                    tick={TICK}
                    axisLine={false}
                    tickLine={false}
                    width={44}
                    domain={[0, 'dataMax']}
                    tickFormatter={(v: number) => `×${v.toFixed(1)}`}
                  />
                  <Tooltip formatter={(v) => `×${Number(v).toFixed(2)}`} contentStyle={TOOLTIP_STYLE} />
                  <Line
                    type="monotone"
                    dataKey="factor"
                    name="factor"
                    stroke={SERIES_2}
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
            <ChartCard title="When CI burns time" hint="last 30 days, day-of-week × hour">
              <WeekHeatmap
                cells={cells.map((c) => ({
                  dow: c.dayOfWeek,
                  hour: c.hourOfDay,
                  runs: c.runs,
                  totalDurationMs: c.totalDurationMs,
                }))}
              />
            </ChartCard>
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
