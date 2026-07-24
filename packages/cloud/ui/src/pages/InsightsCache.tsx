// Insights → Cache: the cache pays rent, led by TIME SAVED (the product's
// value metric, Nx pattern). Visual-first: hit-rate area chart, a
// local/remote split bar, and the action queue = projects ranked by WORST
// hit rate (lowest first — that's the fix order).

import type { JSX } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Grid } from '@astryxdesign/core/Grid'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { Token } from '@astryxdesign/core/Token'
import {
  getCacheBreakdown,
  getCacheSavings,
  getCacheStats,
  getHistory,
  getRunTrends,
  useCapabilities,
} from '../api.ts'
import { formatBytes, formatCount, formatDuration, formatPercent, plural } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Kpi, KpiRow, Page, PageHeader, QueryGate, SectionHeader } from '../components/page.tsx'
import { ProjectName, TaskRef } from '../components/ident.tsx'
import { ChartCard, DailyArea, LegendRow, MeterBar, RankedRow, RateLine, SERIES_2 } from '../components/viz.tsx'
import { STATUS } from '../components/status.tsx'

const LOCAL_FILL = STATUS['cache-hit'].fill
const REMOTE_FILL = STATUS['cache-hit-remote'].fill

/** Two-segment share bar (local vs remote hits) on the shared meter. */
function SplitBar(props: { local: number; remote: number }): JSX.Element {
  const total = Math.max(1, props.local + props.remote)
  return (
    <VStack gap={1} style={{ width: '100%' }}>
      <MeterBar
        segments={[
          { frac: props.local / total, color: LOCAL_FILL },
          { frac: props.remote / total, color: REMOTE_FILL },
        ]}
      />
      <LegendRow
        items={[
          { color: LOCAL_FILL, label: `local ${formatCount(props.local)}` },
          { color: REMOTE_FILL, label: `remote ${formatCount(props.remote)}` },
        ]}
      />
    </VStack>
  )
}

export function InsightsCache(): JSX.Element {
  const caps = useCapabilities()
  const savings = useQuery(() => getCacheSavings(), [])
  const stats = useQuery(() => getCacheStats(), [])
  const trends = useQuery(() => getRunTrends({ bucket: 'day' }).then((r) => r.points), [])
  const breakdown = useQuery(() => getCacheBreakdown(100), [])
  const history = useQuery(() => getHistory({ limit: 500 }), [])

  return (
    <Page>
      <PageHeader title="Cache" subtitle="What the cache pays back, and where it misses" />
      <QueryGate query={savings} rows={2}>
        {(s) => (
          <KpiRow>
            <Kpi
              label="Time saved by the cache"
              value={formatDuration(s.estimatedTimeSavedTotalMs)}
              sub="all time, re-used instead of re-run"
              tone="good"
            />
            <Kpi
              label="Last 24h"
              value={formatDuration(s.estimatedTimeSavedMs)}
              sub={
                stats.data !== undefined
                  ? `${formatCount(s.hitsLast24h)} hits · ${formatPercent(stats.data.hitRate24h, 0)} hit rate`
                  : `${formatCount(s.hitsLast24h)} hits`
              }
            />
            {/* The serve's REAL byte footprint is the /v8 artifact store; the
                ingest DB's entries table is structurally empty on a serve, so
                a "0 B store" tile would be noise dressed as data. Show the
                artifact store when it holds anything, a colocated entries
                store when THAT holds anything, and nothing otherwise. */}
            {stats.data !== undefined && (stats.data.artifactCount ?? 0) > 0 ? (
              <Kpi
                label="Artifact store"
                value={formatBytes(stats.data.artifactBytes ?? 0)}
                sub={`${plural(stats.data.artifactCount ?? 0, 'artifact')} shared via remote cache`}
              />
            ) : stats.data !== undefined && stats.data.entryCount > 0 ? (
              <Kpi
                label="Store"
                value={formatBytes(stats.data.totalBytes)}
                sub={`${formatCount(stats.data.entryCount)} entries`}
              />
            ) : null}
          </KpiRow>
        )}
      </QueryGate>

      <QueryGate query={stats} rows={1}>
        {(st) => (
          <Card padding={4}>
            <VStack gap={2}>
              <Text type="label">Where hits come from (24h)</Text>
              <SplitBar local={st.hitLocalCountLast24h} remote={st.hitRemoteCountLast24h} />
            </VStack>
          </Card>
        )}
      </QueryGate>

      <QueryGate query={trends} rows={4}>
        {(points) => (
          <Grid columns={{ minWidth: 380 }} gap={3}>
            <ChartCard title="Cache hits per day">
              <DailyArea
                points={points.map((p) => ({ t: p.t, value: p.hits }))}
                name="hits"
                color={SERIES_2}
                height={180}
              />
            </ChartCard>
            <ChartCard title="Hit rate per day" hint="hits ÷ tasks — gaps are quiet days">
              <RateLine
                points={points.map((p) => ({
                  t: p.t,
                  value: p.runs > 0 ? p.hits / p.runs : null,
                }))}
                name="hit rate"
                height={180}
              />
            </ChartCard>
          </Grid>
        )}
      </QueryGate>

      <SectionHeader title="Worst hit rates first" hint="the fix order — declare tighter inputs or split keys" />
      <QueryGate query={history} rows={6}>
        {(rows) => {
          const sorted = rows
            .filter((t) => t.runs > 4 && t.hitRate < 0.95)
            .sort((a, b) => a.hitRate - b.hitRate)
            .slice(0, 12)
          if (sorted.length === 0) {
            return <EmptyState title="Nothing to fix" description="Every busy task is hitting its cache." />
          }
          return (
            <Card padding={0}>
              {sorted.map((t) => (
                <RankedRow
                  key={t.id}
                  href={`#/tasks/${encodeURIComponent(t.id)}`}
                  label={<TaskRef id={t.id} />}
                  sub={`${plural(t.runs, 'run')} · ${formatCount(t.hits)} hits`}
                  extra={t.hitRate < 0.3 ? <Token size="sm" color="red" label="cold" /> : undefined}
                  frac={t.hitRate}
                  color={t.hitRate < 0.3 ? 'var(--color-error)' : LOCAL_FILL}
                  end={<Text weight="medium">{formatPercent(t.hitRate, 0)}</Text>}
                />
              ))}
            </Card>
          )
        }}
      </QueryGate>

      {caps.hasCacheDb && (
        <>
          <SectionHeader title="Store footprint" hint="largest projects on disk" />
          <QueryGate query={breakdown} rows={3}>
            {(rows) => {
              const sorted = [...rows].sort((a, b) => b.totalBytes - a.totalBytes).slice(0, 8)
              const max = Math.max(1, ...sorted.map((p) => p.totalBytes))
              return sorted.length === 0 ? (
                <EmptyState title="No entries yet" description="Warm the cache with a few runs." />
              ) : (
                <Card padding={0}>
                  {sorted.map((p) => (
                    <RankedRow
                      key={p.project}
                      href={`#/projects/${encodeURIComponent(p.project)}`}
                      label={<ProjectName name={p.project} />}
                      sub={`${formatCount(p.entries)} entries`}
                      frac={p.totalBytes / max}
                      color={REMOTE_FILL}
                      end={<Text type="supporting">{formatBytes(p.totalBytes)}</Text>}
                    />
                  ))}
                </Card>
              )
            }}
          </QueryGate>
        </>
      )}

    </Page>
  )
}
