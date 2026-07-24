// TaskDetail — one project#task: aggregate facts from /v1/tasks/:id (runs /
// success / hit rates, duration percentiles, CPU utilization, last run), the
// latest cache entry (the task's cache key + command + artifact facts), and
// the recent-runs table. Reproduces the old taskDetail.json surfaces; the
// cache-key section renders `latestEntry` — the only key data in the payload.

import { useMemo, type JSX } from 'react'
import { useParams } from 'react-router-dom'
import { BreadcrumbItem, Breadcrumbs } from '@astryxdesign/core/Breadcrumbs'
import { CodeBlock } from '@astryxdesign/core/CodeBlock'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList'
import { Table, pixel, proportional } from '@astryxdesign/core/Table'
import type { TableColumn } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { Token } from '@astryxdesign/core/Token'
import { getTaskDetail, type RunSummaryRow, type TaskDetail as TaskDetailPayload } from '../api.ts'
import { cpuPct, formatBytes, formatCount, formatDuration, formatPercent, plural } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Page, QueryGate, SectionHeader } from '../components/page.tsx'
import { StatusToken, toVizState } from '../components/status.tsx'
import { ProjectName, TaskName, TaskRef } from '../components/ident.tsx'
import { ChartCard, DurationHistory } from '../components/viz.tsx'

interface RecentRow extends Record<string, unknown> {
  rowKey: string
  startedAt: number
  status: string
  cacheHit: boolean | null
  durationMs: number
  cpuMs: number | null
  peakRssBytes: number | null
  hash: string
}

function toRow(r: RunSummaryRow, i: number): RecentRow {
  return {
    rowKey: `${r.startedAt}:${i}`,
    startedAt: r.startedAt,
    status: r.status,
    cacheHit: r.cacheHit,
    durationMs: r.durationMs,
    cpuMs: r.cpuMs,
    peakRssBytes: r.peakRssBytes,
    hash: r.hash,
  }
}

function failureModeToken(mode: 'stable' | 'flaky-recoverable' | 'flaky-fatal'): JSX.Element {
  if (mode === 'flaky-fatal') return <Token size="sm" label="flaky · fatal" color="red" />
  if (mode === 'flaky-recoverable') return <Token size="sm" label="flaky" color="yellow" />
  return <Token size="sm" label="stable" color="green" />
}

/** avg/max CPU utilization across executed recent runs (cache hits excluded). */
function cpuStats(recent: readonly RunSummaryRow[]): { avg: number; max: number } | null {
  const vals: number[] = []
  for (const r of recent) {
    const pct = cpuPct(r.cpuMs, r.durationMs, r.cacheHit)
    if (pct !== undefined) vals.push(pct)
  }
  if (vals.length === 0) return null
  return {
    avg: Math.round(vals.reduce((s, v) => s + v, 0) / vals.length),
    max: Math.max(...vals),
  }
}

function AggregateFacts({ detail }: { detail: TaskDetailPayload }): JSX.Element {
  const agg = detail.aggregate
  const cpu = cpuStats(detail.recent)
  return (
    <MetadataList columns="multi">
      <MetadataListItem label="Project">
        <ProjectName name={detail.project} />
      </MetadataListItem>
      <MetadataListItem label="Task">
        <TaskName name={detail.task} />
      </MetadataListItem>
      {agg !== null && (
        <>
          <MetadataListItem label="Runs">
            {`${formatCount(agg.runs)} · ${formatCount(agg.successes)} executed · ${plural(agg.hits, 'hit')} · ${plural(agg.failures, 'failure')}`}
          </MetadataListItem>
          {/* A cache hit IS a success (only green runs ever cache), so the
              honest rate is 1 − failures/runs — the server's successRate
              counts executed successes only and reads as mostly-failing for
              a well-cached task. */}
          <MetadataListItem label="Success rate">
            {formatPercent(agg.runs > 0 ? (agg.runs - agg.failures) / agg.runs : 1, 0)}
          </MetadataListItem>
          <MetadataListItem label="Stability">{failureModeToken(agg.failureMode)}</MetadataListItem>
          <MetadataListItem label="Hit rate">
            {`${formatPercent(agg.hitRate, 0)} · ${plural(agg.hits, 'hit')}`}
          </MetadataListItem>
          <MetadataListItem label="Avg duration">
            {formatDuration(agg.avgDurationMs ?? -1)}
          </MetadataListItem>
          <MetadataListItem label="p50 · p99">
            {`${formatDuration(agg.p50DurationMs ?? -1)} · ${formatDuration(agg.p99DurationMs ?? -1)}`}
          </MetadataListItem>
          <MetadataListItem label="Min · max">
            {`${formatDuration(agg.minDurationMs ?? -1)} · ${formatDuration(agg.maxDurationMs ?? -1)}`}
          </MetadataListItem>
          <MetadataListItem label="CPU (avg · max)">
            {cpu === null ? '—' : `${cpu.avg}% · ${cpu.max}%`}
          </MetadataListItem>
          <MetadataListItem label="Last run">
            {agg.lastSeenAt !== undefined && agg.lastSeenAt > 0 ? (
              <Timestamp value={new Date(agg.lastSeenAt).toISOString()} format="relative" />
            ) : (
              '—'
            )}
          </MetadataListItem>
        </>
      )}
    </MetadataList>
  )
}

export function TaskDetail(): JSX.Element {
  const params = useParams()
  const id = decodeURIComponent(params.id ?? '')
  const detail = useQuery(() => getTaskDetail(id), [id])

  const columns = useMemo((): TableColumn<RecentRow>[] => [
    {
      key: 'startedAt',
      header: 'When',
      width: pixel(140),
      renderCell: (r) => <Timestamp value={new Date(r.startedAt).toISOString()} format="relative" />,
    },
    {
      key: 'status',
      header: 'Status',
      width: pixel(130),
      renderCell: (r) => <StatusToken state={toVizState(r.status, r.cacheHit ?? undefined)} />,
    },
    {
      key: 'durationMs',
      header: 'Duration',
      width: pixel(100),
      align: 'end',
      renderCell: (r) => formatDuration(r.durationMs),
    },
    {
      key: 'cpuMs',
      header: 'CPU',
      width: pixel(90),
      align: 'end',
      renderCell: (r) => (r.cpuMs === null ? '—' : formatDuration(r.cpuMs)),
    },
    {
      key: 'cpuPct',
      header: 'CPU %',
      width: pixel(80),
      align: 'end',
      renderCell: (r) => {
        const pct = cpuPct(r.cpuMs, r.durationMs, r.cacheHit)
        if (pct === undefined) return '—'
        return <Text style={pct > 100 ? { color: 'var(--color-success)' } : undefined}>{`${pct}%`}</Text>
      },
    },
    {
      key: 'peakRssBytes',
      header: 'Peak RSS',
      width: pixel(100),
      align: 'end',
      renderCell: (r) => (r.peakRssBytes === null ? '—' : formatBytes(r.peakRssBytes)),
    },
    {
      key: 'hash',
      header: 'Hash',
      width: proportional(1),
      align: 'end',
      renderCell: (r) => <Text type="code">{r.hash === '' ? '—' : r.hash.slice(0, 10)}</Text>,
    },
  ], [])

  return (
    <Page>
      <Breadcrumbs>
        <BreadcrumbItem href="#/tasks">Tasks</BreadcrumbItem>
        <BreadcrumbItem isCurrent>
          <TaskRef id={id} />
        </BreadcrumbItem>
      </Breadcrumbs>

      <QueryGate query={detail} rows={4}>
        {(d) => {
          if (d === null) {
            return (
              <EmptyState
                title="No data for this task"
                description={`Run \`vx run ${id}\` to record it.`}
              />
            )
          }
          const rows = d.recent.map(toRow)
          const entry = d.latestEntry
          return (
            <>
              <AggregateFacts detail={d} />

              {d.recent.length >= 2 && (
                <ChartCard
                  title="Duration history"
                  hint="every recorded run, oldest → newest — dots colored by outcome"
                >
                  <DurationHistory
                    rows={d.recent.map((r) => ({
                      startedAt: r.startedAt,
                      durationMs: r.durationMs,
                      state: toVizState(r.status, r.cacheHit ?? undefined),
                    }))}
                    p50={d.aggregate?.p50DurationMs}
                  />
                </ChartCard>
              )}

              {entry !== null && (
                <>
                  <SectionHeader title="Latest cache entry" hint="the task's current cache key" />
                  <MetadataList columns="multi">
                    <MetadataListItem label="Hash">
                      <Text type="code">{entry.hash.slice(0, 16)}</Text>
                    </MetadataListItem>
                    <MetadataListItem label="Size">{formatBytes(entry.sizeBytes)}</MetadataListItem>
                    <MetadataListItem label="Duration">
                      {formatDuration(entry.durationMs)}
                    </MetadataListItem>
                    <MetadataListItem label="Created">
                      <Timestamp value={new Date(entry.createdAt).toISOString()} format="relative" />
                    </MetadataListItem>
                    <MetadataListItem label="Accessed">
                      <Timestamp value={new Date(entry.accessedAt).toISOString()} format="relative" />
                    </MetadataListItem>
                    <MetadataListItem label="Exit">{String(entry.exitCode)}</MetadataListItem>
                  </MetadataList>
                  {entry.command !== '' && (
                    <CodeBlock code={entry.command} language="bash" size="sm" width="100%" />
                  )}
                </>
              )}

              <SectionHeader title={`Recent runs (${rows.length})`} />
              {rows.length === 0 ? (
                <EmptyState title="No runs yet" description={`Run \`vx run ${id}\`.`} />
              ) : (
                <Card padding={0}>
                  <Table data={rows} columns={columns} idKey="rowKey" density="compact" hasHover />
                </Card>
              )}
            </>
          )
        }}
      </QueryGate>
    </Page>
  )
}
