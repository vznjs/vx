// Projects — per-project rollups from /v1/projects: KPI strip (project count,
// total runs, workspace-wide hit rate, time saved) and a filterable/sortable
// rollup table (row → project detail). Reproduces the old projects.json view:
// runs / failures / hit % / durations / saved / cache footprint / last run.

import { useMemo, useState, type JSX } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Link } from '@astryxdesign/core/Link'
import { Table, pixel, proportional, useTableSortable } from '@astryxdesign/core/Table'
import type { TableColumn, TableSortState } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { Token } from '@astryxdesign/core/Token'
import { listProjects, type ProjectRollup } from '../api.ts'
import { formatBytes, formatCount, formatDuration, formatPercent } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Kpi, KpiRow, Page, PageHeader, QueryGate, SectionHeader } from '../components/page.tsx'
import { BarCell } from '../components/viz.tsx'

interface ProjectRow extends Record<string, unknown> {
  project: string
  runs: number
  failures: number
  failureRate: number
  hitRate: number
  avgDurationMs: number
  totalDurationMs: number
  estimatedTimeSavedMs: number
  cacheBytes: number
  cacheEntries: number
  /** 0 = never ran (renders as —). */
  lastRunAt: number
}

function toRow(p: ProjectRollup): ProjectRow {
  return {
    project: p.project,
    runs: p.runs,
    failures: p.failures,
    failureRate: p.runs > 0 ? p.failures / p.runs : 0,
    hitRate: p.hitRate,
    avgDurationMs: p.avgDurationMs,
    totalDurationMs: p.totalDurationMs,
    estimatedTimeSavedMs: p.estimatedTimeSavedMs,
    cacheBytes: p.cacheBytes,
    cacheEntries: p.cacheEntries,
    lastRunAt: p.lastRunAt ?? 0,
  }
}

type SortKey =
  | 'project'
  | 'runs'
  | 'failures'
  | 'failureRate'
  | 'hitRate'
  | 'avgDurationMs'
  | 'totalDurationMs'
  | 'estimatedTimeSavedMs'
  | 'cacheBytes'
  | 'lastRunAt'

function sortRows(rows: ProjectRow[], sort: TableSortState<SortKey>): ProjectRow[] {
  const primary = sort[0]
  if (primary === undefined) return rows
  const dir = primary.direction === 'ascending' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = a[primary.sortKey]
    const bv = b[primary.sortKey]
    if (typeof av === 'string' && typeof bv === 'string') return dir * av.localeCompare(bv)
    return dir * (Number(av) - Number(bv))
  })
}

export function Projects(): JSX.Element {
  const projects = useQuery(() => listProjects(500), [])
  // Entry inventory exists only with a colocated cache.db — on a serve it is
  // structurally empty, so a Cache column of dashes is dropped wholesale.
  const hasCache = (projects.data ?? []).some((p) => p.cacheEntries > 0)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<TableSortState<SortKey>>([
    { sortKey: 'totalDurationMs', direction: 'descending' },
  ])
  const sortable = useTableSortable<ProjectRow, SortKey>({ sort, onSortChange: setSort })

  const columns = useMemo((): TableColumn<ProjectRow>[] => [
    {
      key: 'project',
      header: 'Project',
      width: proportional(2),
      sortable: true,
      renderCell: (r) => (
        <Link href={`#/projects/${encodeURIComponent(r.project)}`}>
          <Text type="code">{r.project}</Text>
        </Link>
      ),
    },
    { key: 'runs', header: 'Runs', width: pixel(70), align: 'end', sortable: true },
    {
      key: 'failures',
      header: 'Failures',
      width: pixel(85),
      align: 'end',
      sortable: true,
      renderCell: (r) =>
        r.failures > 0 ? <Token size="sm" label={String(r.failures)} color="red" /> : '0',
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
      key: 'avgDurationMs',
      header: 'Avg',
      width: pixel(90),
      align: 'end',
      sortable: true,
      renderCell: (r) => formatDuration(r.avgDurationMs),
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
      key: 'estimatedTimeSavedMs',
      header: 'Saved',
      width: pixel(90),
      align: 'end',
      sortable: true,
      renderCell: (r) => (
        <Text style={{ color: 'var(--color-success)' }}>
          {formatDuration(r.estimatedTimeSavedMs)}
        </Text>
      ),
    },
    ...(hasCache
      ? [
          {
            key: 'cacheBytes',
            header: 'Cache',
            width: pixel(90),
            align: 'end',
            sortable: true,
            renderCell: (r) => (r.cacheEntries > 0 ? formatBytes(r.cacheBytes) : '—'),
          } satisfies TableColumn<ProjectRow>,
        ]
      : []),
    {
      key: 'lastRunAt',
      header: 'Last run',
      width: pixel(115),
      align: 'end',
      sortable: true,
      renderCell: (r) =>
        r.lastRunAt > 0 ? (
          <Timestamp value={new Date(r.lastRunAt).toISOString()} format="relative" />
        ) : (
          '—'
        ),
    },
  ], [hasCache])

  return (
    <Page>
      <PageHeader title="Projects" subtitle="Per-project health across every recorded run" />
      <QueryGate query={projects} rows={2}>
        {(list) => {
          const rows = list.map(toRow)
          const runs = rows.reduce((n, r) => n + r.runs, 0)
          const hits = list.reduce((n, p) => n + p.hits, 0)
          return (
            <KpiRow>
              <Kpi label="Projects" value={formatCount(rows.length)} />
              <Kpi label="Total runs" value={formatCount(runs)} />
              <Kpi
                label="Hit rate"
                value={formatPercent(runs > 0 ? hits / runs : 0, 0)}
                sub={`${formatCount(hits)} hits`}
              />
              <Kpi
                label="Time saved"
                value={formatDuration(rows.reduce((n, r) => n + r.estimatedTimeSavedMs, 0))}
                tone="good"
              />
            </KpiRow>
          )
        }}
      </QueryGate>

      <SectionHeader
        title="All projects"
        hint="row → detail"
        end={
          <TextInput
            label="Filter projects"
            isLabelHidden
            size="sm"
            value={filter}
            onChange={setFilter}
            placeholder="filter…"
          />
        }
      />
      <QueryGate query={projects} rows={8}>
        {(list) => {
          const needle = filter.trim().toLowerCase()
          const rows = sortRows(
            list.map(toRow).filter((r) => needle === '' || r.project.toLowerCase().includes(needle)),
            sort,
          )
          if (rows.length === 0) {
            return (
              <EmptyState
                title="No projects discovered"
                description="Run `vx run <task>` in a connected workspace to record one."
              />
            )
          }
          return (
            <Card padding={0}>
              <Table
              data={rows}
              columns={columns}
              idKey="project"
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
