// Insights → Flaky tasks: the flaky queue (Nx pattern) — ranked by
// estimated time WASTED (fail rate × avg duration × runs), because "how
// much is this costing" is the prioritization currency, not fail % alone.
// Visual-first: each row's wasted-time bar + fail-rate token.

import type { JSX } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { Token } from '@astryxdesign/core/Token'
import { getFlakiest, getHistory, getRunTrends } from '../api.ts'
import { formatCount, formatDuration, formatPercent } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Kpi, KpiRow, Page, PageHeader, QueryGate, SectionHeader } from '../components/page.tsx'
import { TaskRef } from '../components/ident.tsx'
import { ChartCard, DailyArea, RankedRow } from '../components/viz.tsx'

const AMBER = 'var(--color-warning, #fbbf24)'
const RED = 'var(--color-error, #fb7185)'

interface Ranked {
  id: string
  failureRate: number
  runs: number
  failures: number
  p50: number | undefined
  p99: number | undefined
  wastedMs: number
  highRisk: boolean
}

export function InsightsFlaky(): JSX.Element {
  const flaky = useQuery(() => getFlakiest(25), [])
  const history = useQuery(() => getHistory({ limit: 500 }), [])
  const trends = useQuery(() => getRunTrends({ bucket: 'day' }).then((r) => r.points), [])

  return (
    <Page>
      <PageHeader title="Flaky tasks" subtitle="Same inputs, different outcomes — ranked by what they cost" />
      <QueryGate query={flaky} rows={2}>
        {(rows) => {
          const active = rows.filter((t) => t.failures > 1 && t.failureRate > 0.02)
          const high = active.filter((t) => t.failureRate > 0.2)
          const totalTasks = history.data?.length ?? 0
          return (
            <KpiRow>
              <Kpi label="Flaky tasks" value={String(active.length)} tone={active.length > 0 ? 'warn' : 'good'} />
              <Kpi
                label="Share of all tasks"
                value={totalTasks > 0 ? formatPercent(active.length / totalTasks, 1) : '—'}
                sub={`${formatCount(totalTasks)} tasks tracked`}
              />
              <Kpi label="High risk" value={String(high.length)} sub="fail rate above 20%" tone={high.length > 0 ? 'bad' : 'good'} />
            </KpiRow>
          )
        }}
      </QueryGate>

      <QueryGate query={trends} rows={3}>
        {(points) =>
          points.some((p) => p.failures > 0) ? (
            <ChartCard title="Failures per day" hint="every failed task, workspace-wide">
              <DailyArea
                points={points.map((p) => ({ t: p.t, value: p.failures }))}
                name="failures"
                color={RED}
                height={160}
              />
            </ChartCard>
          ) : (
            <></>
          )
        }
      </QueryGate>

      <SectionHeader title="The queue" hint="ranked by estimated time wasted" />
      <QueryGate query={flaky} rows={6}>
        {(rows) => {
          const ranked: Ranked[] = rows
            .filter((t) => t.failures > 1 && t.failureRate > 0.02)
            .map((t) => {
              const avg = t.p50DurationMs ?? 0
              return {
                id: t.id,
                failureRate: t.failureRate,
                runs: t.runs,
                failures: t.failures,
                p50: t.p50DurationMs,
                p99: t.p99DurationMs,
                wastedMs: t.failureRate * avg * t.runs,
                highRisk: t.failureRate > 0.2,
              }
            })
            .sort((a, b) => b.wastedMs - a.wastedMs)
          if (ranked.length === 0) {
            return (
              <EmptyState
                title="No flaky tasks"
                description="Nothing has produced different outcomes for the same cache key recently."
              />
            )
          }
          const max = Math.max(1, ...ranked.map((r) => r.wastedMs))
          return (
            <Card padding={0}>
              {ranked.map((t) => (
                <RankedRow
                  key={t.id}
                  href={`#/tasks/${encodeURIComponent(t.id)}`}
                  label={<TaskRef id={t.id} />}
                  sub={`${t.failures}/${t.runs} runs failed${
                    t.p50 !== undefined && t.p99 !== undefined
                      ? ` · p50 ${formatDuration(t.p50)} / p99 ${formatDuration(t.p99)}`
                      : ''
                  }`}
                  extra={
                    <Token
                      size="sm"
                      color={t.highRisk ? 'red' : 'orange'}
                      label={formatPercent(t.failureRate, 0)}
                    />
                  }
                  frac={t.wastedMs / max}
                  color={t.highRisk ? RED : AMBER}
                  end={
                    <VStack gap={0} hAlign="end">
                      <Text weight="medium">{formatDuration(t.wastedMs)}</Text>
                      <Text type="supporting" size="2xs" color="secondary">
                        wasted
                      </Text>
                    </VStack>
                  }
                />
              ))}
            </Card>
          )
        }}
      </QueryGate>

      <Banner
        status="info"
        title="How to fix flakiness"
        description="Confirmed-flaky tasks (same inputs, different outcomes) are almost always shared state, port collisions, or time dependence — fix at the root. A task that only fails on one platform wants the platform folded into its cache inputs (cache.inputs.runtime with a probe command) so each platform keys separately."
      />
    </Page>
  )
}
