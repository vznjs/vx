// Runs — every recorded `vx run` invocation: KPI strip, a filterable/sortable
// all-runs table (row → run detail), and the compare-to-previous entry table.
// The exemplar page for the astryx rewrite: dense data as edge-to-edge Table
// rows inside a Card only when the region is a widget, per `astryx docs layout`.

import { useMemo, useState, type JSX } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { Link } from '@astryxdesign/core/Link'
import { HStack } from '@astryxdesign/core/Layout'
import { Table, pixel, proportional, useTableSortable } from '@astryxdesign/core/Table'
import type { TableColumn, TableSortState } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { Token } from '@astryxdesign/core/Token'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { listInvocations, type InvocationDetail } from '../api.ts'
import { formatCount, formatDuration } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Kpi, KpiRow, Page, QueryGate, SectionHeader } from '../components/page.tsx'

interface RunRow extends Record<string, unknown> {
  runId: string
  startedAt: number
  branch: string
  commitSha: string
  ci: string
  tags: string
  totalDurationMs: number
  taskCount: number
  failedCount: number
  hitCount: number
}

function tagsText(tags: Record<string, string> | null | undefined): string {
  if (!tags) return ''
  return Object.entries(tags)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
}

function toRow(inv: InvocationDetail): RunRow {
  return {
    runId: inv.runId,
    startedAt: inv.startedAt,
    branch: inv.branch ?? '',
    commitSha: inv.commitSha ?? '',
    ci: inv.ci ? (inv.ciProvider ?? 'CI') : 'local',
    tags: tagsText(inv.tags),
    totalDurationMs: inv.totalDurationMs,
    taskCount: inv.taskCount,
    failedCount: inv.failedCount,
    hitCount: inv.hitCount,
  }
}

type SortKey = 'startedAt' | 'totalDurationMs' | 'taskCount' | 'failedCount' | 'hitCount'

function sortRows(rows: RunRow[], sort: TableSortState<SortKey>): RunRow[] {
  const primary = sort[0]
  if (primary === undefined) return rows
  const dir = primary.direction === 'ascending' ? 1 : -1
  return [...rows].sort((a, b) => dir * (Number(a[primary.sortKey]) - Number(b[primary.sortKey])))
}

const shortHash = (h: string): string => (h === '' ? '—' : h.slice(0, 8))

export function Runs(): JSX.Element {
  const invocations = useQuery(() => listInvocations(200), [])
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<TableSortState<SortKey>>([
    { sortKey: 'startedAt', direction: 'descending' },
  ])
  const sortable = useTableSortable<RunRow, SortKey>({ sort, onSortChange: setSort })

  const columns = useMemo((): TableColumn<RunRow>[] => [
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
      width: pixel(150),
      sortable: true,
      renderCell: (r) => <Timestamp value={new Date(r.startedAt).toISOString()} format="relative" />,
    },
    {
      key: 'branch',
      header: 'Branch',
      width: proportional(1),
      renderCell: (r) => (r.branch === '' ? '—' : r.branch),
    },
    {
      key: 'commitSha',
      header: 'Commit',
      width: pixel(100),
      renderCell: (r) => <Text type="code">{shortHash(r.commitSha)}</Text>,
    },
    {
      key: 'ci',
      header: 'CI',
      width: pixel(90),
      renderCell: (r) => <Token size="sm" label={r.ci} color={r.ci === 'local' ? 'gray' : 'blue'} />,
    },
    {
      key: 'tags',
      header: 'Tags',
      width: proportional(1),
      renderCell: (r) => (r.tags === '' ? '' : <Text type="supporting">{r.tags}</Text>),
    },
    {
      key: 'totalDurationMs',
      header: 'Duration',
      width: pixel(110),
      align: 'end',
      sortable: true,
      renderCell: (r) => formatDuration(r.totalDurationMs),
    },
    {
      key: 'taskCount',
      header: 'Tasks',
      width: pixel(80),
      align: 'end',
      sortable: true,
    },
    {
      key: 'failedCount',
      header: 'Failed',
      width: pixel(80),
      align: 'end',
      sortable: true,
      renderCell: (r) =>
        r.failedCount > 0 ? <Token size="sm" label={String(r.failedCount)} color="red" /> : '0',
    },
    {
      key: 'hitCount',
      header: 'Hits',
      width: pixel(80),
      align: 'end',
      sortable: true,
      renderCell: (r) => <Text style={{ color: 'var(--color-icon-cyan)' }}>{r.hitCount}</Text>,
    },
  ], [])

  return (
    <Page>
      <QueryGate query={invocations} rows={2}>
        {(list) => {
          const rows = list.map(toRow)
          const failed = rows.reduce((n, r) => n + r.failedCount, 0)
          return (
            <KpiRow>
              <Kpi label="Recent runs" value={formatCount(rows.length)} />
              <Kpi label="Tasks run" value={formatCount(rows.reduce((n, r) => n + r.taskCount, 0))} />
              <Kpi label="Failed" value={formatCount(failed)} tone={failed > 0 ? 'bad' : 'good'} />
              <Kpi label="Cache hits" value={formatCount(rows.reduce((n, r) => n + r.hitCount, 0))} />
            </KpiRow>
          )
        }}
      </QueryGate>

      <SectionHeader
        title="All runs"
        hint="row → detail"
        end={
          <TextInput
            label="Filter runs"
            isLabelHidden
            size="sm"
            value={filter}
            onChange={setFilter}
            placeholder="filter by run id, branch, CI, or tag…"
          />
        }
      />
      <QueryGate query={invocations} rows={8}>
        {(list) => {
          const needle = filter.trim().toLowerCase()
          const rows = sortRows(
            list.map(toRow).filter(
              (r) =>
                needle === '' ||
                [r.runId, r.branch, r.ci, r.tags].some((f) => f.toLowerCase().includes(needle)),
            ),
            sort,
          )
          if (rows.length === 0) {
            return (
              <EmptyState
                title="No invocations yet"
                description="Run `vx run <task>` in a connected workspace to record one."
              />
            )
          }
          return (
            <Table
              data={rows}
              columns={columns}
              idKey="runId"
              density="compact"
              hasHover
              plugins={{ sortable }}
            />
          )
        }}
      </QueryGate>

      <SectionHeader title="Compare to previous" hint="row → diff vs the run before it" />
      <QueryGate query={invocations} rows={4}>
        {(list) => {
          const rows = sortRows(list.map(toRow), [{ sortKey: 'startedAt', direction: 'descending' }]).slice(0, 25)
          if (rows.length === 0) {
            return <EmptyState title="Nothing to compare yet" description="Record at least two runs." />
          }
          return (
            <Card padding={0}>
              <Table
                data={rows}
                columns={[
                  {
                    key: 'runId',
                    header: 'Run',
                    width: pixel(110),
                    renderCell: (r) => (
                      <Link href={`#/compare/${encodeURIComponent(r.runId)}`}>
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
                    width: pixel(120),
                    align: 'end',
                    renderCell: (r) => formatDuration(r.totalDurationMs),
                  },
                  { key: 'taskCount', header: 'Tasks', width: pixel(90), align: 'end' },
                ]}
                idKey="runId"
                density="compact"
                hasHover
              />
            </Card>
          )
        }}
      </QueryGate>

      <HStack gap={2} />
    </Page>
  )
}
