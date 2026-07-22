// Insights → Flaky tasks: the flaky queue (Nx pattern) — ranked by
// estimated time WASTED (fail rate × avg duration × runs), because "how
// much is this costing" is the prioritization currency, not fail % alone.
// Visual-first: each row's wasted-time bar + fail-rate token.

import type { JSX } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Item } from '@astryxdesign/core/Item'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { Token } from '@astryxdesign/core/Token'
import { getFlakiest, getHistory } from '../api.ts'
import { formatCount, formatDuration, formatPercent } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Kpi, KpiRow, Page, QueryGate, SectionHeader } from '../components/page.tsx'

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

  return (
    <Page>
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
                value={totalTasks > 0 ? formatPercent((active.length / totalTasks) * 100, 1) : '—'}
                sub={`${formatCount(totalTasks)} tasks tracked`}
              />
              <Kpi label="High risk" value={String(high.length)} sub="fail rate above 20%" tone={high.length > 0 ? 'bad' : 'good'} />
            </KpiRow>
          )
        }}
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
                <Item
                  key={t.id}
                  density="balanced"
                  href={`#/tasks/${encodeURIComponent(t.id)}`}
                  startContent={
                    <Token size="sm" color={t.highRisk ? 'red' : 'orange'} label={formatPercent(t.failureRate * 100, 0)} />
                  }
                  label={
                    <VStack gap={1} style={{ width: '100%' }}>
                      <HStack gap={2} vAlign="center">
                        <Text type="code">{t.id}</Text>
                        <Text type="supporting" color="secondary">
                          {t.failures}/{t.runs} runs failed
                          {t.p50 !== undefined && t.p99 !== undefined
                            ? ` · p50 ${formatDuration(t.p50)} / p99 ${formatDuration(t.p99)}`
                            : ''}
                        </Text>
                      </HStack>
                      <span
                        style={{
                          display: 'block',
                          height: 6,
                          width: `${Math.max(2, (t.wastedMs / max) * 100)}%`,
                          borderRadius: 3,
                          backgroundColor: t.highRisk ? RED : AMBER,
                        }}
                      />
                    </VStack>
                  }
                  endContent={
                    <VStack gap={0} hAlign="end">
                      <Text weight="medium">{formatDuration(t.wastedMs)}</Text>
                      <Token size="sm" color="purple" label="exec.retries: 2" />
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
        description="Confirmed-flaky tasks (same inputs, different outcomes) usually want `exec.retries` as a stopgap and a root-cause pass on shared state, ports, or time. Tasks that only fail on one platform want a split cache key instead."
      />
    </Page>
  )
}
