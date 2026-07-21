// Bottlenecks — high-leverage targets ranked by where you'd save the most
// time: the 14-day where-to-invest table (impact / duration / runs) and the
// flakiest tasks with an actionable `exec.retries` suggestion for tasks the
// server CONFIRMED flaky via within-run retries (ported from the old
// jr/functions.ts withFlakyFix / suggestedRetriesFor derivation).

import { useMemo, useState, type JSX } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Link } from '@astryxdesign/core/Link'
import { ProgressBar } from '@astryxdesign/core/ProgressBar'
import { Table, pixel, proportional, useTableSortable } from '@astryxdesign/core/Table'
import type { TableColumn, TableSortState } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { Token } from '@astryxdesign/core/Token'
import { getBottlenecks, getFlakiest, type BottleneckRow, type FlakyTask } from '../api.ts'
import { formatCount, formatDuration, formatPercent } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Kpi, KpiRow, Page, QueryGate, SectionHeader } from '../components/page.tsx'

// ---------------------------------------------------------------------------
// Flaky-fix derivation (ported from the old jr/functions.ts)
// ---------------------------------------------------------------------------

/**
 * Confirmation signals a flakiness-aware serve attaches to a flaky row
 * (within-run retry evidence). Older serves omit them — the suggestion
 * column simply stays empty there.
 */
interface FlakySignals {
  flakyConfirmed?: boolean
  withinRunRetries?: number
  maxAttempts?: number
}

/**
 * Suggested `exec.retries` for a CONFIRMED-flaky task: `max(maxAttempts ?? 2, 2)`
 * — always at least 2 so the retry survives a second bad draw. `undefined` for
 * inferred-only (not confirmed) rows — no suggestion.
 */
function suggestedRetriesFor(sig: FlakySignals): number | undefined {
  if (sig.flakyConfirmed !== true) return undefined
  const max =
    typeof sig.maxAttempts === 'number' && Number.isFinite(sig.maxAttempts) ? sig.maxAttempts : 2
  return Math.max(max, 2)
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface BottleneckTableRow extends Record<string, unknown> {
  id: string
  runsPerDay: number
  runsRecent: number
  avgDurationMs: number
  totalDurationMs: number
  weeklySavingsAt25PctCutMs: number
}

function toBottleneckRow(b: BottleneckRow): BottleneckTableRow {
  return {
    id: b.id,
    runsPerDay: b.runsPerDay,
    runsRecent: b.runsRecent,
    avgDurationMs: b.avgDurationMs,
    totalDurationMs: b.totalDurationMs,
    weeklySavingsAt25PctCutMs: b.weeklySavingsAt25PctCutMs,
  }
}

interface FlakyTableRow extends Record<string, unknown> {
  id: string
  runs: number
  failures: number
  failureRate: number
  /** p99/p50 tail ratio; NaN when unknown (sorted to the bottom). */
  tailRatio: number
  p50: number
  p99: number
  suggestedRetries: number | undefined
}

function toFlakyRow(t: FlakyTask): FlakyTableRow {
  const sig = t as FlakyTask & FlakySignals
  return {
    id: t.id,
    runs: t.runs,
    failures: t.failures,
    failureRate: t.failureRate,
    tailRatio: t.durationTailRatio ?? Number.NaN,
    p50: t.p50DurationMs ?? Number.NaN,
    p99: t.p99DurationMs ?? Number.NaN,
    suggestedRetries: suggestedRetriesFor(sig),
  }
}

function taskLinkCell(id: string): JSX.Element {
  return (
    <Link href={`#/tasks/${encodeURIComponent(id)}`}>
      <Text type="code">{id}</Text>
    </Link>
  )
}

/** Numeric sort that pushes NaN (unknown) rows to the bottom in both directions. */
function sortRows<R extends Record<string, unknown>>(
  rows: R[],
  sort: TableSortState<string>,
): R[] {
  const primary = sort[0]
  if (primary === undefined) return rows
  const dir = primary.direction === 'ascending' ? 1 : -1
  const num = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : dir * Number.NEGATIVE_INFINITY
  }
  return [...rows].sort((a, b) => dir * (num(a[primary.sortKey]) - num(b[primary.sortKey])))
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type BottleneckSortKey =
  | 'runsPerDay'
  | 'runsRecent'
  | 'avgDurationMs'
  | 'totalDurationMs'
  | 'weeklySavingsAt25PctCutMs'

type FlakySortKey = 'runs' | 'failures' | 'failureRate' | 'tailRatio'

export function Bottlenecks(): JSX.Element {
  const bottlenecks = useQuery(() => getBottlenecks(14, 15), [])
  const flakiest = useQuery(() => getFlakiest(25), [])

  const [bnSort, setBnSort] = useState<TableSortState<BottleneckSortKey>>([
    { sortKey: 'weeklySavingsAt25PctCutMs', direction: 'descending' },
  ])
  const bnSortable = useTableSortable<BottleneckTableRow, BottleneckSortKey>({
    sort: bnSort,
    onSortChange: setBnSort,
  })

  const [flakySort, setFlakySort] = useState<TableSortState<FlakySortKey>>([
    { sortKey: 'failureRate', direction: 'descending' },
  ])
  const flakySortable = useTableSortable<FlakyTableRow, FlakySortKey>({
    sort: flakySort,
    onSortChange: setFlakySort,
  })

  // Max savings across the ranked set — drives the impact bars.
  const bnMax = useMemo(
    () => Math.max(1, ...(bottlenecks.data ?? []).map((b) => b.weeklySavingsAt25PctCutMs)),
    [bottlenecks.data],
  )

  const bnColumns = useMemo((): TableColumn<BottleneckTableRow>[] => [
    {
      key: 'id',
      header: 'Task',
      width: proportional(1),
      renderCell: (r) => taskLinkCell(r.id),
    },
    {
      key: 'runsPerDay',
      header: 'Runs / day',
      width: pixel(100),
      align: 'end',
      sortable: true,
      renderCell: (r) => r.runsPerDay.toFixed(1),
    },
    {
      key: 'runsRecent',
      header: 'Runs (14d)',
      width: pixel(100),
      align: 'end',
      sortable: true,
    },
    {
      key: 'avgDurationMs',
      header: 'Avg',
      width: pixel(100),
      align: 'end',
      sortable: true,
      renderCell: (r) => formatDuration(r.avgDurationMs),
    },
    {
      key: 'totalDurationMs',
      header: 'Total burn',
      width: pixel(110),
      align: 'end',
      sortable: true,
      renderCell: (r) => formatDuration(r.totalDurationMs),
    },
    {
      key: 'weeklySavingsAt25PctCutMs',
      header: 'Weekly savings',
      width: pixel(180),
      sortable: true,
      renderCell: (r) => (
        <VStack gap={1}>
          <ProgressBar
            value={r.weeklySavingsAt25PctCutMs}
            max={bnMax}
            label={`${r.id} weekly savings`}
            isLabelHidden
            variant="success"
          />
          <Text type="supporting" style={{ color: 'var(--color-success)' }}>
            {formatDuration(r.weeklySavingsAt25PctCutMs)}
          </Text>
        </VStack>
      ),
    },
  ], [bnMax])

  const flakyColumns = useMemo((): TableColumn<FlakyTableRow>[] => [
    {
      key: 'id',
      header: 'Task',
      width: proportional(1),
      renderCell: (r) => taskLinkCell(r.id),
    },
    { key: 'runs', header: 'Runs', width: pixel(70), align: 'end', sortable: true },
    { key: 'failures', header: 'Failures', width: pixel(90), align: 'end', sortable: true },
    {
      key: 'failureRate',
      header: 'Fail %',
      width: pixel(90),
      align: 'end',
      sortable: true,
      renderCell: (r) =>
        r.failureRate > 0.1 ? (
          <Token size="sm" label={formatPercent(r.failureRate, 0)} color="red" />
        ) : (
          formatPercent(r.failureRate, 0)
        ),
    },
    {
      key: 'tailRatio',
      header: 'p99 / p50',
      width: pixel(90),
      align: 'end',
      sortable: true,
      renderCell: (r) =>
        Number.isFinite(r.tailRatio) ? (
          r.tailRatio > 3 ? (
            <Token size="sm" label={`${r.tailRatio.toFixed(1)}×`} color="yellow" />
          ) : (
            `${r.tailRatio.toFixed(1)}×`
          )
        ) : (
          '—'
        ),
    },
    {
      key: 'p50',
      header: 'p50',
      width: pixel(90),
      align: 'end',
      renderCell: (r) => (Number.isFinite(r.p50) ? formatDuration(r.p50) : '—'),
    },
    {
      key: 'p99',
      header: 'p99',
      width: pixel(90),
      align: 'end',
      renderCell: (r) => (Number.isFinite(r.p99) ? formatDuration(r.p99) : '—'),
    },
    {
      key: 'suggestedRetries',
      header: 'Suggested fix',
      width: pixel(150),
      renderCell: (r) =>
        r.suggestedRetries !== undefined ? (
          <Text type="code">{`exec.retries: ${r.suggestedRetries}`}</Text>
        ) : (
          '—'
        ),
    },
  ], [])

  return (
    <Page>
      <QueryGate query={bottlenecks} rows={2}>
        {(list) => {
          const totalBurn = list.reduce((n, b) => n + b.totalDurationMs, 0)
          const totalSavings = list.reduce((n, b) => n + b.weeklySavingsAt25PctCutMs, 0)
          return (
            <KpiRow>
              <Kpi label="Ranked tasks" value={formatCount(list.length)} sub="14-day lookback" />
              <Kpi label="Total burn (14d)" value={formatDuration(totalBurn)} />
              <Kpi
                label="Weekly savings at a 25% cut"
                value={formatDuration(totalSavings)}
                sub="across the ranked set"
                tone={totalSavings > 0 ? 'good' : 'default'}
              />
            </KpiRow>
          )
        }}
      </QueryGate>

      <SectionHeader title="Where to invest" hint="14-day lookback · savings = 25% cut, weekly" />
      <QueryGate query={bottlenecks} rows={6}>
        {(list) => {
          if (list.length === 0) {
            return (
              <EmptyState
                title="Not enough runs to rank bottlenecks"
                description="Run a few tasks and come back."
              />
            )
          }
          const rows = sortRows(list.map(toBottleneckRow), bnSort)
          return (
            <Table
              data={rows}
              columns={bnColumns}
              idKey="id"
              density="compact"
              hasHover
              plugins={{ sortable: bnSortable }}
            />
          )
        }}
      </QueryGate>

      <SectionHeader title="Flakiest tasks" hint="failure rate + duration tail ratio" />
      <QueryGate query={flakiest} rows={6}>
        {(list) => {
          if (list.length === 0) {
            return (
              <EmptyState
                title="No flaky tasks"
                description="Nothing fails unpredictably or shows a wide p99/p50 tail."
              />
            )
          }
          const rows = sortRows(list.map(toFlakyRow), flakySort)
          const confirmed = rows.filter((r) => r.suggestedRetries !== undefined).length
          return (
            <VStack gap={2}>
              <Table
                data={rows}
                columns={flakyColumns}
                idKey="id"
                density="compact"
                hasHover
                plugins={{ sortable: flakySortable }}
              />
              {confirmed > 0 && (
                <Card variant="muted" padding={3}>
                  <HStack gap={2} vAlign="center">
                    <Text type="supporting" color="secondary">
                      {confirmed} task{confirmed === 1 ? '' : 's'} confirmed flaky by within-run
                      retries — copy the suggested
                    </Text>
                    <Text type="code">exec.retries</Text>
                    <Text type="supporting" color="secondary">
                      into the task&apos;s vx.config.ts.
                    </Text>
                  </HStack>
                </Card>
              )}
            </VStack>
          )
        }}
      </QueryGate>
    </Page>
  )
}
