// Shared page scaffolding: content column, KPI tiles, and the loading/error
// gate every data-backed section renders through. Keeps pages free of ad-hoc
// spinner/error markup so all surfaces degrade identically.

import type { CSSProperties, JSX, ReactNode } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Grid } from '@astryxdesign/core/Grid'
import { HStack, Section, VStack } from '@astryxdesign/core/Layout'
import { Skeleton } from '@astryxdesign/core/Skeleton'
import { Heading, Text } from '@astryxdesign/core/Text'
import type { Query } from '../hooks.ts'

const pageStyle: CSSProperties = {
  maxWidth: 1440,
  margin: '0 auto',
  width: '100%',
}

/** Standard content column: padded, centered, vertically stacked sections. */
export function Page({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Section padding={6}>
      <div style={pageStyle}>
        <VStack gap={5}>{children}</VStack>
      </div>
    </Section>
  )
}

/** Section header above a table/chart region. */
export function SectionHeader(props: { title: string; hint?: string; end?: ReactNode }): JSX.Element {
  return (
    <HStack gap={2} vAlign="center">
      <Heading level={2}>{props.title}</Heading>
      {props.hint !== undefined && (
        <Text type="supporting" color="secondary">
          {props.hint}
        </Text>
      )}
      {props.end !== undefined && (
        <HStack gap={2} style={{ marginInlineStart: 'auto' }}>
          {props.end}
        </HStack>
      )}
    </HStack>
  )
}

export type KpiTone = 'default' | 'good' | 'bad' | 'warn'

const KPI_VALUE_COLOR: Record<KpiTone, string | undefined> = {
  default: undefined,
  good: 'var(--color-success)',
  bad: 'var(--color-error)',
  warn: 'var(--color-warning)',
}

/** One KPI tile. Compose in a `KpiRow`. */
export function Kpi(props: { label: string; value: ReactNode; sub?: ReactNode; tone?: KpiTone }): JSX.Element {
  const color = KPI_VALUE_COLOR[props.tone ?? 'default']
  return (
    <Card
      padding={4}
      style={{
        backgroundImage:
          'radial-gradient(240px 130px at 100% 0%, var(--color-accent-muted), transparent 65%)',
      }}
    >
      <VStack gap={1}>
        <Text type="supporting" color="secondary">
          {props.label}
        </Text>
        <span style={color !== undefined ? { color } : undefined}>
          <Text type="display-3" color="inherit">
            {props.value}
          </Text>
        </span>
        {props.sub !== undefined && (
          <Text type="supporting" color="secondary">
            {props.sub}
          </Text>
        )}
      </VStack>
    </Card>
  )
}

/** Responsive KPI tile row. */
export function KpiRow({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Grid columns={{ minWidth: 220 }} gap={3}>
      {children}
    </Grid>
  )
}

/**
 * Loading / error / ready gate for a query-backed region. Loading renders
 * skeleton lines sized for the region; an error renders an EmptyState with
 * the message (data already fetched stays visible on background refreshes).
 */
export function QueryGate<T>(props: {
  query: Query<T>
  /** Region height hint for the loading skeleton. */
  rows?: number
  children: (data: T) => ReactNode
}): JSX.Element {
  const { data, error, loading } = props.query
  if (data === undefined) {
    if (loading) {
      const n = props.rows ?? 4
      return (
        <VStack gap={2}>
          {Array.from({ length: n }, (_, i) => (
            <Skeleton key={i} height={n <= 2 ? 96 : 28} />
          ))}
        </VStack>
      )
    }
    return <EmptyState title="Couldn't load this section" description={error ?? 'Unknown error'} />
  }
  return <>{props.children(data)}</>
}
