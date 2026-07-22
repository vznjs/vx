// Activity — the home feed. One row per `vx run` invocation (the Nx-CIPE
// grouping unit), grouped by day, Vercel row anatomy (status + environment
// leading, branch/commit center, time right-aligned), with a per-row
// cache-mix micro-bar (visual-first: the hit/miss/fail composition IS the
// row's chart). Click → resizable inspector panel (Linear peek pattern);
// full detail is one more click.

import { useMemo, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Item } from '@astryxdesign/core/Item'
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutHeader,
  LayoutPanel,
  VStack,
} from '@astryxdesign/core/Layout'
import { ResizeHandle, useResizable } from '@astryxdesign/core/Resizable'
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Heading, Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { Token } from '@astryxdesign/core/Token'
import { Skeleton } from '@astryxdesign/core/Skeleton'
import {
  getRun,
  listInvocations,
  useCapabilities,
  type InvocationDetail,
  type RunDetail as RunDetailPayload,
} from '../api.ts'
import { formatDuration } from '../format.ts'
import { usePolledQuery, useQuery } from '../hooks.ts'
import { toVizState, StatusToken } from '../components/status.tsx'

type StatusFilter = 'all' | 'failed' | 'passed'

const failed = (r: InvocationDetail): boolean => r.failedCount > 0 || r.exitOk === false

/** Day bucket for feed grouping. */
function bucketOf(startedAt: number, now: number): string {
  const d = new Date(startedAt)
  const today = new Date(now)
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.floor((startOfDay(today) - startOfDay(d)) / 86_400_000)
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return 'This week'
  return 'Earlier'
}

const BUCKET_ORDER = ['Today', 'Yesterday', 'This week', 'Earlier']

/**
 * The row's chart: a segmented micro-bar of the run's task composition —
 * cyan hits · violet executed · red failed. Zero-count segments collapse.
 */
function MixBar({ r }: { r: InvocationDetail }): JSX.Element {
  const executed = Math.max(0, r.taskCount - r.hitCount - r.failedCount)
  const total = Math.max(1, r.taskCount)
  const seg = (n: number, color: string): CSSProperties => ({
    width: `${(n / total) * 100}%`,
    backgroundColor: color,
    height: '100%',
  })
  return (
    <span
      title={`${r.hitCount} cached · ${executed} executed · ${r.failedCount} failed`}
      style={{
        display: 'inline-flex',
        width: 64,
        height: 6,
        borderRadius: 'var(--radius-inner, 3px)',
        overflow: 'hidden',
        backgroundColor: 'var(--color-neutral)',
      }}
    >
      <span style={seg(r.hitCount, 'var(--color-icon-cyan)')} />
      <span style={seg(executed, 'var(--color-icon-purple)')} />
      <span style={seg(r.failedCount, 'var(--color-error)')} />
    </span>
  )
}

function RunRow(props: {
  r: InvocationDetail
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const r = props.r
  const isFail = failed(r)
  return (
    <Item
      density="compact"
      onClick={props.onSelect}
      style={props.selected ? { backgroundColor: 'var(--color-overlay-pressed)' } : undefined}
      startContent={
        <HStack gap={2} vAlign="center">
          <StatusDot variant={isFail ? 'error' : 'success'} label={isFail ? 'failed' : 'passed'} />
          <Token size="sm" label={r.ci ? (r.ciProvider ?? 'CI') : 'local'} color={r.ci ? 'blue' : 'gray'} />
        </HStack>
      }
      label={
        <HStack gap={2} vAlign="center">
          <Text weight="medium">{r.branch ?? 'no branch'}</Text>
          <Text type="code" color="secondary">
            {(r.commitSha ?? '').slice(0, 8) || '—'}
          </Text>
          <Text type="supporting" color="secondary">
            {r.requestedTasks.join(' ') || r.command}
          </Text>
        </HStack>
      }
      description={
        isFail ? (
          <HStack gap={2}>
            <Token size="sm" color="red" label={`${r.failedCount} failed`} />
            {r.dirty === true && <Token size="sm" color="yellow" label="dirty tree" />}
          </HStack>
        ) : undefined
      }
      endContent={
        <HStack gap={3} vAlign="center">
          <MixBar r={r} />
          <Text type="supporting" color="secondary" justify="end" style={{ minWidth: 56 }}>
            {formatDuration(r.totalDurationMs)}
          </Text>
          <Text type="supporting" color="secondary" style={{ minWidth: 72, textAlign: 'end' }}>
            <Timestamp value={new Date(r.startedAt).toISOString()} format="relative" />
          </Text>
        </HStack>
      }
    />
  )
}

/** Inspector: the selected run's peek panel (never navigate to read a summary). */
function Inspector(props: { runId: string; inv: InvocationDetail }): JSX.Element {
  const detail = useQuery<RunDetailPayload | null>(() => getRun(props.runId), [props.runId])
  const inv = props.inv
  const failedTasks = (detail.data?.tasks ?? []).filter((t) => t.status === 'failed')
  return (
    <VStack gap={4} style={{ padding: 'var(--spacing-4)' }}>
      <HStack gap={2} vAlign="center">
        <StatusDot
          variant={failed(inv) ? 'error' : 'success'}
          label={failed(inv) ? 'failed' : 'passed'}
        />
        <Heading level={3}>{inv.runId.slice(0, 8)}</Heading>
        <Text type="supporting" color="secondary">
          <Timestamp value={new Date(inv.startedAt).toISOString()} format="relative" />
        </Text>
      </HStack>
      <HStack gap={2}>
        <Button size="sm" variant="primary" label="Open full detail" href={`#/runs/${encodeURIComponent(inv.runId)}`} />
        <Button size="sm" label="Compare to previous" href={`#/compare/${encodeURIComponent(inv.runId)}`} />
      </HStack>
      <MetadataList columns="single">
        <MetadataListItem label="Command">{inv.command}</MetadataListItem>
        <MetadataListItem label="Branch">{inv.branch ?? '—'}</MetadataListItem>
        <MetadataListItem label="Commit">{(inv.commitSha ?? '').slice(0, 10) || '—'}</MetadataListItem>
        <MetadataListItem label="Environment">{inv.ci ? (inv.ciProvider ?? 'CI') : 'local'}</MetadataListItem>
        <MetadataListItem label="Workers">{String(inv.concurrency)}</MetadataListItem>
        <MetadataListItem label="Cache">{inv.cachePolicy}</MetadataListItem>
        <MetadataListItem label="Tasks">{`${inv.taskCount} · ${inv.hitCount} cached · ${inv.failedCount} failed`}</MetadataListItem>
        <MetadataListItem label="Duration">{formatDuration(inv.totalDurationMs)}</MetadataListItem>
      </MetadataList>
      {failedTasks.length > 0 && (
        <VStack gap={1}>
          <Text type="label">Failed tasks</Text>
          {failedTasks.map((t) => {
            const id = `${t.project}#${t.task}`
            return (
              <Item
                key={id}
                density="compact"
                href={`#/tasks/${encodeURIComponent(id)}`}
                startContent={<StatusToken state={toVizState(t.status, t.cacheHit ?? undefined)} />}
                label={<Text type="code">{id}</Text>}
                endContent={
                  <Text type="supporting" color="secondary">
                    exit {t.exitCode}
                  </Text>
                }
              />
            )
          })}
        </VStack>
      )}
      {detail.loading && <Skeleton height={60} />}
    </VStack>
  )
}

export function Activity(): JSX.Element {
  const caps = useCapabilities()
  const invocations = usePolledQuery(() => listInvocations(200), 30_000, [])
  const [status, setStatus] = useState<StatusFilter>('all')
  const [needle, setNeedle] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const panel = useResizable({
    defaultSize: 380,
    minSizePx: 320,
    maxSizePx: 520,
    autoSaveId: 'vx-activity-inspector',
  })

  const rows = invocations.data ?? []
  const filtered = useMemo(() => {
    const n = needle.trim().toLowerCase()
    return rows.filter((r) => {
      if (status === 'failed' && !failed(r)) return false
      if (status === 'passed' && failed(r)) return false
      if (n === '') return true
      const hay = [r.runId, r.branch ?? '', r.commitSha ?? '', r.command, ...r.requestedTasks]
        .join(' ')
        .toLowerCase()
      return hay.includes(n)
    })
  }, [rows, status, needle])

  const now = Date.now()
  const groups = useMemo(() => {
    const m = new Map<string, InvocationDetail[]>()
    for (const r of filtered) {
      const b = bucketOf(r.startedAt, now)
      const list = m.get(b) ?? []
      list.push(r)
      m.set(b, list)
    }
    return BUCKET_ORDER.filter((b) => m.has(b)).map((b) => [b, m.get(b)!] as const)
  }, [filtered, now])

  const selectedInv = filtered.find((r) => r.runId === selected) ?? null

  let body: ReactNode
  if (invocations.data === undefined && invocations.loading) {
    body = (
      <VStack gap={2} style={{ padding: 'var(--spacing-4)' }}>
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} height={40} />
        ))}
      </VStack>
    )
  } else if (rows.length === 0) {
    body = (
      <EmptyState
        title="No runs yet"
        description="Run `vx run <task>` against this serve and it will appear here instantly."
      />
    )
  } else if (filtered.length === 0) {
    body = <EmptyState title="Nothing matches" description="Loosen the filter or status segment." />
  } else {
    body = (
      <VStack gap={2} style={{ padding: 'var(--spacing-2) var(--spacing-3)' }}>
        {groups.map(([bucket, list]) => (
          <Collapsible
            key={bucket}
            trigger={
              <HStack gap={2} vAlign="center">
                <Text type="label">{bucket}</Text>
                <Badge label={String(list.length)} />
              </HStack>
            }
          >
            <VStack gap={0}>
              {list.map((r) => (
                <RunRow
                  key={r.runId}
                  r={r}
                  selected={selected === r.runId}
                  onSelect={() => setSelected(selected === r.runId ? null : r.runId)}
                />
              ))}
            </VStack>
          </Collapsible>
        ))}
      </VStack>
    )
  }

  return (
    <Layout height="fill">
      <LayoutHeader hasDivider>
        <HStack gap={3} vAlign="center" style={{ width: '100%', padding: '0 var(--spacing-3)' }}>
          <VStack gap={0}>
            <Heading level={2}>Activity</Heading>
            <Text type="supporting" color="secondary">
              Everything that ran, newest first
            </Text>
          </VStack>
          <HStack gap={2} vAlign="center" style={{ marginInlineStart: 'auto' }}>
            <TextInput
              label="Filter runs"
              isLabelHidden
              size="sm"
              value={needle}
              onChange={setNeedle}
              placeholder="branch, commit, task, run id…"
            />
            <SegmentedControl label="Status filter" size="sm" value={status} onChange={(v) => setStatus(v as StatusFilter)}>
              <SegmentedControlItem value="all" label="All" />
              <SegmentedControlItem value="failed" label="Failed" />
              <SegmentedControlItem value="passed" label="Passed" />
            </SegmentedControl>
            {caps.hasWorkspace && <Button size="sm" variant="primary" label="Run a task" href="#/run" />}
          </HStack>
        </HStack>
      </LayoutHeader>
      <LayoutContent padding={0} isScrollable>
        {body}
      </LayoutContent>
      {selectedInv !== null && (
        <>
          <ResizeHandle resizable={panel.props} isReversed isAlwaysVisible={false} />
          <LayoutPanel resizable={panel.props} hasDivider isScrollable label="Run inspector">
            <Inspector runId={selectedInv.runId} inv={selectedInv} />
          </LayoutPanel>
        </>
      )}
    </Layout>
  )
}
