// Insights → Cache: the cache pays rent, led by TIME SAVED (the product's
// value metric, Nx pattern). Visual-first: hit-rate area chart, a
// local/remote split bar, and the action queue = projects ranked by WORST
// hit rate (lowest first — that's the fix order).

import type { CSSProperties, JSX } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Grid } from '@astryxdesign/core/Grid'
import { Item } from '@astryxdesign/core/Item'
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
import { ChartCard, DailyArea, RateLine, SERIES_2 } from '../components/viz.tsx'

const CYAN = 'var(--color-icon-cyan, #22d3ee)'
const BLUE = 'var(--color-icon-blue, #60a5fa)'
const GRID = 'var(--color-border, rgba(167,139,250,0.14))'
const TICK = { fontSize: 11, fill: 'var(--color-text-secondary)' }

/** Two-segment share bar (local vs remote hits). */
function SplitBar(props: { local: number; remote: number }): JSX.Element {
  const total = Math.max(1, props.local + props.remote)
  const seg = (n: number, color: string): CSSProperties => ({
    width: `${(n / total) * 100}%`,
    backgroundColor: color,
    height: '100%',
  })
  return (
    <VStack gap={1} style={{ width: '100%' }}>
      <span
        style={{
          display: 'flex',
          height: 10,
          borderRadius: 5,
          overflow: 'hidden',
          backgroundColor: 'var(--color-neutral)',
        }}
      >
        <span style={seg(props.local, CYAN)} />
        <span style={seg(props.remote, BLUE)} />
      </span>
      <HStack gap={3}>
        <Text type="supporting" color="secondary">
          <span style={{ color: CYAN }}>●</span> local {formatCount(props.local)}
        </Text>
        <Text type="supporting" color="secondary">
          <span style={{ color: BLUE }}>●</span> remote {formatCount(props.remote)}
        </Text>
      </HStack>
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
                <Item
                  key={t.id}
                  density="balanced"
                  href={`#/tasks/${encodeURIComponent(t.id)}`}
                  label={
                    <VStack gap={1} style={{ width: '100%' }}>
                      <HStack gap={2} vAlign="center">
                        <Text type="code">{t.id}</Text>
                        <Text type="supporting" color="secondary">
                          {plural(t.runs, 'run')} · {formatCount(t.hits)} hits
                        </Text>
                        {t.hitRate < 0.3 && <Token size="sm" color="red" label="cold" />}
                      </HStack>
                      <span
                        style={{
                          display: 'block',
                          height: 6,
                          width: `${Math.max(2, t.hitRate * 100)}%`,
                          borderRadius: 3,
                          backgroundColor: t.hitRate < 0.3 ? 'var(--color-error)' : CYAN,
                        }}
                      />
                    </VStack>
                  }
                  endContent={<Text weight="medium">{formatPercent(t.hitRate, 0)}</Text>}
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
                    <Item
                      key={p.project}
                      density="compact"
                      href={`#/projects/${encodeURIComponent(p.project)}`}
                      label={
                        <VStack gap={1} style={{ width: '100%' }}>
                          <HStack gap={2} vAlign="center">
                            <Text weight="medium">{p.project}</Text>
                            <Text type="supporting" color="secondary">
                              {formatCount(p.entries)} entries
                            </Text>
                          </HStack>
                          <span
                            style={{
                              display: 'block',
                              height: 5,
                              width: `${Math.max(2, (p.totalBytes / max) * 100)}%`,
                              borderRadius: 3,
                              backgroundColor: BLUE,
                            }}
                          />
                        </VStack>
                      }
                      endContent={<Text type="supporting">{formatBytes(p.totalBytes)}</Text>}
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
