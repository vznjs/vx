// Run detail — one recorded `vx run` invocation: the invocation-context
// header (command / git / CI / cache policy), KPI summary, the run
// visualized as a reconstructed DAG (when this serve has a colocated
// workspace) or a flamegraph of the recorded rows, the per-task table, and a
// selected-task inspector with the "why did this re-run?" input-fingerprint
// diff (cacheKeyDiff, fetched on demand for the selected task).

import { useMemo, useState, type JSX } from 'react'
import { useParams } from 'react-router-dom'
import { Card } from '@astryxdesign/core/Card'
import { CodeBlock } from '@astryxdesign/core/CodeBlock'
import { Divider } from '@astryxdesign/core/Divider'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutPanel,
  StackItem,
  VStack,
} from '@astryxdesign/core/Layout'
import { Link } from '@astryxdesign/core/Link'
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList'
import { ResizeHandle, useResizable } from '@astryxdesign/core/Resizable'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Skeleton } from '@astryxdesign/core/Skeleton'
import { Table, pixel, proportional } from '@astryxdesign/core/Table'
import type { TableColumn } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { Token } from '@astryxdesign/core/Token'
import {
  cacheKeyDiff,
  getGraph,
  getInvocation,
  getRun,
  useCapabilities,
  type CacheKeyDiff,
  type GraphNode,
  type InputDiffEntry,
  type InvocationDetail,
  type RunDetail as RunDetailData,
  type RunSummaryRow,
} from '../api.ts'
import { cpuPct, formatBytes, formatDuration } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { Kpi, KpiRow, Page, QueryGate, SectionHeader } from '../components/page.tsx'
import { Flamegraph, flameEdgesOf } from '../components/Flamegraph.tsx'
import { RunGraph } from '../components/RunGraph.tsx'
import { StatusToken, toVizState, type VizState } from '../components/status.tsx'

const taskIdOf = (t: RunSummaryRow): string => `${t.project}#${t.task}`
const shortId = (s: string): string => (s === '' ? '—' : s.slice(0, 8))

// Hash-shaped diff components shorten to 12 chars; value components (env /
// runtime / forward) show verbatim. A null side renders as "∅"; a
// reason-only row (no component) renders an empty cell.
const HASH_KINDS = new Set(['file', 'upstream', 'package', 'config', 'workspace', 'ws-runtime'])
function diffText(e: InputDiffEntry): string {
  if (e.before === null && e.after === null) return ''
  const short = (v: string | null): string =>
    v === null ? '∅' : HASH_KINDS.has(e.kind) ? `${v.slice(0, 12)}…` : v
  return `${short(e.before)} → ${short(e.after)}`
}

const changeColor = (change: InputDiffEntry['change']): 'green' | 'yellow' | 'red' =>
  change === 'added' ? 'green' : change === 'changed' ? 'yellow' : 'red'

function tagsText(tags: Record<string, string>): string {
  return Object.entries(tags)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
}

interface TaskRow extends Record<string, unknown> {
  id: string
  project: string
  task: string
  status: string
  state: VizState
  durationMs: number
  cpuMs: number | null
  cpuPctValue: number | undefined
  peakRssBytes: number | null
  cacheHit: boolean | null
}

function toTaskRow(t: RunSummaryRow): TaskRow {
  return {
    id: taskIdOf(t),
    project: t.project,
    task: t.task,
    status: t.status,
    state: toVizState(t.status, t.cacheHit === true),
    durationMs: t.durationMs,
    cpuMs: t.cpuMs,
    cpuPctValue: cpuPct(t.cpuMs, t.durationMs, t.cacheHit),
    peakRssBytes: t.peakRssBytes,
    cacheHit: t.cacheHit,
  }
}

function cacheSourceToken(t: TaskRow): JSX.Element | string {
  if (t.status === 'cache-hit') return <Token size="sm" color="cyan" label="local" />
  if (t.status === 'cache-hit-remote') return <Token size="sm" color="blue" label="remote" />
  return '—'
}

/** Invocation-context facts strip (command + git/CI/host/cache metadata). */
function InvocationFacts({ inv }: { inv: InvocationDetail }): JSX.Element {
  const tags = tagsText(inv.tags)
  return (
    <Card padding={4}>
      <VStack gap={3}>
        <CodeBlock code={inv.command} language="shell" size="sm" width="100%" container="section" isWrapped />
        <MetadataList columns="multi" label={{ position: 'top' }}>
          <MetadataListItem label="Branch">
            <Text type="code">{inv.branch ?? '—'}</Text>
          </MetadataListItem>
          <MetadataListItem label="Commit">
            <Text type="code">{inv.commitSha === null ? '—' : inv.commitSha.slice(0, 10)}</Text>
          </MetadataListItem>
          <MetadataListItem label="Worktree">
            <Text type="body">{inv.dirty === true ? 'dirty' : inv.dirty === false ? 'clean' : '—'}</Text>
          </MetadataListItem>
          <MetadataListItem label="CI">
            <Token
              size="sm"
              label={inv.ci ? (inv.ciProvider ?? 'CI') : 'local'}
              color={inv.ci ? 'blue' : 'gray'}
            />
          </MetadataListItem>
          <MetadataListItem label="Tags">
            <Text type="code">{tags === '' ? '—' : tags}</Text>
          </MetadataListItem>
          <MetadataListItem label="Cache">
            <Text type="code">{inv.cachePolicy}</Text>
          </MetadataListItem>
          <MetadataListItem label="Workers">
            <Text type="body" hasTabularNumbers>
              {inv.concurrency}
            </Text>
          </MetadataListItem>
          <MetadataListItem label="vx">
            <Text type="code">{inv.vxVersion}</Text>
          </MetadataListItem>
        </MetadataList>
      </VStack>
    </Card>
  )
}

/** "Why did this re-run?" — the on-demand input-fingerprint diff for one task. */
function WhyPanel(props: {
  runId: string
  row: TaskRow
  hasCacheDb: boolean
  capsKnown: boolean
}): JSX.Element {
  const { runId, row } = props
  const reran = row.status === 'success' || row.status === 'failed'
  const gated = props.capsKnown && !props.hasCacheDb
  const diff = useQuery<CacheKeyDiff | null>(
    () => (reran && !gated ? cacheKeyDiff(runId, row.id) : Promise.resolve(null)),
    [runId, row.id, reran, gated],
  )

  if (!reran) {
    return (
      <Text type="supporting" color="secondary">
        {row.status === 'cache-hit' || row.status === 'cache-hit-remote'
          ? 'This task was a cache hit — it did not re-run.'
          : 'This task did not execute in this run.'}
      </Text>
    )
  }
  if (gated) {
    return (
      <Text type="supporting" color="secondary">
        The input-fingerprint diff lives in the workspace's local cache.db — start vx-cloud serve
        inside the repo to see exactly which files/env/deps changed. This serve shows pushed run
        analytics only.
      </Text>
    )
  }
  if (diff.data === undefined) {
    return diff.loading ? (
      <Skeleton height={60} />
    ) : (
      <Text type="supporting" color="secondary">
        {diff.error ?? "Couldn't load the diff."}
      </Text>
    )
  }
  const d = diff.data
  if (d === null) return <Text type="supporting" color="secondary">—</Text>
  if (!d.found || d.previousRunId === null) {
    return (
      <Text type="supporting" color="secondary">
        First recorded run of this task — nothing to diff against.
      </Text>
    )
  }
  if (d.entries.length === 0) {
    return (
      <Text type="supporting" color="secondary">
        Ran with the same cache key as the previous run — the task isn't cacheable, or caching was
        bypassed (--force / --no-cache).
      </Text>
    )
  }
  const rows = d.entries.map((e, i): Record<string, unknown> => ({
    rowKey: `${e.kind}:${e.name}:${i}`,
    kind: e.kind,
    name: e.name,
    change: e.change,
    diff: diffText(e),
  }))
  return (
    <VStack gap={2}>
      <Card padding={0}>
        <Table
          data={rows}
          idKey="rowKey"
          density="compact"
          columns={[
            { key: 'kind', header: 'Kind', width: pixel(90) },
            { key: 'name', header: 'Name', width: proportional(1) },
            {
              key: 'change',
              header: 'Change',
              width: pixel(90),
              renderCell: (r) => (
                <Token
                  size="sm"
                  label={String(r.change)}
                  color={changeColor(r.change as InputDiffEntry['change'])}
                />
              ),
            },
            {
              key: 'diff',
              header: 'Before → After',
              width: proportional(1),
              renderCell: (r) => <Text type="code">{String(r.diff)}</Text>,
            },
          ]}
        />
      </Card>
      <Text type="supporting" color="secondary">
        {d.unchangedCount} unchanged component{d.unchangedCount === 1 ? '' : 's'}
        {d.note !== '' ? ` · ${d.note}` : ''}
      </Text>
    </VStack>
  )
}

export function RunDetail(): JSX.Element {
  const { id = '' } = useParams()
  const capabilities = useCapabilities()
  const run = useQuery<RunDetailData | null>(() => getRun(id), [id])
  const invocation = useQuery<InvocationDetail | null>(() => getInvocation(id), [id])
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<'graph' | 'flame'>('graph')

  const tasks = useMemo(() => run.data?.tasks ?? [], [run.data])
  const rows = useMemo(() => tasks.map(toTaskRow), [tasks])

  // Graph reconstruction needs a colocated workspace (/v1/graph = planRun).
  const showGraph = capabilities.known && capabilities.hasWorkspace
  const taskIdsKey = useMemo(
    () => Array.from(new Set(tasks.map(taskIdOf))).join(','),
    [tasks],
  )
  const graph = useQuery<GraphNode[]>(
    () =>
      showGraph && taskIdsKey !== ''
        ? getGraph(taskIdsKey.split(',')).catch(() => [])
        : Promise.resolve([]),
    [showGraph, taskIdsKey],
  )
  const graphNodes = graph.data ?? []

  // Recorded statuses overlaid on the reconstructed DAG.
  const stateMap = useMemo(() => {
    const m = new Map<string, VizState>()
    for (const r of rows) m.set(r.id, r.state)
    return m
  }, [rows])
  const durationMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.id, r.durationMs)
    return m
  }, [rows])
  const cpuMap = useMemo(() => {
    const m = new Map<string, { cpuMs?: number; peakRssBytes?: number }>()
    for (const r of rows) {
      m.set(r.id, {
        cpuMs: r.cpuMs ?? undefined,
        peakRssBytes: r.peakRssBytes ?? undefined,
      })
    }
    return m
  }, [rows])
  const flameEdges = useMemo(() => flameEdgesOf(graphNodes), [graphNodes])

  const selectedRow = selected !== null ? rows.find((r) => r.id === selected) : undefined
  const selectedTask = selected !== null ? tasks.find((t) => taskIdOf(t) === selected) : undefined

  const effectiveView: 'graph' | 'flame' = showGraph ? view : 'flame'

  const columns = useMemo((): TableColumn<TaskRow>[] => [
    {
      key: 'id',
      header: 'Task',
      width: proportional(2),
      renderCell: (r) => (
        <Link onClick={() => setSelected(r.id)}>
          <Text type="code">{r.id}</Text>
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: pixel(120),
      renderCell: (r) => <StatusToken state={r.state} />,
    },
    {
      key: 'durationMs',
      header: 'Duration',
      width: pixel(100),
      align: 'end',
      renderCell: (r) => formatDuration(r.durationMs),
    },
    {
      key: 'cpuMs',
      header: 'CPU',
      width: pixel(90),
      align: 'end',
      renderCell: (r) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {r.cpuMs === null ? '—' : formatDuration(r.cpuMs)}
        </Text>
      ),
    },
    {
      key: 'cpuPctValue',
      header: 'CPU %',
      width: pixel(80),
      align: 'end',
      renderCell: (r) =>
        r.cpuPctValue === undefined ? (
          '—'
        ) : (
          <Text
            hasTabularNumbers
            style={r.cpuPctValue > 100 ? { color: 'var(--color-success)' } : undefined}
          >
            {r.cpuPctValue}%
          </Text>
        ),
    },
    {
      key: 'peakRssBytes',
      header: 'Peak RSS',
      width: pixel(100),
      align: 'end',
      renderCell: (r) => (
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {r.peakRssBytes === null ? '—' : formatBytes(r.peakRssBytes)}
        </Text>
      ),
    },
    {
      key: 'cacheHit',
      header: 'Cache',
      width: pixel(90),
      align: 'end',
      renderCell: cacheSourceToken,
    },
    {
      key: 'history',
      header: '',
      width: pixel(80),
      align: 'end',
      renderCell: (r) => (
        <Link href={`#/tasks/${encodeURIComponent(r.id)}`}>
          <Text type="supporting">history</Text>
        </Link>
      ),
    },
  ], [])

  const inspector = useResizable({ defaultSize: 420, minSizePx: 340, maxSizePx: 600 })

  return (
    <Layout
      height="fill"
      content={
        <LayoutContent padding={0}>
          <Page>
            <SectionHeader
              title={`Run ${shortId(id)}`}
              badge={
                rows.length > 0 ? (
                  <StatusToken
                    state={rows.some((r) => r.status === 'failed') ? 'failed' : 'success'}
                  />
                ) : undefined
              }
              end={
                <Link href="#/runs">
                  <Text type="supporting">← all runs</Text>
                </Link>
              }
            />

            <QueryGate query={run} rows={2}>
              {(data) =>
                data === null ? (
                  <EmptyState title="Run not found" description="This serve has no record of that run id." />
                ) : (
                  <>
                    {invocation.data !== undefined && invocation.data !== null && (
                      <InvocationFacts inv={invocation.data} />
                    )}

                    {(() => {
                      const okCount = rows.filter((r) => r.status === 'success').length
                      const failCount = rows.filter((r) => r.status === 'failed').length
                      const hitCount = rows.filter((r) => r.cacheHit === true).length
                      const wallMs =
                        rows.length === 0
                          ? 0
                          : Math.max(...tasks.map((t) => t.endedAt)) -
                            Math.min(...tasks.map((t) => t.startedAt))
                      const totalMs = tasks.reduce((n, t) => n + t.durationMs, 0)
                      const cpuMs = tasks.reduce((n, t) => n + (t.cpuMs ?? 0), 0)
                      return (
                        <KpiRow>
                          <Kpi
                            label="Tasks"
                            value={rows.length}
                            sub={`${okCount} ok · ${failCount} fail · ${hitCount} hits`}
                          />
                          <Kpi label="Wall time" value={formatDuration(wallMs)} />
                          <Kpi
                            label="Total task time"
                            value={formatDuration(totalMs)}
                            sub="sum across all tasks"
                          />
                          <Kpi label="CPU time" value={formatDuration(cpuMs)} />
                        </KpiRow>
                      )
                    })()}

                    <SectionHeader
                      title="Execution"
                      hint="Graph = dependency structure · Flame = by actual time · click to inspect"
                      end={
                        showGraph ? (
                          <SegmentedControl
                            label="Visualization"
                            size="sm"
                            value={view}
                            onChange={(v) => setView(v as 'graph' | 'flame')}
                          >
                            <SegmentedControlItem label="Graph" value="graph" />
                            <SegmentedControlItem label="Flame" value="flame" />
                          </SegmentedControl>
                        ) : undefined
                      }
                    />
                    {!showGraph && capabilities.known && (
                      <Text type="supporting" color="secondary">
                        The dependency graph is reconstructed from a colocated workspace — start
                        vx-cloud serve inside the repo to see it. Showing the recorded timeline.
                      </Text>
                    )}
                    <Card padding={0}>
                      <div style={{ height: 420, minHeight: 0 }}>
                        {effectiveView === 'graph' ? (
                          graph.data === undefined ? (
                            <Skeleton height={420} />
                          ) : graphNodes.length === 0 ? (
                            <EmptyState
                              title="Couldn't reconstruct the graph"
                              description="The workspace no longer declares these tasks."
                              isCompact
                            />
                          ) : (
                            <RunGraph
                              nodes={graphNodes}
                              states={stateMap}
                              durations={durationMap}
                              cpu={cpuMap}
                              selected={selected}
                              onSelect={setSelected}
                              showPredicted={false}
                            />
                          )
                        ) : rows.length === 0 ? (
                          <EmptyState title="No tasks in this run" isCompact />
                        ) : (
                          <Flamegraph
                            tasks={tasks}
                            selectedId={selected ?? undefined}
                            edges={flameEdges}
                            onSelect={(t) => setSelected(taskIdOf(t))}
                          />
                        )}
                      </div>
                    </Card>

                    <SectionHeader title={`Tasks (${rows.length})`} hint="task → inspect · history → task page" />
                    {rows.length === 0 ? (
                      <EmptyState title="No tasks" />
                    ) : (
                      <Card padding={0}>
                        <Table data={rows} columns={columns} idKey="id" density="compact" hasHover />
                      </Card>
                    )}
                  </>
                )
              }
            </QueryGate>
          </Page>
        </LayoutContent>
      }
      end={
        selectedRow !== undefined && selectedTask !== undefined ? (
          <>
            <ResizeHandle
              direction="horizontal"
              hasDivider
              isAlwaysVisible={false}
              resizable={inspector.props}
              label="Resize task inspector"
            />
            <LayoutPanel width={inspector.size} padding={0} label="Task inspector" isScrollable>
              <VStack gap={0}>
                <HStack gap={2} vAlign="center" paddingInline={3} paddingBlock={2}>
                  <StackItem size="fill" style={{ minWidth: 0 }}>
                    <Text type="code" size="sm" maxLines={1}>
                      {selectedRow.id}
                    </Text>
                  </StackItem>
                  <StatusToken state={selectedRow.state} />
                </HStack>
                <Divider />
                <VStack paddingInline={3} paddingBlock={2}>
                  <MetadataList columns={2} label={{ position: 'top' }}>
                    <MetadataListItem label="Started">
                      <Timestamp value={new Date(selectedTask.startedAt).toISOString()} format="date_time" />
                    </MetadataListItem>
                    <MetadataListItem label="Ended">
                      <Timestamp value={new Date(selectedTask.endedAt).toISOString()} format="date_time" />
                    </MetadataListItem>
                    <MetadataListItem label="Duration">
                      <Text type="body" hasTabularNumbers>
                        {formatDuration(selectedTask.durationMs)}
                      </Text>
                    </MetadataListItem>
                    <MetadataListItem label="CPU">
                      <Text type="body" hasTabularNumbers>
                        {selectedTask.cpuMs === null ? '—' : formatDuration(selectedTask.cpuMs)}
                      </Text>
                    </MetadataListItem>
                    <MetadataListItem label="Peak RSS">
                      <Text type="body" hasTabularNumbers>
                        {selectedTask.peakRssBytes === null ? '—' : formatBytes(selectedTask.peakRssBytes)}
                      </Text>
                    </MetadataListItem>
                    <MetadataListItem label="Exit">
                      <Text type="body" hasTabularNumbers>
                        {selectedTask.exitCode}
                      </Text>
                    </MetadataListItem>
                    <MetadataListItem label="Hash">
                      <Text type="code">{selectedTask.hash === '' ? '—' : selectedTask.hash.slice(0, 16)}</Text>
                    </MetadataListItem>
                  </MetadataList>
                </VStack>
                <Divider />
                <VStack gap={2} paddingInline={3} paddingBlock={2}>
                  <Text type="label" color="secondary">
                    Why did this re-run?
                  </Text>
                  <WhyPanel
                    runId={id}
                    row={selectedRow}
                    hasCacheDb={capabilities.hasCacheDb}
                    capsKnown={capabilities.known}
                  />
                </VStack>
              </VStack>
            </LayoutPanel>
          </>
        ) : undefined
      }
    />
  )
}
