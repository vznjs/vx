// ProjectDetail — one project's rollup (KPI facts from /v1/projects) plus its
// tasks from /v1/history filtered to this project (row → task detail).
// Reproduces the old projectDetail.json surfaces: runs/time/saved/hit-rate/
// cache header metrics and the per-task table.

import { useMemo, useState, type JSX } from 'react'
import { useParams } from 'react-router-dom'
import { BreadcrumbItem, Breadcrumbs } from '@astryxdesign/core/Breadcrumbs'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Link } from '@astryxdesign/core/Link'
import { Table, pixel, proportional, useTableSortable } from '@astryxdesign/core/Table'
import type { TableColumn, TableSortState } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { Token } from '@astryxdesign/core/Token'
import { getHistory, listProjects, listRunRows, type TaskHistoryRow } from '../api.ts'
import { formatBytes, formatCount, formatDuration, formatPercent } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Kpi, KpiRow, Page, QueryGate, SectionHeader } from '../components/page.tsx'
import { ChartCard, DailyArea } from '../components/viz.tsx'

interface TaskRow extends Record<string, unknown> {
  id: string
  task: string
  runs: number
  failureRate: number
  hitRate: number
  /** −1 = unknown (renders as —, sorts last ascending). */
  avgDurationMs: number
  p50DurationMs: number
  p99DurationMs: number
  totalDurationMs: number
  failureMode: TaskHistoryRow['failureMode']
  /** 0 = never seen (renders as —). */
  lastSeenAt: number
}

function toRow(t: TaskHistoryRow): TaskRow {
  return {
    id: t.id,
    task: t.task,
    runs: t.runs,
    failureRate: t.runs > 0 ? t.failures / t.runs : 0,
    hitRate: t.hitRate,
    avgDurationMs: t.avgDurationMs ?? -1,
    p50DurationMs: t.p50DurationMs ?? -1,
    p99DurationMs: t.p99DurationMs ?? -1,
    totalDurationMs: t.totalDurationMs,
    failureMode: t.failureMode,
    lastSeenAt: t.lastSeenAt ?? 0,
  }
}

function stabilityToken(mode: TaskHistoryRow['failureMode']): JSX.Element {
  if (mode === 'flaky-fatal') return <Token size="sm" label="flaky · fatal" color="red" />
  if (mode === 'flaky-recoverable') return <Token size="sm" label="flaky" color="yellow" />
  return <Token size="sm" label="stable" color="green" />
}

type SortKey =
  | 'runs'
  | 'failureRate'
  | 'hitRate'
  | 'avgDurationMs'
  | 'p50DurationMs'
  | 'p99DurationMs'
  | 'totalDurationMs'
  | 'lastSeenAt'

function sortRows(rows: TaskRow[], sort: TableSortState<SortKey>): TaskRow[] {
  const primary = sort[0]
  if (primary === undefined) return rows
  const dir = primary.direction === 'ascending' ? 1 : -1
  return [...rows].sort((a, b) => dir * (Number(a[primary.sortKey]) - Number(b[primary.sortKey])))
}

export function ProjectDetail(): JSX.Element {
  const params = useParams()
  const name = decodeURIComponent(params.name ?? '')
  const summary = useQuery(
    () => listProjects(500).then((ps) => ps.find((p) => p.project === name) ?? null),
    [name],
  )
  const tasks = useQuery(
    () => getHistory({ limit: 500 }).then((h) => h.filter((t) => t.project === name)),
    [name],
  )
  // Daily task-time trend for this project, bucketed client-side from the
  // raw execution rows (no per-project trends endpoint needed).
  const trend = useQuery(
    () =>
      listRunRows({ project: name, limit: 2000 }).then((rows) => {
        const byDay = new Map<number, number>()
        for (const r of rows) {
          const d = new Date(r.startedAt)
          const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
          byDay.set(day, (byDay.get(day) ?? 0) + r.durationMs)
        }
        return Array.from(byDay.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([t, value]) => ({ t, value }))
      }),
    [name],
  )
  const [sort, setSort] = useState<TableSortState<SortKey>>([
    { sortKey: 'totalDurationMs', direction: 'descending' },
  ])
  const sortable = useTableSortable<TaskRow, SortKey>({ sort, onSortChange: setSort })

  const columns = useMemo((): TableColumn<TaskRow>[] => [
    {
      key: 'task',
      header: 'Task',
      width: proportional(2),
      renderCell: (r) => (
        <Link href={`#/tasks/${encodeURIComponent(r.id)}`}>
          <Text type="code">{r.task}</Text>
        </Link>
      ),
    },
    { key: 'runs', header: 'Runs', width: pixel(70), align: 'end', sortable: true },
    {
      key: 'failureRate',
      header: 'Fail %',
      width: pixel(80),
      align: 'end',
      sortable: true,
      renderCell: (r) => (
        <Text style={r.failureRate > 0.1 ? { color: 'var(--color-error)' } : undefined}>
          {formatPercent(r.failureRate, 0)}
        </Text>
      ),
    },
    {
      key: 'hitRate',
      header: 'Hit %',
      width: pixel(80),
      align: 'end',
      sortable: true,
      renderCell: (r) => (
        <Text style={{ color: 'var(--color-icon-cyan)' }}>{formatPercent(r.hitRate, 0)}</Text>
      ),
    },
    {
      key: 'avgDurationMs',
      header: 'Avg',
      width: pixel(85),
      align: 'end',
      sortable: true,
      renderCell: (r) => formatDuration(r.avgDurationMs),
    },
    {
      key: 'p50DurationMs',
      header: 'p50',
      width: pixel(85),
      align: 'end',
      sortable: true,
      renderCell: (r) => formatDuration(r.p50DurationMs),
    },
    {
      key: 'p99DurationMs',
      header: 'p99',
      width: pixel(85),
      align: 'end',
      sortable: true,
      renderCell: (r) => formatDuration(r.p99DurationMs),
    },
    {
      key: 'totalDurationMs',
      header: 'Total',
      width: pixel(95),
      align: 'end',
      sortable: true,
      renderCell: (r) => formatDuration(r.totalDurationMs),
    },
    {
      key: 'failureMode',
      header: 'Stability',
      width: pixel(110),
      renderCell: (r) => stabilityToken(r.failureMode),
    },
    {
      key: 'lastSeenAt',
      header: 'Last',
      width: pixel(110),
      align: 'end',
      sortable: true,
      renderCell: (r) =>
        r.lastSeenAt > 0 ? (
          <Timestamp value={new Date(r.lastSeenAt).toISOString()} format="relative" />
        ) : (
          '—'
        ),
    },
  ], [])

  return (
    <Page>
      <Breadcrumbs>
        <BreadcrumbItem href="#/projects">Projects</BreadcrumbItem>
        <BreadcrumbItem isCurrent>{name}</BreadcrumbItem>
      </Breadcrumbs>

      <QueryGate query={summary} rows={2}>
        {(s) => {
          if (s === null) {
            return <EmptyState title="No data for this project" description={`No recorded runs for ${name}.`} />
          }
          return (
            <KpiRow>
              <Kpi
                label="Total runs"
                value={formatCount(s.runs)}
                sub={`${formatCount(s.taskCount)} tasks`}
              />
              <Kpi
                label="Total time"
                value={formatDuration(s.totalDurationMs)}
                sub={`avg ${formatDuration(s.avgDurationMs)}`}
              />
              <Kpi
                label="Time saved"
                value={formatDuration(s.estimatedTimeSavedMs)}
                sub={`${formatCount(s.hits)} hits`}
                tone="good"
              />
              <Kpi
                label="Hit rate"
                value={formatPercent(s.hitRate, 0)}
                tone={s.hitRate > 0.5 ? 'good' : 'default'}
              />
              {/* Entries live in a colocated cache.db only — a serve's ingest
                  store has none, so hide the tile rather than show "0 B". */}
              {s.cacheEntries > 0 && (
                <Kpi
                  label="Cache"
                  value={formatBytes(s.cacheBytes)}
                  sub={`${formatCount(s.cacheEntries)} entries`}
                />
              )}
            </KpiRow>
          )
        }}
      </QueryGate>

      <QueryGate query={tasks} rows={8}>
        {(list) => {
          const rows = sortRows(list.map(toRow), sort)
          return (
            <>
              {(trend.data?.length ?? 0) >= 2 && (
                <ChartCard title="Task time per day" hint="this project only">
                  <DailyArea
                    points={trend.data ?? []}
                    name="task time"
                    format={(v) => formatDuration(v)}
                    height={180}
                  />
                </ChartCard>
              )}

              <SectionHeader title={`Tasks (${rows.length})`} hint="row → task detail" />
              {rows.length === 0 ? (
                <EmptyState title="No tasks recorded" description={`Run \`vx run <task>\` in ${name}.`} />
              ) : (
                <Card padding={0}>
                  <Table
                    data={rows}
                    columns={columns}
                    idKey="id"
                    density="compact"
                    hasHover
                    plugins={{ sortable }}
                  />
                </Card>
              )}
            </>
          )
        }}
      </QueryGate>
    </Page>
  )
}
