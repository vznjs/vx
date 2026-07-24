// Tasks — every (project, task) pair from /v1/history: KPI strip (task count,
// total runs, overall hit rate) and a filterable/sortable all-tasks table
// (row → task detail). Reproduces the old tasks.json surfaces: success/hit
// rates, avg/p50/p99/total durations, flaky marker, last-seen time.

import { useMemo, useState, type JSX } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Link } from '@astryxdesign/core/Link'
import { HStack } from '@astryxdesign/core/Layout'
import { Table, pixel, proportional, useTableSortable } from '@astryxdesign/core/Table'
import type { TableColumn, TableSortState } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { Token } from '@astryxdesign/core/Token'
import { getHistory, type TaskHistoryRow } from '../api.ts'
import { formatCount, formatDuration, formatPercent } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Kpi, KpiRow, Page, PageHeader, QueryGate, SectionHeader } from '../components/page.tsx'
import { BarCell } from '../components/viz.tsx'
import { ProjectDot, ProjectName, TaskRef } from '../components/ident.tsx'

interface TaskRow extends Record<string, unknown> {
  id: string
  project: string
  runs: number
  failureRate: number
  hitRate: number
  /** −1 = unknown (renders as —). */
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
    project: t.project,
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

/** Flaky marker beside the task id — only when the task is actually flaky. */
function flakyToken(mode: TaskHistoryRow['failureMode']): JSX.Element | null {
  if (mode === 'flaky-fatal') return <Token size="sm" label="flaky · fatal" color="red" />
  if (mode === 'flaky-recoverable') return <Token size="sm" label="flaky" color="yellow" />
  return null
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

export function Tasks(): JSX.Element {
  const history = useQuery(() => getHistory({ limit: 500 }), [])
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<TableSortState<SortKey>>([
    { sortKey: 'totalDurationMs', direction: 'descending' },
  ])
  const sortable = useTableSortable<TaskRow, SortKey>({ sort, onSortChange: setSort })

  const columns = useMemo((): TableColumn<TaskRow>[] => [
    {
      key: 'id',
      header: 'Task',
      width: proportional(2),
      renderCell: (r) => (
        <HStack gap={2} vAlign="center">
          <Link href={`#/tasks/${encodeURIComponent(r.id)}`}>
            <TaskRef id={r.id} />
          </Link>
          {flakyToken(r.failureMode)}
        </HStack>
      ),
    },
    {
      key: 'project',
      header: 'Project',
      width: proportional(1),
      renderCell: (r) => (
        <Link href={`#/projects/${encodeURIComponent(r.project)}`}>
          <HStack gap={1.5} vAlign="center">
            <ProjectDot name={r.project} />
            <ProjectName name={r.project} />
          </HStack>
        </Link>
      ),
    },
    { key: 'runs', header: 'Runs', width: pixel(70), align: 'end', sortable: true },
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
      key: 'failureRate',
      header: 'Fail %',
      width: pixel(110),
      align: 'end',
      sortable: true,
      renderCell: (r) => <BarCell frac={r.failureRate} color="var(--color-error)" />,
    },
    {
      key: 'hitRate',
      header: 'Hit %',
      width: pixel(110),
      align: 'end',
      sortable: true,
      renderCell: (r) => <BarCell frac={r.hitRate} />,
    },
    {
      key: 'totalDurationMs',
      header: 'Total time',
      width: pixel(100),
      align: 'end',
      sortable: true,
      renderCell: (r) => formatDuration(r.totalDurationMs),
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
      <PageHeader title="Tasks" subtitle="Every (project, task) pair the serve has seen" />
      <QueryGate query={history} rows={2}>
        {(list) => {
          const runs = list.reduce((n, t) => n + t.runs, 0)
          const hits = list.reduce((n, t) => n + t.hits, 0)
          return (
            <KpiRow>
              <Kpi label="Tasks" value={formatCount(list.length)} />
              <Kpi label="Total runs" value={formatCount(runs)} />
              <Kpi
                label="Hit rate"
                value={formatPercent(runs > 0 ? hits / runs : 0, 0)}
                sub={`${formatCount(hits)} hits`}
              />
            </KpiRow>
          )
        }}
      </QueryGate>

      <SectionHeader
        title="All tasks"
        hint="row → detail"
        end={
          <TextInput
            label="Filter tasks"
            isLabelHidden
            size="sm"
            value={filter}
            onChange={setFilter}
            placeholder="filter by project#task…"
          />
        }
      />
      <QueryGate query={history} rows={8}>
        {(list) => {
          const needle = filter.trim().toLowerCase()
          const rows = sortRows(
            list.map(toRow).filter((r) => needle === '' || r.id.toLowerCase().includes(needle)),
            sort,
          )
          if (rows.length === 0) {
            return (
              <EmptyState
                title="No task history yet"
                description="Run `vx run <task>` in a connected workspace to record one."
              />
            )
          }
          return (
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
          )
        }}
      </QueryGate>
    </Page>
  )
}
