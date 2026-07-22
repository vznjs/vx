// Insights → Cache: the cache pays rent, led by TIME SAVED (the product's
// value metric, Nx pattern). Visual-first: hit-rate area chart, a
// local/remote split bar, and the action queue = projects ranked by WORST
// hit rate (lowest first — that's the fix order).

import type { CSSProperties, JSX } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Item } from '@astryxdesign/core/Item'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { Token } from '@astryxdesign/core/Token'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  getCacheBreakdown,
  getCacheSavings,
  getCacheStats,
  getHistory,
  getRunTrends,
  useCapabilities,
} from '../api.ts'
import { formatBytes, formatCount, formatDuration, formatPercent } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Kpi, KpiRow, Page, QueryGate, SectionHeader } from '../components/page.tsx'

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
              sub={`${formatCount(s.hitsLast24h)} hits`}
            />
            {stats.data !== undefined && (
              <Kpi
                label="Store"
                value={formatBytes(stats.data.totalBytes)}
                sub={`${formatCount(stats.data.entryCount)} entries · ${formatPercent(stats.data.hitRate24h, 0)} hit rate (24h)`}
              />
            )}
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
        {(points) => {
          const data = points.map((p) => ({
            day: new Date(p.t).toLocaleDateString([], { month: 'short', day: 'numeric' }),
            hits: p.hits,
          }))
          return (
            <Card padding={4}>
              <VStack gap={3}>
                <Text type="label">Cache hits per day</Text>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="hitFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.45} />
                        <stop offset="100%" stopColor="#22d3ee" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid horizontal vertical={false} stroke={GRID} />
                    <XAxis dataKey="day" tick={TICK} axisLine={false} tickLine={false} minTickGap={28} />
                    <YAxis tick={TICK} axisLine={false} tickLine={false} width={38} />
                    <Tooltip
                      formatter={(v) => formatCount(Number(v))}
                      contentStyle={{
                        background: 'var(--color-background-popover)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 8,
                      }}
                    />
                    <Area type="monotone" dataKey="hits" name="hits" stroke={CYAN} strokeWidth={2} fill="url(#hitFill)" />
                  </AreaChart>
                </ResponsiveContainer>
              </VStack>
            </Card>
          )
        }}
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
                          {t.runs} runs · {formatCount(t.hits)} hits
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
