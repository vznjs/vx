// Compare — one run vs its immediately-previous invocation (/v1/compare):
// header delta cards (this/previous totals, signed delta, tasks changed) and
// the per-task diff table (status A→B, signed duration delta, cache-key
// changed marker). Reproduces the old compare.json surfaces; A = this run,
// B = previous.

import { useMemo, useState, type JSX } from 'react'
import { useParams } from 'react-router-dom'
import { BreadcrumbItem, Breadcrumbs } from '@astryxdesign/core/Breadcrumbs'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Link } from '@astryxdesign/core/Link'
import { Table, pixel, proportional } from '@astryxdesign/core/Table'
import type { TableColumn } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Token } from '@astryxdesign/core/Token'
import { compareRuns, type CompareTaskRow } from '../api.ts'
import { formatCount, formatDuration, formatSignedDuration } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Kpi, KpiRow, Page, QueryGate, SectionHeader } from '../components/page.tsx'
import { ChartCard, DeltaBars } from '../components/viz.tsx'
import { TaskRef } from '../components/ident.tsx'
import { StatusToken, toVizState } from '../components/status.tsx'

type DeltaKind = 'slower' | 'faster' | 'same' | 'new' | 'gone'

interface DiffRow extends Record<string, unknown> {
  taskId: string
  aStatus: string | null
  aCacheHit: boolean | null
  aDurationMs: number | null
  bStatus: string | null
  bCacheHit: boolean | null
  bDurationMs: number | null
  deltaKind: DeltaKind
  deltaLabel: string
  hashChanged: boolean
}

function toRow(t: CompareTaskRow): DiffRow {
  let deltaKind: DeltaKind
  let deltaLabel: string
  if (t.a === null) {
    deltaKind = 'gone'
    deltaLabel = 'only in prev'
  } else if (t.b === null) {
    deltaKind = 'new'
    deltaLabel = 'new'
  } else if (t.durationDeltaMs === null || t.durationDeltaMs === 0) {
    deltaKind = 'same'
    deltaLabel = '±0'
  } else {
    deltaKind = t.durationDeltaMs > 0 ? 'slower' : 'faster'
    deltaLabel = formatSignedDuration(t.durationDeltaMs)
  }
  return {
    taskId: t.taskId,
    aStatus: t.a?.status ?? null,
    aCacheHit: t.a?.cacheHit ?? null,
    aDurationMs: t.a?.durationMs ?? null,
    bStatus: t.b?.status ?? null,
    bCacheHit: t.b?.cacheHit ?? null,
    bDurationMs: t.b?.durationMs ?? null,
    deltaKind,
    deltaLabel,
    hashChanged: t.hashChanged,
  }
}

function statusCell(status: string | null, cacheHit: boolean | null): JSX.Element | string {
  if (status === null) return '—'
  return <StatusToken state={toVizState(status, cacheHit ?? undefined)} />
}

const DELTA_COLOR: Record<DeltaKind, string | undefined> = {
  slower: 'var(--color-error)',
  faster: 'var(--color-success)',
  same: undefined,
  new: undefined,
  gone: undefined,
}

function deltaCell(r: DiffRow): JSX.Element | string {
  if (r.deltaKind === 'new') return <Token size="sm" label="new" color="blue" />
  if (r.deltaKind === 'gone') return <Token size="sm" label="only in prev" color="gray" />
  const color = DELTA_COLOR[r.deltaKind]
  return <Text style={color !== undefined ? { color } : undefined}>{r.deltaLabel}</Text>
}

const shortId = (id: string): string => id.slice(0, 8)

export function Compare(): JSX.Element {
  const params = useParams()
  const id = decodeURIComponent(params.id ?? '')
  const cmp = useQuery(() => compareRuns(id), [id])
  const [filter, setFilter] = useState('')

  const columns = useMemo((): TableColumn<DiffRow>[] => [
    {
      key: 'taskId',
      header: 'Task',
      width: proportional(2),
      renderCell: (r) => (
        <Link href={`#/tasks/${encodeURIComponent(r.taskId)}`}>
          <TaskRef id={r.taskId} />
        </Link>
      ),
    },
    {
      key: 'aStatus',
      header: 'A status',
      width: pixel(130),
      renderCell: (r) => statusCell(r.aStatus, r.aCacheHit),
    },
    {
      key: 'aDurationMs',
      header: 'A dur',
      width: pixel(90),
      align: 'end',
      renderCell: (r) => (r.aDurationMs === null ? '—' : formatDuration(r.aDurationMs)),
    },
    {
      key: 'bStatus',
      header: 'B status',
      width: pixel(130),
      renderCell: (r) => statusCell(r.bStatus, r.bCacheHit),
    },
    {
      key: 'bDurationMs',
      header: 'B dur',
      width: pixel(90),
      align: 'end',
      renderCell: (r) => (r.bDurationMs === null ? '—' : formatDuration(r.bDurationMs)),
    },
    {
      key: 'delta',
      header: 'Δ duration',
      width: pixel(110),
      align: 'end',
      renderCell: deltaCell,
    },
    {
      key: 'hashChanged',
      header: 'Key',
      width: pixel(110),
      renderCell: (r) =>
        r.hashChanged ? (
          <Token size="sm" label="changed" color="orange" />
        ) : (
          <Text type="supporting" color="secondary">
            same
          </Text>
        ),
    },
  ], [])

  return (
    <Page>
      <Breadcrumbs>
        <BreadcrumbItem href="#/runs">Runs</BreadcrumbItem>
        <BreadcrumbItem href={`#/runs/${encodeURIComponent(id)}`}>{shortId(id)}</BreadcrumbItem>
        <BreadcrumbItem isCurrent>Compare</BreadcrumbItem>
      </Breadcrumbs>

      <QueryGate query={cmp} rows={2}>
        {(c) => {
          if (!c.found) {
            return (
              <EmptyState
                title="No previous run to compare against"
                description={c.note !== '' ? c.note : 'This is the earliest recorded invocation of these tasks.'}
              />
            )
          }
          return (
            <KpiRow>
              <Kpi label="This run" value={formatDuration(c.summary.aTotalMs)} sub="total task time" />
              <Kpi
                label="Previous run"
                value={formatDuration(c.summary.bTotalMs)}
                sub={c.previousRunId !== null ? shortId(c.previousRunId) : 'total task time'}
              />
              <Kpi
                label="Delta"
                value={formatSignedDuration(c.summary.totalDeltaMs)}
                tone={c.summary.totalDeltaMs > 0 ? 'bad' : c.summary.totalDeltaMs < 0 ? 'good' : 'default'}
                sub="this − previous · negative = faster"
              />
              <Kpi
                label="Tasks changed"
                value={formatCount(c.summary.tasksChanged)}
                sub={`${formatCount(c.summary.tasksOnlyInA)} only here · ${formatCount(c.summary.tasksOnlyInB)} only prev`}
              />
            </KpiRow>
          )
        }}
      </QueryGate>

      <QueryGate query={cmp} rows={3}>
        {(c) => {
          const deltas = c.tasks
            .filter((t) => t.durationDeltaMs !== null && t.durationDeltaMs !== 0)
            .map((t) => ({ id: t.taskId, deltaMs: t.durationDeltaMs ?? 0 }))
            .sort((x, y) => Math.abs(y.deltaMs) - Math.abs(x.deltaMs))
            .slice(0, 12)
          return deltas.length > 0 ? (
            <ChartCard
              title="Duration deltas"
              hint="this run vs the previous — largest movers first"
            >
              <DeltaBars entries={deltas} />
            </ChartCard>
          ) : (
            <></>
          )
        }}
      </QueryGate>

      <SectionHeader
        title="Task diff"
        hint="A = this run · B = previous"
        end={
          <TextInput
            label="Filter tasks"
            isLabelHidden
            size="sm"
            value={filter}
            onChange={setFilter}
            placeholder="filter tasks…"
          />
        }
      />
      <QueryGate query={cmp} rows={8}>
        {(c) => {
          const needle = filter.trim().toLowerCase()
          const rows = c.tasks
            .map(toRow)
            .filter(
              (r) =>
                needle === '' ||
                r.taskId.toLowerCase().includes(needle) ||
                r.deltaKind.includes(needle),
            )
          if (rows.length === 0) {
            return <EmptyState title="No tasks to compare" />
          }
          return (
            <Card padding={0}>
              <Table data={rows} columns={columns} idKey="taskId" density="compact" hasHover />
            </Card>
          )
        }}
      </QueryGate>
    </Page>
  )
}
