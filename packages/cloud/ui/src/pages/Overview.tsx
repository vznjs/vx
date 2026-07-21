// Overview — the landing dashboard: KPI strip over recent invocations,
// run-duration + hit-rate trend charts, top time-burners, recent failures,
// and a recent-runs mini-table linking into run detail. Charts follow the
// astryx analytics-dashboard recharts pattern (token-colored strokes, Card
// tooltip, Icon+Text legend). Live overlay deliberately absent — the Run
// cockpit owns live.

import type { JSX } from 'react'
import { StopIcon } from '@heroicons/react/24/solid'
import { Card } from '@astryxdesign/core/Card'
import { Grid } from '@astryxdesign/core/Grid'
import { Icon } from '@astryxdesign/core/Icon'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Link } from '@astryxdesign/core/Link'
import { ProgressBar } from '@astryxdesign/core/ProgressBar'
import { Table, pixel, proportional } from '@astryxdesign/core/Table'
import type { TableColumn } from '@astryxdesign/core/Table'
import { Heading, Text } from '@astryxdesign/core/Text'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { Token } from '@astryxdesign/core/Token'
import { EmptyState } from '@astryxdesign/core/EmptyState'
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
  getFailures,
  getRunTrends,
  getTopTasks,
  listInvocations,
  type FailureRow,
  type InvocationDetail,
  type TopTaskRow,
  type TrendPoint,
} from '../api.ts'
import { CHART_PALETTE, formatCount, formatDate, formatDuration, formatPercent } from '../format.ts'
import { STATUS } from '../components/status.tsx'
import { useQuery } from '../hooks.ts'
import { Kpi, KpiRow, Page, QueryGate, SectionHeader } from '../components/page.tsx'

const COLOR_DURATION = CHART_PALETTE[0]!
const COLOR_HIT_RATE = STATUS['cache-hit'].fill
const AXIS_TICK = {
  fontSize: 'var(--font-size-sm, 12px)',
  fill: 'var(--color-text-secondary, #4E606F)',
} as const
const GRID_STROKE = 'var(--color-border, rgba(5, 54, 89, 0.1))'

const shortHash = (h: string): string => (h === '' ? '—' : h.slice(0, 8))

// ---------------------------------------------------------------------------
// Chart glue (astryx dashboard-template pattern)
// ---------------------------------------------------------------------------

interface TipEntry {
  name?: string | number
  value?: string | number
  color?: string
}

function ChartTip(props: {
  active?: boolean
  payload?: readonly TipEntry[]
  label?: unknown
  format: (v: number) => string
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
        {props.payload.map((e) => (
          <HStack key={String(e.name)} gap={2} vAlign="center">
            <Icon icon={StopIcon} size="xsm" style={{ color: e.color }} />
            <Text type="supporting">
              {String(e.name)}: {props.format(Number(e.value))}
            </Text>
          </HStack>
        ))}
      </VStack>
    </Card>
  )
}

interface TrendChartRow extends TrendPoint {
  hitRate: number
}

function toChartRows(points: readonly TrendPoint[]): TrendChartRow[] {
  return points.map((p) => ({ ...p, hitRate: p.runs > 0 ? p.hits / p.runs : 0 }))
}

function TrendCard(props: {
  title: string
  hint: string
  rows: TrendChartRow[]
  dataKey: 'totalDurationMs' | 'hitRate'
  name: string
  color: string
  format: (v: number) => string
  yDomain?: [number, number]
}): JSX.Element {
  if (props.rows.length === 0) {
    return (
      <Card>
        <VStack gap={3}>
          <Heading level={4}>{props.title}</Heading>
          <EmptyState title="No runs recorded yet" description="Run `vx run <task>` to start the trend." />
        </VStack>
      </Card>
    )
  }
  return (
    <Card>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center" hAlign="between">
          <Heading level={4}>{props.title}</Heading>
          <Text type="supporting" color="secondary">
            {props.hint}
          </Text>
        </HStack>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={props.rows} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid horizontal vertical={false} stroke={GRID_STROKE} />
            <XAxis
              dataKey="t"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v: number) => formatDate(v)}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              domain={props.yDomain}
              tickFormatter={(v: number) => props.format(v)}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={56}
            />
            <Tooltip
              content={<ChartTip format={props.format} />}
              cursor={{ stroke: GRID_STROKE }}
            />
            <Line
              type="linear"
              dataKey={props.dataKey}
              name={props.name}
              stroke={props.color}
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
        <HStack gap={6} vAlign="center">
          <HStack gap={2} vAlign="center">
            <Icon icon={StopIcon} size="xsm" style={{ color: props.color }} />
            <Text type="supporting" color="secondary">
              {props.name}
            </Text>
          </HStack>
        </HStack>
      </VStack>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

interface TopTaskTableRow extends Record<string, unknown> {
  id: string
  runs: number
  avgDurationMs: number
  totalDurationMs: number
}

function topTaskColumns(maxTotal: number): TableColumn<TopTaskTableRow>[] {
  return [
    {
      key: 'id',
      header: 'Task',
      width: proportional(1),
      renderCell: (r) => (
        <Link href={`#/tasks/${encodeURIComponent(r.id)}`}>
          <Text type="code">{r.id}</Text>
        </Link>
      ),
    },
    { key: 'runs', header: 'Runs', width: pixel(70), align: 'end' },
    {
      key: 'avgDurationMs',
      header: 'Avg',
      width: pixel(90),
      align: 'end',
      renderCell: (r) => formatDuration(r.avgDurationMs),
    },
    {
      key: 'totalDurationMs',
      header: 'Total burn',
      width: pixel(160),
      renderCell: (r) => (
        <VStack gap={1}>
          <ProgressBar
            value={r.totalDurationMs}
            max={maxTotal}
            label={`${r.id} total duration`}
            isLabelHidden
          />
          <Text type="supporting">{formatDuration(r.totalDurationMs)}</Text>
        </VStack>
      ),
    },
  ]
}

interface FailureTableRow extends Record<string, unknown> {
  key: string
  taskId: string
  runId: string
  exitCode: number
  durationMs: number
  startedAt: number
}

const FAILURE_COLUMNS: TableColumn<FailureTableRow>[] = [
  {
    key: 'taskId',
    header: 'Task',
    width: proportional(1),
    renderCell: (r) => (
      <Link href={`#/tasks/${encodeURIComponent(r.taskId)}`}>
        <Text type="code">{r.taskId}</Text>
      </Link>
    ),
  },
  {
    key: 'exitCode',
    header: 'Exit',
    width: pixel(80),
    renderCell: (r) => <Token size="sm" label={`exit ${r.exitCode}`} color="red" />,
  },
  {
    key: 'durationMs',
    header: 'Duration',
    width: pixel(90),
    align: 'end',
    renderCell: (r) => formatDuration(r.durationMs),
  },
  {
    key: 'startedAt',
    header: 'When',
    width: pixel(120),
    align: 'end',
    renderCell: (r) => <Timestamp value={new Date(r.startedAt).toISOString()} format="relative" />,
  },
  {
    key: 'runId',
    header: 'Run',
    width: pixel(100),
    renderCell: (r) =>
      r.runId === '' ? (
        '—'
      ) : (
        <Link href={`#/runs/${encodeURIComponent(r.runId)}`}>
          <Text type="code">{shortHash(r.runId)}</Text>
        </Link>
      ),
  },
]

function toFailureRow(f: FailureRow, i: number): FailureTableRow {
  return {
    key: `${f.runId ?? 'norun'}-${f.project}#${f.task}-${f.startedAt}-${i}`,
    taskId: `${f.project}#${f.task}`,
    runId: f.runId ?? '',
    exitCode: f.exitCode,
    durationMs: f.durationMs,
    startedAt: f.startedAt,
  }
}

interface RecentRunRow extends Record<string, unknown> {
  runId: string
  startedAt: number
  totalDurationMs: number
  taskCount: number
  failedCount: number
  hitCount: number
}

const RECENT_RUN_COLUMNS: TableColumn<RecentRunRow>[] = [
  {
    key: 'runId',
    header: 'Run',
    width: pixel(110),
    renderCell: (r) => (
      <Link href={`#/runs/${encodeURIComponent(r.runId)}`}>
        <Text type="code">{shortHash(r.runId)}</Text>
      </Link>
    ),
  },
  {
    key: 'startedAt',
    header: 'Started',
    width: proportional(1),
    renderCell: (r) => <Timestamp value={new Date(r.startedAt).toISOString()} format="relative" />,
  },
  {
    key: 'totalDurationMs',
    header: 'Duration',
    width: pixel(100),
    align: 'end',
    renderCell: (r) => formatDuration(r.totalDurationMs),
  },
  { key: 'taskCount', header: 'Tasks', width: pixel(70), align: 'end' },
  {
    key: 'failedCount',
    header: 'Failed',
    width: pixel(80),
    align: 'end',
    renderCell: (r) =>
      r.failedCount > 0 ? <Token size="sm" label={String(r.failedCount)} color="red" /> : '0',
  },
  {
    key: 'hitCount',
    header: 'Hits',
    width: pixel(70),
    align: 'end',
    renderCell: (r) => <Text style={{ color: 'var(--color-icon-cyan)' }}>{r.hitCount}</Text>,
  },
]

function toRecentRunRow(inv: InvocationDetail): RecentRunRow {
  return {
    runId: inv.runId,
    startedAt: inv.startedAt,
    totalDurationMs: inv.totalDurationMs,
    taskCount: inv.taskCount,
    failedCount: inv.failedCount,
    hitCount: inv.hitCount,
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Overview(): JSX.Element {
  const invocations = useQuery(() => listInvocations(100), [])
  const trends = useQuery(() => getRunTrends({ bucket: 'day' }), [])
  const topTasks = useQuery(() => getTopTasks(10), [])
  const failures = useQuery(() => getFailures(10), [])

  return (
    <Page>
      <QueryGate query={invocations} rows={2}>
        {(list) => {
          const tasks = list.reduce((n, r) => n + r.taskCount, 0)
          const failed = list.reduce((n, r) => n + r.failedCount, 0)
          const hits = list.reduce((n, r) => n + r.hitCount, 0)
          return (
            <KpiRow>
              <Kpi label="Recent runs" value={formatCount(list.length)} sub="latest 100 invocations" />
              <Kpi label="Tasks run" value={formatCount(tasks)} />
              <Kpi
                label="Failed"
                value={formatCount(failed)}
                tone={failed > 0 ? 'bad' : 'good'}
                sub={failed > 0 ? 'across recent runs' : 'all green'}
              />
              <Kpi
                label="Hit rate"
                value={formatPercent(tasks > 0 ? hits / tasks : 0, 0)}
                sub={`${formatCount(hits)} cache hits`}
                tone={tasks > 0 && hits / tasks >= 0.5 ? 'good' : 'default'}
              />
            </KpiRow>
          )
        }}
      </QueryGate>

      <QueryGate query={trends} rows={4}>
        {(t) => {
          const rows = toChartRows(t.points)
          return (
            <Grid columns={{ minWidth: 420 }} gap={3}>
              <TrendCard
                title="Run duration"
                hint="per day, last 30d"
                rows={rows}
                dataKey="totalDurationMs"
                name="total duration"
                color={COLOR_DURATION}
                format={formatDuration}
              />
              <TrendCard
                title="Hit rate"
                hint="hits / runs, per day"
                rows={rows}
                dataKey="hitRate"
                name="hit rate"
                color={COLOR_HIT_RATE}
                format={(v) => formatPercent(v, 0)}
                yDomain={[0, 1]}
              />
            </Grid>
          )
        }}
      </QueryGate>

      <Grid columns={{ minWidth: 460 }} gap={3}>
        <Card>
          <VStack gap={3}>
            <HStack hAlign="between" vAlign="center">
              <Heading level={4}>Top time-burners</Heading>
              <Link href="#/tasks">all tasks</Link>
            </HStack>
            <QueryGate query={topTasks} rows={4}>
              {(list) => {
                if (list.length === 0) {
                  return (
                    <EmptyState
                      title="Nothing executed yet"
                      description="Run `vx run <task>` in a connected workspace."
                    />
                  )
                }
                const rows: TopTaskTableRow[] = list.map((t: TopTaskRow) => ({
                  id: t.id,
                  runs: t.runs,
                  avgDurationMs: t.avgDurationMs,
                  totalDurationMs: t.totalDurationMs,
                }))
                const maxTotal = Math.max(1, ...rows.map((r) => r.totalDurationMs))
                return (
                  <Table
                    data={rows}
                    columns={topTaskColumns(maxTotal)}
                    idKey="id"
                    density="compact"
                    hasHover
                  />
                )
              }}
            </QueryGate>
          </VStack>
        </Card>

        <Card>
          <VStack gap={3}>
            <HStack hAlign="between" vAlign="center">
              <Heading level={4}>Recent failures</Heading>
              <Link href="#/tasks">all tasks</Link>
            </HStack>
            <QueryGate query={failures} rows={4}>
              {(list) => {
                if (list.length === 0) {
                  return <EmptyState title="No failures" description="Recent runs are all green." />
                }
                return (
                  <Table
                    data={list.map(toFailureRow)}
                    columns={FAILURE_COLUMNS}
                    idKey="key"
                    density="compact"
                    hasHover
                  />
                )
              }}
            </QueryGate>
          </VStack>
        </Card>
      </Grid>

      <SectionHeader title="Recent runs" hint="row → detail" end={<Link href="#/runs">all runs</Link>} />
      <QueryGate query={invocations} rows={6}>
        {(list) => {
          if (list.length === 0) {
            return (
              <EmptyState
                title="No invocations yet"
                description="Run `vx run <task>` in a connected workspace to record one."
              />
            )
          }
          return (
            <Table
              data={list.slice(0, 10).map(toRecentRunRow)}
              columns={RECENT_RUN_COLUMNS}
              idKey="runId"
              density="compact"
              hasHover
            />
          )
        }}
      </QueryGate>
    </Page>
  )
}
