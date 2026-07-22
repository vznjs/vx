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
  listInvocations,
  type FlakyTask,
  type InvocationDetail,
} from '../api.ts'
import { formatDuration, formatPercent } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Page, PageHeader, QueryGate, SectionHeader } from '../components/page.tsx'

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

/** Nav-badge count: failing branches + flaky tasks. Cheap; never throws. */
export function useAttentionCount(): number {
  const invocations = useQuery(() => listInvocations(30).catch(() => []), [])
  const flaky = useQuery(() => getFlakiest(10).catch(() => []), [])
  return failingNow(invocations.data ?? []).length + flakyOnly(flaky.data ?? []).length
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
                    <Item
                      key={r.runId}
                      density="balanced"
                      href={`#/runs/${encodeURIComponent(r.runId)}`}
                      startContent={<StatusDot variant="error" label="failing" />}
                      label={
                        <HStack gap={2} vAlign="center">
                          <Text weight="medium">{r.branch ?? 'no branch'}</Text>
                          <Text type="code" color="secondary">
                            {(r.commitSha ?? '').slice(0, 8) || '—'}
                          </Text>
                        </HStack>
                      }
                      description={`${r.failedCount} failed of ${r.taskCount} tasks — ${r.requestedTasks.join(' ') || r.command}`}
                      endContent={
                        <Text type="supporting" color="secondary">
                          <Timestamp value={new Date(r.startedAt).toISOString()} format="relative" />
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

      <QueryGate query={flaky} rows={3}>
        {(rows) => {
          const list = flakyOnly(rows)
          return (
            <Section
              title="Flaky tasks"
              hint="same key, different outcomes — retries recommended"
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
                      label={<Text type="code">{t.id}</Text>}
                      description={`fails ${formatPercent(t.failureRate, 0)} of runs`}
                      endContent={<Token size="sm" color="purple" label="exec.retries: 2" />}
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
                {rows.map((b) => (
                  <Item
                    key={b.id}
                    density="balanced"
                    href="#/insights/speed"
                    startContent={<Token size="sm" color="yellow" label="slow" />}
                    label={<Text type="code">{b.id}</Text>}
                    description={`${b.runsRecent} runs · avg ${formatDuration(b.avgDurationMs)}`}
                    endContent={
                      <Text weight="medium">{formatDuration(b.totalDurationMs)}</Text>
                    }
                  />
                ))}
              </Card>
            )}
          </Section>
        )}
      </QueryGate>
    </Page>
  )
}
