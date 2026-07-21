// Cache — footprint + effectiveness: stats/savings KPIs, the local-vs-remote
// hit split, per-project storage breakdown, the full entries inventory with
// heat (cold = written but never re-hit, stale = not hit in 14d), and the
// prunable list. Entry-backed sections degrade to an honest "not available on
// this serve" when the connected serve has no cache-entry data (vx-cloud
// serve is ingest-only unless colocated with the workspace's cache.db).

import { useMemo, useState, type JSX } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Link } from '@astryxdesign/core/Link'
import { ProgressBar } from '@astryxdesign/core/ProgressBar'
import { Table, pixel, proportional, useTableSortable } from '@astryxdesign/core/Table'
import type { TableColumn, TableSortState } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { Token } from '@astryxdesign/core/Token'
import {
  getCacheBreakdown,
  getCacheSavings,
  getCacheStats,
  getPrunable,
  listCacheEntries,
  useCapabilities,
  type CacheEntryRow,
  type CacheProjectRow,
  type PrunableEntry,
} from '../api.ts'
import { formatBytes, formatCount, formatDuration, formatPercent } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Kpi, KpiRow, Page, QueryGate, SectionHeader } from '../components/page.tsx'

// ---------------------------------------------------------------------------
// Entry heat (ported from the old jr/functions.ts). The cache bumps
// accessed_at on every restore, so an entry whose accessed time barely moved
// past its created time was written but NEVER re-hit — a cold cache key. An
// entry that HAS been re-hit but not in a long while is stale.
// ---------------------------------------------------------------------------

type Heat = 'cold' | 'stale' | 'warm'

const COLD_TOLERANCE_MS = 2000 // accessed within ~2s of created ⇒ never re-hit
const STALE_MS = 14 * 24 * 60 * 60 * 1000

function entryHeat(createdAt: number, accessedAt: number, now: number): Heat {
  if (!Number.isFinite(accessedAt) || !Number.isFinite(createdAt)) return 'warm'
  if (accessedAt - createdAt <= COLD_TOLERANCE_MS) return 'cold'
  if (now - accessedAt >= STALE_MS) return 'stale'
  return 'warm'
}

const HEAT_TOKEN: Record<Heat, 'green' | 'yellow' | 'red'> = {
  warm: 'green',
  stale: 'yellow',
  cold: 'red',
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface EntryTableRow extends Record<string, unknown> {
  hash: string
  taskId: string
  heat: Heat
  sizeBytes: number
  durationMs: number
  createdAt: number
  accessedAt: number
}

function toEntryRow(e: CacheEntryRow, now: number): EntryTableRow {
  return {
    hash: e.hash,
    taskId: `${e.project}#${e.task}`,
    heat: entryHeat(e.createdAt, e.accessedAt, now),
    sizeBytes: e.sizeBytes,
    durationMs: e.durationMs,
    createdAt: e.createdAt,
    accessedAt: e.accessedAt,
  }
}

interface BreakdownTableRow extends Record<string, unknown> {
  project: string
  entries: number
  totalBytes: number
}

interface PrunableTableRow extends Record<string, unknown> {
  hash: string
  taskId: string
  sizeBytes: number
  ageDays: number
  accessedAt: number
}

function toPrunableRow(e: PrunableEntry): PrunableTableRow {
  return {
    hash: e.hash,
    taskId: `${e.project}#${e.task}`,
    sizeBytes: e.sizeBytes,
    ageDays: e.ageDays,
    accessedAt: e.accessedAt,
  }
}

const taskLinkCell = (id: string): JSX.Element => (
  <Link href={`#/tasks/${encodeURIComponent(id)}`}>
    <Text type="code">{id}</Text>
  </Link>
)

type EntrySortKey = 'sizeBytes' | 'durationMs' | 'createdAt' | 'accessedAt'

function sortEntryRows(rows: EntryTableRow[], sort: TableSortState<EntrySortKey>): EntryTableRow[] {
  const primary = sort[0]
  if (primary === undefined) return rows
  const dir = primary.direction === 'ascending' ? 1 : -1
  return [...rows].sort((a, b) => dir * (Number(a[primary.sortKey]) - Number(b[primary.sortKey])))
}

const ENTRY_COLUMNS_STATIC: TableColumn<EntryTableRow>[] = [
  {
    key: 'heat',
    header: 'Heat',
    width: pixel(80),
    renderCell: (r) => <Token size="sm" label={r.heat} color={HEAT_TOKEN[r.heat]} />,
  },
  {
    key: 'taskId',
    header: 'Task',
    width: proportional(1),
    renderCell: (r) => taskLinkCell(r.taskId),
  },
  {
    key: 'hash',
    header: 'Hash',
    width: pixel(130),
    renderCell: (r) => <Text type="code">{r.hash.slice(0, 12)}</Text>,
  },
  {
    key: 'sizeBytes',
    header: 'Size',
    width: pixel(90),
    align: 'end',
    sortable: true,
    renderCell: (r) => formatBytes(r.sizeBytes),
  },
  {
    key: 'durationMs',
    header: 'Duration',
    width: pixel(100),
    align: 'end',
    sortable: true,
    renderCell: (r) => formatDuration(r.durationMs),
  },
  {
    key: 'createdAt',
    header: 'Age',
    width: pixel(120),
    align: 'end',
    sortable: true,
    renderCell: (r) => <Timestamp value={new Date(r.createdAt).toISOString()} format="relative" />,
  },
  {
    key: 'accessedAt',
    header: 'Last hit',
    width: pixel(120),
    align: 'end',
    sortable: true,
    renderCell: (r) => <Timestamp value={new Date(r.accessedAt).toISOString()} format="relative" />,
  },
]

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function NotOnThisServe({ what }: { what: string }): JSX.Element {
  return (
    <EmptyState
      title="Not available on this serve"
      description={`${what} lives in the workspace's local cache.db — start vx-cloud serve inside the repo to see it. This serve holds pushed run analytics only.`}
    />
  )
}

export function Cache(): JSX.Element {
  const caps = useCapabilities()
  const entryDataMissing = caps.known && !caps.hasCacheDb

  const overview = useQuery(async () => {
    const [stats, savings] = await Promise.all([getCacheStats(), getCacheSavings()])
    return { stats, savings }
  }, [])
  const breakdown = useQuery(() => getCacheBreakdown(20), [])
  const entries = useQuery(() => listCacheEntries({ limit: 200, orderBy: 'size_bytes' }), [])
  const prunable = useQuery(() => getPrunable(), [])

  const [filter, setFilter] = useState('')
  const [entrySort, setEntrySort] = useState<TableSortState<EntrySortKey>>([
    { sortKey: 'sizeBytes', direction: 'descending' },
  ])
  const entrySortable = useTableSortable<EntryTableRow, EntrySortKey>({
    sort: entrySort,
    onSortChange: setEntrySort,
  })

  const breakdownColumns = useMemo((): TableColumn<BreakdownTableRow>[] => {
    const maxBytes = Math.max(1, ...(breakdown.data ?? []).map((p) => p.totalBytes))
    return [
      {
        key: 'project',
        header: 'Project',
        width: proportional(1),
        renderCell: (r) => <Text type="code">{r.project}</Text>,
      },
      { key: 'entries', header: 'Entries', width: pixel(90), align: 'end' },
      {
        key: 'totalBytes',
        header: 'Size',
        width: pixel(100),
        align: 'end',
        renderCell: (r) => formatBytes(r.totalBytes),
      },
      {
        key: 'share',
        header: 'Share',
        width: pixel(180),
        renderCell: (r) => (
          <ProgressBar
            value={r.totalBytes}
            max={maxBytes}
            label={`${r.project} share of cache storage`}
            isLabelHidden
          />
        ),
      },
    ]
  }, [breakdown.data])

  return (
    <Page>
      {entryDataMissing && (
        <Card variant="muted" padding={3}>
          <Text type="supporting" color="secondary">
            Cache-entry inventory (entries, heat, storage) lives in the workspace&apos;s local
            cache.db — start vx-cloud serve inside the repo to see it. This serve shows pushed run
            analytics only, so the hit metrics below are real.
          </Text>
        </Card>
      )}

      <QueryGate query={overview} rows={2}>
        {({ stats, savings }) => (
          <KpiRow>
            {!entryDataMissing && (
              <Kpi label="Entries" value={formatCount(stats.entryCount)} />
            )}
            {!entryDataMissing && (
              <Kpi label="Total size" value={formatBytes(stats.totalBytes)} />
            )}
            <Kpi
              label="Hit rate (24h)"
              value={formatPercent(stats.hitRate24h, 0)}
              sub={`${formatCount(stats.hitCountLast24h)} hits · ${formatCount(stats.runCountLast24h)} runs`}
            />
            <Kpi
              label="Local hits (24h)"
              value={formatCount(stats.hitLocalCountLast24h)}
              sub="restored from disk"
              tone="good"
            />
            <Kpi
              label="Remote hits (24h)"
              value={formatCount(stats.hitRemoteCountLast24h)}
              sub="pulled from remote"
            />
            <Kpi
              label="Time saved"
              value={formatDuration(savings.estimatedTimeSavedTotalMs)}
              sub={`all-time · ${formatDuration(savings.estimatedTimeSavedMs)} last 24h`}
              tone={savings.estimatedTimeSavedTotalMs > 0 ? 'good' : 'default'}
            />
          </KpiRow>
        )}
      </QueryGate>

      <SectionHeader title="Hit source" hint="local vs remote, last 24h" />
      <QueryGate query={overview} rows={2}>
        {({ stats }) => {
          const local = stats.hitLocalCountLast24h
          const remote = stats.hitRemoteCountLast24h
          const total = local + remote
          if (total === 0) {
            return <EmptyState title="No cache hits in the last 24h" />
          }
          return (
            <Card maxWidth={560}>
              <VStack gap={3}>
                {(
                  [
                    { source: 'Local', count: local, color: 'cyan' },
                    { source: 'Remote', count: remote, color: 'blue' },
                  ] as const
                ).map((row) => (
                  <HStack key={row.source} gap={3} vAlign="center">
                    <Token size="sm" label={row.source} color={row.color} />
                    <VStack gap={1} width="100%">
                      <ProgressBar
                        value={row.count}
                        max={total}
                        label={`${row.source} hit share`}
                        isLabelHidden
                      />
                    </VStack>
                    <Text type="supporting" hasTabularNumbers>
                      {formatCount(row.count)} · {formatPercent(row.count / total, 0)}
                    </Text>
                  </HStack>
                ))}
              </VStack>
            </Card>
          )
        }}
      </QueryGate>

      <SectionHeader title="Storage by project" />
      {entryDataMissing ? (
        <NotOnThisServe what="Per-project storage" />
      ) : (
        <QueryGate query={breakdown} rows={4}>
          {(list: CacheProjectRow[]) => {
            if (list.length === 0) {
              return <EmptyState title="No cache entries yet" description="Cache a task with `vx run <task>`." />
            }
            const rows: BreakdownTableRow[] = list.map((p) => ({
              project: p.project,
              entries: p.entries,
              totalBytes: p.totalBytes,
            }))
            return (
              <Table
                data={rows}
                columns={breakdownColumns}
                idKey="project"
                density="compact"
                hasHover
              />
            )
          }}
        </QueryGate>
      )}

      <SectionHeader
        title="Entries"
        hint="largest 200 · cold = never re-hit · stale = no hit in 14d"
        end={
          <TextInput
            label="Filter entries"
            isLabelHidden
            size="sm"
            value={filter}
            onChange={setFilter}
            placeholder="filter by task, hash, or cold/stale/warm…"
          />
        }
      />
      {entryDataMissing ? (
        <NotOnThisServe what="The cache-entry inventory" />
      ) : (
        <QueryGate query={entries} rows={8}>
          {(list) => {
            const now = Date.now()
            const all = list.map((e) => toEntryRow(e, now))
            const cold = all.filter((r) => r.heat === 'cold')
            const coldBytes = cold.reduce((n, r) => n + r.sizeBytes, 0)
            const needle = filter.trim().toLowerCase()
            const rows = sortEntryRows(
              all.filter(
                (r) =>
                  needle === '' ||
                  [r.taskId, r.hash, r.heat].some((f) => f.toLowerCase().includes(needle)),
              ),
              entrySort,
            )
            return (
              <VStack gap={3}>
                <KpiRow>
                  <Kpi
                    label="Cold entries"
                    value={formatCount(cold.length)}
                    sub="written, never re-hit"
                    tone={cold.length > 0 ? 'warn' : 'good'}
                  />
                  <Kpi
                    label="Reclaimable"
                    value={formatBytes(coldBytes)}
                    sub="size of cold entries"
                    tone={coldBytes > 0 ? 'warn' : 'good'}
                  />
                </KpiRow>
                {rows.length === 0 ? (
                  <EmptyState
                    title={all.length === 0 ? 'No cache entries yet' : 'No matching entries'}
                    description={
                      all.length === 0 ? 'Cache a task with `vx run <task>`.' : 'Loosen the filter.'
                    }
                  />
                ) : (
                  <Table
                    data={rows}
                    columns={ENTRY_COLUMNS_STATIC}
                    idKey="hash"
                    density="compact"
                    hasHover
                    plugins={{ sortable: entrySortable }}
                  />
                )}
                <Text type="supporting" color="secondary">
                  Cold = written but never restored since creation (accessed ≈ created). These cache
                  keys never paid off — review inputs or prune with `vx cache prune`.
                </Text>
              </VStack>
            )
          }}
        </QueryGate>
      )}

      <SectionHeader title="Prunable entries" hint="unused for 7+ days" />
      {entryDataMissing ? (
        <NotOnThisServe what="The prunable-entry list" />
      ) : (
        <QueryGate query={prunable} rows={4}>
          {(list) => {
            if (list.length === 0) {
              return <EmptyState title="Everything's been accessed recently" />
            }
            const totalBytes = list.reduce((n, e) => n + e.sizeBytes, 0)
            return (
              <VStack gap={2}>
                <Table
                  data={list.map(toPrunableRow)}
                  columns={[
                    {
                      key: 'taskId',
                      header: 'Task',
                      width: proportional(1),
                      renderCell: (r) => taskLinkCell(r.taskId),
                    },
                    {
                      key: 'hash',
                      header: 'Hash',
                      width: pixel(130),
                      renderCell: (r) => <Text type="code">{r.hash.slice(0, 12)}</Text>,
                    },
                    {
                      key: 'sizeBytes',
                      header: 'Size',
                      width: pixel(90),
                      align: 'end',
                      renderCell: (r) => formatBytes(r.sizeBytes),
                    },
                    {
                      key: 'ageDays',
                      header: 'Age',
                      width: pixel(80),
                      align: 'end',
                      renderCell: (r) => `${Math.round(r.ageDays)}d`,
                    },
                    {
                      key: 'accessedAt',
                      header: 'Last hit',
                      width: pixel(120),
                      align: 'end',
                      renderCell: (r) => (
                        <Timestamp value={new Date(r.accessedAt).toISOString()} format="relative" />
                      ),
                    },
                  ] satisfies TableColumn<PrunableTableRow>[]}
                  idKey="hash"
                  density="compact"
                  hasHover
                />
                <HStack gap={2} vAlign="center">
                  <Text type="supporting" color="secondary">
                    Reclaim {formatBytes(totalBytes)} with
                  </Text>
                  <Text type="code">vx cache prune --older-than 7d</Text>
                </HStack>
              </VStack>
            )
          }}
        </QueryGate>
      )}
    </Page>
  )
}
