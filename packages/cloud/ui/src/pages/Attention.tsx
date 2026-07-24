// Needs attention — the inbox (Graphite/Linear pattern): everything that
// needs a human, ranked by severity, each row deep-linking to its fix
// surface. An EMPTY inbox is the success state and says so. The nav badge
// reads useAttentionCount (failing branches + flaky tasks).

import type { JSX, ReactNode } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Item } from '@astryxdesign/core/Item'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Text } from '@astryxdesign/core/Text'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { Token } from '@astryxdesign/core/Token'
import {
  getBottlenecks,
  getFlakiest,
  getHistory,
  getRun,
  listInvocations,
  listRunRows,
  type FlakyTask,
  type InvocationDetail,
  type RunSummaryRow,
  type TaskHistoryRow,
} from '../api.ts'
import { formatDuration, formatPercent } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Page, PageHeader, QueryGate, SectionHeader } from '../components/page.tsx'
import { TaskRef } from '../components/ident.tsx'
import { RankedRow } from '../components/viz.tsx'

const isFailed = (r: InvocationDetail): boolean => r.failedCount > 0 || r.exitOk === false

/** Latest failing run per branch (dedupe newest-first), max 10. */
function failingNow(rows: InvocationDetail[]): InvocationDetail[] {
  const seen = new Set<string>()
  const out: InvocationDetail[] = []
  for (const r of [...rows].sort((a, b) => b.startedAt - a.startedAt)) {
    const branch = r.branch ?? '(no branch)'
    if (seen.has(branch)) continue
    seen.add(branch)
    if (isFailed(r)) out.push(r)
    if (out.length >= 10) break
  }
  return out
}

const flakyOnly = (rows: FlakyTask[]): FlakyTask[] =>
  rows.filter((t) => t.failures > 1 && t.failureRate > 0.05).slice(0, 10)

interface Slowdown {
  id: string
  p50: number
  last: number
  ratio: number
  at: number
}

/**
 * Regression detector: tasks whose LATEST executed run is >= 2x their own
 * typical (p50) executed duration, with an absolute floor so millisecond
 * noise never flags. Cache hits are excluded on both sides — this compares
 * real work against real work.
 */
function detectSlowdowns(hist: TaskHistoryRow[], rows: RunSummaryRow[]): Slowdown[] {
  const p50ById = new Map(
    hist.filter((h) => (h.p50DurationMs ?? 0) > 0).map((h) => [h.id, h.p50DurationMs ?? 0]),
  )
  const latest = new Map<string, RunSummaryRow>()
  for (const r of rows) {
    if (r.status !== 'success') continue
    const id = `${r.project}#${r.task}`
    if (!latest.has(id)) latest.set(id, r) // rows are newest-first
  }
  const out: Slowdown[] = []
  for (const [id, r] of latest) {
    const p50 = p50ById.get(id)
    if (p50 === undefined) continue
    const ratio = r.durationMs / p50
    if (ratio >= 2 && r.durationMs - p50 >= 100) {
      out.push({ id, p50, last: r.durationMs, ratio, at: r.startedAt })
    }
  }
  return out.sort((a, b) => b.ratio - a.ratio).slice(0, 8)
}

/** Nav-badge count: failing branches + flaky tasks. Cheap; never throws. */
export function useAttentionCount(): number {
  const invocations = useQuery(() => listInvocations(30).catch(() => []), [])
  const flaky = useQuery(() => getFlakiest(10).catch(() => []), [])
  return failingNow(invocations.data ?? []).length + flakyOnly(flaky.data ?? []).length
}

/**
 * One failing-branch row. Fetches the run's task list to NAME the failing
 * tasks — the fact you actually act on — falling back to counts while the
 * fetch is in flight.
 */
function FailingRow({ r }: { r: InvocationDetail }): JSX.Element {
  const run = useQuery(() => getRun(r.runId).catch(() => null), [r.runId])
  const failedIds = (run.data?.tasks ?? [])
    .filter((t) => t.status === 'failed')
    .map((t) => `${t.project}#${t.task}`)
  const shown = failedIds.slice(0, 3)
  const more = failedIds.length - shown.length
  return (
    <Item
      density="balanced"
      href={`#/runs/${encodeURIComponent(r.runId)}`}
      startContent={<StatusDot variant="error" label="failing" />}
      label={
        <HStack gap={2} vAlign="center">
          <Text weight="medium">{r.branch ?? 'no branch'}</Text>
          <Text type="code" color="secondary">
            {(r.commitSha ?? '').slice(0, 8) || '—'}
          </Text>
          {shown.map((id) => (
            <Token key={id} size="sm" color="red" label={id} />
          ))}
          {more > 0 && (
            <Text type="supporting" color="secondary">
              +{more} more
            </Text>
          )}
        </HStack>
      }
      description={`${r.failedCount} of ${r.taskCount} tasks failed — ${r.requestedTasks.join(' ') || r.command}`}
      endContent={
        <Text type="supporting" color="secondary">
          <Timestamp value={new Date(r.startedAt).toISOString()} format="relative" />
        </Text>
      }
    />
  )
}

function Section(props: {
  title: string
  hint: string
  empty: string
  children: ReactNode | null
}): JSX.Element {
  return (
    <VStack gap={2}>
      <SectionHeader title={props.title} hint={props.hint} />
      {props.children ?? (
        <Card padding={4}>
          <HStack gap={2} vAlign="center">
            <StatusDot variant="success" label="clear" />
            <Text color="secondary">{props.empty}</Text>
          </HStack>
        </Card>
      )}
    </VStack>
  )
}

export function Attention(): JSX.Element {
  const invocations = useQuery(() => listInvocations(30), [])
  const flaky = useQuery(() => getFlakiest(10), [])
  const bottlenecks = useQuery(() => getBottlenecks(14, 5), [])
  const history = useQuery(() => getHistory({ limit: 500 }).catch(() => []), [])
  const recentRows = useQuery(() => listRunRows({ limit: 300 }).catch(() => []), [])

  return (
    <Page>
      <PageHeader title="Needs attention" subtitle="Everything that needs a human, ranked by severity" />
      <QueryGate query={invocations} rows={3}>
        {(rows) => {
          const failing = failingNow(rows)
          return (
            <Section
              title="Failing now"
              hint="latest run per branch"
              empty="Every branch's latest run is green."
            >
              {failing.length === 0 ? null : (
                <Card padding={0}>
                  {failing.map((r) => (
                    <FailingRow key={r.runId} r={r} />
                  ))}
                </Card>
              )}
            </Section>
          )
        }}
      </QueryGate>

      <QueryGate query={flaky} rows={3}>
        {(rows) => {
          const list = flakyOnly(rows)
          return (
            <Section
              title="Flaky tasks"
              hint="same key, different outcomes"
              empty="No flaky tasks detected."
            >
              {list.length === 0 ? null : (
                <Card padding={0}>
                  {list.map((t) => (
                    <Item
                      key={t.id}
                      density="balanced"
                      href={`#/tasks/${encodeURIComponent(t.id)}`}
                      startContent={<Token size="sm" color="orange" label="flaky" />}
                      label={<TaskRef id={t.id} />}
                      description={`fails ${formatPercent(t.failureRate, 0)} of runs — ${t.failures} of ${t.runs}`}
                      endContent={<Token size="sm" color="red" label={`${t.failures}×`} />}
                    />
                  ))}
                </Card>
              )}
            </Section>
          )
        }}
      </QueryGate>

      <QueryGate query={recentRows} rows={2}>
        {(rows) => {
          const slow = detectSlowdowns(history.data ?? [], rows)
          return (
            <Section
              title="Got slower"
              hint="latest executed run vs the task's own p50 — cache hits excluded"
              empty="No task is running meaningfully slower than its history."
            >
              {slow.length === 0 ? null : (
                <Card padding={0}>
                  {slow.map((t) => (
                    <RankedRow
                      key={t.id}
                      href={`#/tasks/${encodeURIComponent(t.id)}`}
                      label={<TaskRef id={t.id} />}
                      sub={`typical ${formatDuration(t.p50)} → last ${formatDuration(t.last)}`}
                      extra={<Token size="sm" color="orange" label={`${t.ratio.toFixed(1)}× slower`} />}
                      frac={Math.min(1, t.ratio / 4)}
                      color="var(--color-warning)"
                      end={
                        <Text type="supporting" color="secondary">
                          <Timestamp value={new Date(t.at).toISOString()} format="relative" />
                        </Text>
                      }
                    />
                  ))}
                </Card>
              )}
            </Section>
          )
        }}
      </QueryGate>

      <QueryGate query={bottlenecks} rows={3}>
        {(rows) => (
          <Section
            title="Where the time goes"
            hint="top burners, last 14 days"
            empty="No significant time sinks."
          >
            {rows.length === 0 ? null : (
              <Card padding={0}>
                {(() => {
                  const max = Math.max(1, ...rows.map((b) => b.totalDurationMs))
                  return rows.map((b, i) => (
                    <RankedRow
                      key={b.id}
                      rank={i + 1}
                      href={`#/tasks/${encodeURIComponent(b.id)}`}
                      label={<TaskRef id={b.id} />}
                      sub={`${b.runsRecent} run${b.runsRecent === 1 ? '' : 's'} · avg ${formatDuration(b.avgDurationMs)}`}
                      frac={b.totalDurationMs / max}
                      color="var(--vx-chart-1, #7c3aed)"
                      end={
                        <Text weight="medium" hasTabularNumbers>
                          {formatDuration(b.totalDurationMs)}
                        </Text>
                      }
                    />
                  ))
                })()}
              </Card>
            )}
          </Section>
        )}
      </QueryGate>
    </Page>
  )
}
