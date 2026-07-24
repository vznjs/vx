// The run cockpit: trigger a task, watch its DAG execute live, inspect logs.
//
// On Run we fetch the task graph (nodes + edges, predicted cache status) and
// open a WebSocket to vx serve; the streamed events drive each node's live
// status, an overall progress bar, and per-task log capture. The predicted
// cacheStatus badges queued cards ("what will this run actually do") and
// clears per node as live events land. Running while a run is in progress is
// forbidden (the Run button is disabled until it finishes) — one run at a
// time avoids the output-cleaning race between overlapping different-hash
// runs (docs/design/execution-service-2026-06.md). Stop abandons watching the
// current run so the UI can recover (supersede semantics: the run keeps going
// server-side).
//
// Live log chunks accumulate in a REF (not state) — a chatty task streaming
// thousands of stdout chunks appends in place and re-renders through one
// throttled tick, instead of cloning a record per chunk.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ArrowTrendingUpIcon, FireIcon, PlayIcon, StopIcon } from '@heroicons/react/24/outline'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { CodeBlock } from '@astryxdesign/core/CodeBlock'
import { Divider } from '@astryxdesign/core/Divider'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Icon } from '@astryxdesign/core/Icon'
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutHeader,
  LayoutPanel,
  StackItem,
  VStack,
} from '@astryxdesign/core/Layout'
import { Link } from '@astryxdesign/core/Link'
import { List, ListItem } from '@astryxdesign/core/List'
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList'
import { ProgressBar } from '@astryxdesign/core/ProgressBar'
import { ResizeHandle, useResizable } from '@astryxdesign/core/Resizable'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Heading, Text } from '@astryxdesign/core/Text'
import { Token } from '@astryxdesign/core/Token'
import { Tokenizer } from '@astryxdesign/core/Tokenizer'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import { createStaticSource } from '@astryxdesign/core/Typeahead'
import {
  getGraph,
  getHistory,
  getVersion,
  listInvocations,
  runTasks,
  useCapabilities,
  type GraphNode,
  type RunSummaryRow,
  type ServerVersion,
  type TaskHistoryRow,
  type WireEvent,
} from '../api.ts'
import { cpuPct, formatBytes, formatDuration, formatTime } from '../format.ts'
import { useQuery } from '../hooks.ts'
import { criticalPath, parallelism } from '../components/critical-path.ts'
import { Flamegraph, flameEdgesOf } from '../components/Flamegraph.tsx'
import { RunGraph } from '../components/RunGraph.tsx'
import { StatusCell, toVizState, type VizState } from '../components/status.tsx'
import { projectColor, TASK_COLOR, TaskRef } from '../components/ident.tsx'

interface NodeStatus {
  state: VizState
  durationMs?: number
  exitCode?: number
  cpuMs?: number
  peakRssBytes?: number
}

/** A task selection chip in the picker (Tokenizer item shape). */
interface TaskOpt {
  id: string
  label: string
}

interface TaskWindow {
  startedAt: number
  endedAt?: number
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '')

const fmtDur = (ms?: number): string => (ms === undefined ? '—' : formatDuration(ms))
const fmtClock = (ms?: number): string => (ms === undefined ? '—' : formatTime(ms))

export function RunConsole(): JSX.Element {
  const capabilities = useCapabilities()
  const version = useQuery<ServerVersion | null>(() => getVersion().catch(() => null), [])
  const history = useQuery<TaskHistoryRow[]>(
    () => getHistory({ limit: 300 }).catch(() => []),
    [],
  )
  const taskNames = useMemo(
    () => Array.from(new Set((history.data ?? []).map((h) => h.task))).sort(),
    [history.data],
  )

  // Task picker: multi-select tokens over the workspace's known task names
  // (from run history), with free-form entry for anchored `pkg#task` forms.
  const [taskSel, setTaskSel] = useState<TaskOpt[]>([])
  const taskSource = useMemo(
    () => createStaticSource(taskNames.map((t) => ({ id: t, label: t }))),
    [taskNames],
  )
  const addTask = useCallback((t: string): void => {
    setTaskSel((prev) => (prev.some((p) => p.label === t) ? prev : [...prev, { id: t, label: t }]))
  }, [])
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [statuses, setStatuses] = useState<Map<string, NodeStatus>>(() => new Map())
  // Per-task wall-clock window, observed from when each event arrives (the
  // outcome carries durationMs but cache hits have no wallclock ns) — enough
  // to draw a live flamegraph of the current run.
  const [timing, setTiming] = useState<Map<string, TaskWindow>>(() => new Map())
  const [selected, setSelected] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [started, setStarted] = useState(false)
  const [view, setView] = useState<'graph' | 'flame'>('graph')
  const [now, setNow] = useState(0)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [runError, setRunError] = useState<string | null>(null)
  const [ok, setOk] = useState<boolean | null>(null)
  // Configured worker count from run:start (undefined if the server didn't send it).
  const [concurrency, setConcurrency] = useState<number | undefined>(undefined)
  // The recorded invocation id for the just-finished run (the delegated run
  // self-ingests) — lets the cockpit deep-link straight to the run report.
  const [recordedRunId, setRecordedRunId] = useState<string | null>(null)
  const prevNewestRef = useRef<string | null>(null)

  // Log accumulation: ref + throttled tick, so a chatty task can't render-storm.
  const logsRef = useRef<Map<string, string>>(new Map())
  const [, setLogTick] = useState(0)
  const logFlushPending = useRef(false)
  const scheduleLogFlush = useCallback((): void => {
    if (logFlushPending.current) return
    logFlushPending.current = true
    setTimeout(() => {
      logFlushPending.current = false
      setLogTick((t) => t + 1)
    }, 100)
  }, [])

  const cancelRef = useRef<(() => void) | null>(null)
  useEffect(() => () => cancelRef.current?.(), [])

  // Ticks only while a run is live so in-progress bars/chains grow.
  const runningRef = useRef(false)
  useEffect(() => {
    runningRef.current = running
  }, [running])
  useEffect(() => {
    const id = setInterval(() => {
      if (runningRef.current) setNow(Date.now())
    }, 250)
    return () => clearInterval(id)
  }, [])

  const handleEvent = useCallback(
    (ev: WireEvent): void => {
      if (ev.kind === 'run:start') {
        setProgress({ done: 0, total: ev.info.total })
        setConcurrency(ev.info.concurrency)
      } else if (ev.kind === 'task:start') {
        setStatuses((prev) => new Map(prev).set(ev.task.id, { state: 'running' }))
        setTiming((prev) => new Map(prev).set(ev.task.id, { startedAt: Date.now() }))
      } else if (ev.kind === 'task:stdout' || ev.kind === 'task:stderr') {
        // Append in place — only a throttled tick re-renders, never per chunk.
        logsRef.current.set(ev.taskId, (logsRef.current.get(ev.taskId) ?? '') + ev.chunk)
        scheduleLogFlush()
      } else if (ev.kind === 'task:complete') {
        const end = Date.now()
        setStatuses((prev) =>
          new Map(prev).set(ev.outcome.taskId, {
            state: toVizState(ev.outcome.status),
            durationMs: ev.outcome.durationMs,
            exitCode: ev.outcome.exitCode,
            cpuMs: ev.outcome.cpuMs,
            peakRssBytes: ev.outcome.peakRssBytes,
          }),
        )
        setTiming((prev) => {
          const t = prev.get(ev.outcome.taskId)
          return new Map(prev).set(ev.outcome.taskId, {
            // Cache hits/instant tasks may complete without a start event —
            // seed a window from the reported duration so the bar has width.
            startedAt: t?.startedAt ?? end - ev.outcome.durationMs,
            endedAt: end,
          })
        })
        setProgress((p) => ({ ...p, done: p.done + 1 }))
      }
    },
    [scheduleLogFlush],
  )

  // Failure-first diagnosis: when a run finishes red and nothing is selected,
  // open the first failed task's detail + output automatically.
  useEffect(() => {
    if (ok !== false || selected !== null) return
    for (const [id, st] of statuses) {
      if (st.state === 'failed') {
        setSelected(id)
        return
      }
    }
  }, [ok, selected, statuses])

  // Per-node duration (ms): the reported duration once complete, else the live
  // elapsed time for a running task, else 0 (queued). Recomputes as `now`
  // ticks so the critical path grows during the run and settles on completion.
  const durationOf = useCallback(
    (id: string): number => {
      const st = statuses.get(id)
      if (st?.durationMs !== undefined) return st.durationMs
      const t = timing.get(id)
      if (t && st?.state === 'running') return Math.max(0, (t.endedAt ?? now) - t.startedAt)
      return 0
    },
    [statuses, timing, now],
  )

  // A cache HIT restores ahead of its deps (the two-tier scheduler's restore
  // tier) — exclude it from the dependency-timing chain or the floor counts
  // upstream runtime the hit never waited for.
  const restoresAhead = useCallback(
    (id: string): boolean => {
      const s = statuses.get(id)?.state
      return s === 'cache-hit' || s === 'cache-hit-remote'
    },
    [statuses],
  )

  // Longest-duration dependency chain (the wall-time floor) over the live graph.
  const critical = useMemo(
    () => criticalPath(nodes, durationOf, restoresAhead),
    [nodes, durationOf, restoresAhead],
  )
  const criticalSet = useMemo(() => new Set(critical.chain), [critical])

  // Predicted-from-cache summary (real tasks only; groups do no work). Shown
  // while queued nodes still exist — "N of M will restore" before work lands.
  const predicted = useMemo(() => {
    const real = nodes.filter((n) => !n.isGroup)
    const hits = real.filter((n) => n.cacheStatus === 'hit-local' || n.cacheStatus === 'hit-remote')
    const queued = real.filter((n) => (statuses.get(n.id)?.state ?? 'queued') === 'queued')
    return { total: real.length, hits: hits.length, anyQueued: queued.length > 0 }
  }, [nodes, statuses])

  // Final tally for the completed-run summary strip.
  const tally = useMemo(() => {
    let success = 0
    let cached = 0
    let failedN = 0
    let skipped = 0
    for (const n of nodes) {
      if (n.isGroup) continue
      const s = statuses.get(n.id)?.state
      if (s === 'success') success++
      else if (s === 'cache-hit' || s === 'cache-hit-remote') cached++
      else if (s === 'failed') failedN++
      else if (s === 'skipped' || s === 'aborted') skipped++
    }
    return { success, cached, failed: failedN, skipped }
  }, [nodes, statuses])

  // Observed concurrency from the live per-task windows.
  const parallel = useMemo(() => {
    const intervals = Array.from(timing.values()).map((t) => ({
      startedAt: t.startedAt,
      endedAt: t.endedAt ?? Math.max(now, t.startedAt),
    }))
    return parallelism(intervals)
  }, [timing, now])

  // Maps the RunGraph consumes.
  const stateMap = useMemo(() => {
    const m = new Map<string, VizState>()
    for (const [id, st] of statuses) m.set(id, st.state)
    return m
  }, [statuses])
  const durationMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of nodes) m.set(n.id, durationOf(n.id))
    return m
  }, [nodes, durationOf])
  const cpuMap = useMemo(() => {
    const m = new Map<string, { cpuMs?: number; peakRssBytes?: number }>()
    for (const [id, st] of statuses) m.set(id, { cpuMs: st.cpuMs, peakRssBytes: st.peakRssBytes })
    return m
  }, [statuses])

  // Build flamegraph rows (RunSummaryRow shape) from live timing + status.
  const flameRows = useMemo<RunSummaryRow[]>(() => {
    return nodes
      // Groups (umbrella tasks) emit task events but do no work — exclude them
      // from the timeline; the flame is about real execution windows.
      .filter((n) => timing.has(n.id) && !n.isGroup)
      .map((n) => {
        const t = timing.get(n.id)!
        const st = statuses.get(n.id)
        const state = st?.state ?? 'running'
        const status = state === 'queued' ? 'running' : state
        const startedAt = t.startedAt
        const endedAt = t.endedAt ?? Math.max(now, startedAt)
        return {
          runId: null,
          project: n.project,
          task: n.task,
          status,
          exitCode: st?.exitCode ?? 0,
          durationMs: st?.durationMs ?? endedAt - startedAt,
          startedAt,
          endedAt,
          cacheHit: state === 'cache-hit',
          hash: '',
          cpuMs: null,
          peakRssBytes: null,
          wallclockStartNs: null,
          wallclockEndNs: null,
        }
      })
  }, [nodes, timing, statuses, now])

  // Dependency edges for the flame (dep → dependent = "what this unlocked").
  const flameEdges = useMemo(() => flameEdgesOf(nodes), [nodes])

  const start = (): void => {
    if (running) return // forbid running while a run is in progress
    const tasks = Array.from(new Set(taskSel.map((t) => t.label)))
    const root = version.data?.workspace
    if (tasks.length === 0 || root === undefined) return
    logsRef.current = new Map()
    setStatuses(new Map())
    setTiming(new Map())
    setSelected(null)
    setProgress({ done: 0, total: 0 })
    setRunError(null)
    setOk(null)
    setConcurrency(undefined)
    setRecordedRunId(null)
    setNow(Date.now())
    setRunning(true)
    setStarted(true)
    setNodes([])
    setLogTick((t) => t + 1)
    // Remember the newest recorded invocation BEFORE the run — anything newer
    // after completion is this run's report.
    prevNewestRef.current = null
    listInvocations({ limit: 1 })
      .then((rows) => {
        prevNewestRef.current = rows[0]?.runId ?? null
      })
      .catch(() => {})
    // Graph for layout/edges + predicted cache status; merge so live events
    // already received aren't clobbered.
    getGraph(tasks)
      .then((g) => {
        setNodes(g)
        setStatuses((prev) => {
          const next = new Map(prev)
          for (const n of g) if (!next.has(n.id)) next.set(n.id, { state: 'queued' })
          return next
        })
      })
      .catch(() => {})
    cancelRef.current = runTasks(tasks, root, {
      onEvent: handleEvent,
      onResult: (r) => {
        setRunning(false)
        setOk(r.ok)
        cancelRef.current = null
        // The ingest push is fire-and-forget server-side — poll briefly for
        // the freshly recorded invocation so "Open report" can deep-link.
        void (async () => {
          for (let i = 0; i < 5; i++) {
            await new Promise((res) => setTimeout(res, 600))
            const rows = await listInvocations({ limit: 1 }).catch(() => [])
            const newest = rows[0]?.runId ?? null
            if (newest !== null && newest !== prevNewestRef.current) {
              setRecordedRunId(newest)
              return
            }
          }
        })()
      },
      onError: (m) => {
        setRunError(m)
        setRunning(false)
        cancelRef.current = null
      },
    })
  }

  const stop = (): void => {
    cancelRef.current?.()
    cancelRef.current = null
    setRunning(false)
  }

  // Honest workspace gate: the capability probe tells us whether this serve
  // can actually plan + delegate runs — `version.workspace` is always set (it
  // falls back to the serve's cwd), so it can't be the signal.
  const workspaceMissing = capabilities.known && !capabilities.hasWorkspace
  const canRun =
    !running && taskSel.length > 0 && version.data?.workspace !== undefined && !workspaceMissing
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  const inspector = useResizable({ defaultSize: 400, minSizePx: 320, maxSizePx: 560 })

  // Selected-task accessors for the detail panel.
  const selectedStatus = selected !== null ? statuses.get(selected) : undefined
  const selectedState: VizState = selectedStatus?.state ?? 'queued'
  const selectedNode = selected !== null ? nodes.find((n) => n.id === selected) : undefined
  const selectedDuration = selected !== null ? durationOf(selected) : 0
  const selectedCpu = cpuPct(selectedStatus?.cpuMs, selectedDuration)
  const selectedWindow = selected !== null ? timing.get(selected) : undefined
  const selectedLog = selected !== null ? stripAnsi(logsRef.current.get(selected) ?? '') : ''

  // Log auto-follow: while the selected task streams, keep the tail in view —
  // but only when the user is already at the bottom (an IntersectionObserver
  // on a tail sentinel tracks that), so scrolling up to read is never yanked.
  const logEndRef = useRef<HTMLSpanElement | null>(null)
  const atBottomRef = useRef(true)
  useEffect(() => {
    const el = logEndRef.current
    if (el === null) return
    atBottomRef.current = true
    const io = new IntersectionObserver((entries) => {
      atBottomRef.current = entries[0]?.isIntersecting ?? true
    })
    io.observe(el)
    return () => io.disconnect()
  }, [selected, started])
  useEffect(() => {
    if (selectedState === 'running' && atBottomRef.current) {
      logEndRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedLog, selectedState])

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <HStack
            gap={3}
            vAlign="center"
            style={{ width: '100%', padding: 'var(--spacing-3) var(--spacing-5)' }}
          >
            <VStack gap={0}>
              <Heading level={2}>Cockpit</Heading>
              <Text type="supporting" color="secondary">
                Trigger tasks and watch their graph execute live
              </Text>
            </VStack>
            <HStack gap={2} vAlign="center" style={{ marginInlineStart: 'auto' }}>
              <StackItem style={{ width: 400 }}>
                <Tokenizer
                  label="Tasks to run"
                  isLabelHidden
                  size="sm"
                  value={taskSel}
                  onChange={(items) => setTaskSel(items)}
                  searchSource={taskSource}
                  placeholder="add tasks — build, test, pkg#task…"
                  hasCreate
                  hasEntriesOnFocus
                  hasClear
                  debounceMs={0}
                  isDisabled={workspaceMissing}
                  disabledMessage="This serve has no colocated workspace — runs are unavailable here."
                />
              </StackItem>
              <Button
                label={started ? 'Rerun' : 'Run'}
                variant="primary"
                size="sm"
                icon={<Icon icon={PlayIcon} size="sm" />}
                isDisabled={!canRun}
                isLoading={running}
                onClick={start}
              />
              {running && (
                <Button
                  label="Stop"
                  variant="secondary"
                  size="sm"
                  icon={<Icon icon={StopIcon} size="sm" />}
                  onClick={stop}
                />
              )}
            </HStack>
          </HStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0}>
          <VStack gap={0} style={{ height: '100%', minHeight: 0 }}>
            {started && (
              <HStack gap={3} vAlign="center" paddingInline={5} paddingBlock={2}>
                <StackItem size="fill">
                  <ProgressBar
                    label="Run progress"
                    isLabelHidden
                    value={pct}
                    variant={ok === false ? 'error' : ok === true ? 'success' : 'accent'}
                  />
                </StackItem>
                {predicted.total > 0 && predicted.anyQueued && (
                  <Tooltip content="predicted from cache keys — before execution">
                    <Token
                      size="sm"
                      color="cyan"
                      label={`${predicted.hits}/${predicted.total} predicted cached`}
                    />
                  </Tooltip>
                )}
                {running || ok === null ? (
                  <Text type="code" size="sm" color="secondary" hasTabularNumbers>
                    {progress.done}/{progress.total > 0 ? progress.total : '—'} · running
                  </Text>
                ) : (
                  // Finished: the run's composition at a glance, feed language.
                  <HStack gap={1} vAlign="center">
                    {tally.cached > 0 && (
                      <Token size="sm" color="cyan" label={`${tally.cached} cached`} />
                    )}
                    {tally.success > 0 && (
                      <Token size="sm" color="green" label={`${tally.success} executed`} />
                    )}
                    {tally.failed > 0 && (
                      <Token size="sm" color="red" label={`${tally.failed} failed`} />
                    )}
                    {tally.skipped > 0 && (
                      <Token size="sm" color="yellow" label={`${tally.skipped} skipped`} />
                    )}
                    <Text type="code" size="sm" color="secondary" hasTabularNumbers>
                      {fmtDur(parallel.spanMs)} · {ok ? 'passed' : 'failed'}
                    </Text>
                    {recordedRunId !== null && (
                      <Link href={`#/runs/${encodeURIComponent(recordedRunId)}`}>
                        <Text type="supporting" color="accent">
                          Open report →
                        </Text>
                      </Link>
                    )}
                  </HStack>
                )}
                <SegmentedControl label="View" size="sm" value={view} onChange={(v) => setView(v as 'graph' | 'flame')}>
                  <SegmentedControlItem label="Graph" value="graph" />
                  <SegmentedControlItem label="Flame" value="flame" />
                </SegmentedControl>
              </HStack>
            )}

            {runError !== null && <Banner status="error" title={runError} container="section" />}

            <StackItem size="fill" style={{ minHeight: 0, overflow: 'hidden' }}>
              {!started ? (
                workspaceMissing ? (
                  <EmptyState
                    title="This serve has no workspace"
                    description="Runs execute against a colocated workspace. Start the serve inside your repo to unlock the cockpit — this instance shows pushed run analytics only."
                    actions={<CodeBlock code="cd <your-repo> && vx-cloud serve --ui" size="sm" />}
                  />
                ) : (
                  <EmptyState
                    title="No run yet"
                    description="Pick tasks above (or tap one below) and press Run to watch the graph execute."
                    actions={
                      taskNames.length > 0 ? (
                        <HStack gap={1} wrap="wrap" hAlign="center">
                          {taskNames.slice(0, 8).map((t) => (
                            <Token
                              key={t}
                              size="sm"
                              color={taskSel.some((p) => p.label === t) ? 'purple' : 'default'}
                              label={t}
                              onClick={() => addTask(t)}
                            />
                          ))}
                        </HStack>
                      ) : (
                        <CodeBlock code="vx run <task>" size="sm" />
                      )
                    }
                  />
                )
              ) : view === 'flame' ? (
                flameRows.length > 0 ? (
                  <VStack gap={0} padding={2} style={{ height: '100%', minHeight: 0 }}>
                    <StackItem size="fill" style={{ minHeight: 0 }}>
                      <Flamegraph
                        tasks={flameRows}
                        selectedId={selected ?? undefined}
                        highlightIds={criticalSet}
                        edges={flameEdges}
                        onSelect={(t) => setSelected(`${t.project}#${t.task}`)}
                      />
                    </StackItem>
                  </VStack>
                ) : (
                  <EmptyState title="Waiting for tasks…" isCompact />
                )
              ) : nodes.length > 0 ? (
                <RunGraph
                  nodes={nodes}
                  states={stateMap}
                  durations={durationMap}
                  cpu={cpuMap}
                  criticalPath={criticalSet}
                  selected={selected}
                  onSelect={setSelected}
                />
              ) : (
                <EmptyState title="Resolving graph…" isCompact />
              )}
            </StackItem>
          </VStack>
        </LayoutContent>
      }
      end={
        started ? (
          <>
            <ResizeHandle
              direction="horizontal"
              hasDivider
              isAlwaysVisible={false}
              resizable={inspector.props}
              label="Resize run inspector"
            />
            <LayoutPanel width={inspector.size} padding={0} label="Run inspector">
              <VStack gap={0} style={{ height: '100%', minHeight: 0 }}>
                {/* Critical path + parallelism */}
                <VStack gap={0} style={{ maxHeight: '45%', minHeight: 0, overflow: 'hidden' }}>
                  <HStack gap={2} vAlign="center" paddingInline={3} paddingBlock={2}>
                    <Icon icon={ArrowTrendingUpIcon} size="sm" color="warning" />
                    <Text type="label" color="secondary">
                      Critical path
                    </Text>
                    <StackItem size="fill" />
                    {critical.chain.length > 0 && (
                      <Text type="code" size="sm" hasTabularNumbers style={{ color: 'var(--color-warning)' }}>
                        {fmtDur(critical.totalMs)}
                      </Text>
                    )}
                  </HStack>
                  <Divider />
                  <HStack gap={2} vAlign="center" paddingInline={3} paddingBlock={1.5}>
                    <Icon icon={FireIcon} size="xsm" color="accent" />
                    <Text type="supporting" size="2xs" color="secondary" hasTabularNumbers>
                      {parallel.maxConcurrent}
                      {concurrency !== undefined ? ` / ${concurrency}` : ''} peak parallel
                    </Text>
                    <StackItem size="fill" />
                    {parallel.spanMs > 0 && (
                      <Text type="supporting" size="2xs" color="secondary" hasTabularNumbers>
                        {Math.round((parallel.busyMs / parallel.spanMs) * 10) / 10}× avg
                      </Text>
                    )}
                  </HStack>
                  <Divider />
                  {critical.chain.length > 0 ? (
                    <StackItem size="fill" isScrollable style={{ minHeight: 0 }}>
                      <VStack gap={0}>
                        <HStack paddingInline={3} paddingBlock={1}>
                          <Text type="supporting" size="2xs" color="secondary">
                            {critical.chain.length === 1 ? 'This' : 'These'} {critical.chain.length}{' '}
                            task{critical.chain.length === 1 ? ' is' : 's are'} your{' '}
                            {fmtDur(critical.totalMs)} floor.
                          </Text>
                        </HStack>
                        <List density="compact">
                          {critical.chain.map((id, i) => {
                            const node = nodes.find((n) => n.id === id)
                            return (
                              <ListItem
                                key={id}
                                label={
                                  <HStack gap={1} vAlign="center">
                                    <Text type="code" size="sm" color="secondary" hasTabularNumbers>
                                      {i + 1}.
                                    </Text>
                                    <Text type="code" size="sm" style={{ color: TASK_COLOR }}>
                                      {node?.task ?? id}
                                    </Text>
                                  </HStack>
                                }
                                description={
                                  node !== undefined ? (
                                    <Text
                                      type="supporting"
                                      size="2xs"
                                      style={{ color: projectColor(node.project) }}
                                    >
                                      {node.project}
                                    </Text>
                                  ) : undefined
                                }
                                endContent={
                                  <Text type="code" size="sm" color="secondary" hasTabularNumbers>
                                    {fmtDur(durationOf(id))}
                                  </Text>
                                }
                                isSelected={selected === id}
                                onClick={() => setSelected(id)}
                              />
                            )
                          })}
                        </List>
                      </VStack>
                    </StackItem>
                  ) : (
                    <HStack paddingInline={3} paddingBlock={2}>
                      <Text type="supporting" color="secondary">
                        {started ? 'Computing…' : 'Run to see the wall-time floor.'}
                      </Text>
                    </HStack>
                  )}
                </VStack>

                <Divider />

                {/* Task detail: facts + output */}
                <StackItem size="fill" style={{ minHeight: 0 }}>
                  {selected === null ? (
                    <EmptyState
                      title="No task selected"
                      description="Click a node to view its details + output."
                      isCompact
                    />
                  ) : (
                    <VStack gap={0} style={{ height: '100%', minHeight: 0 }}>
                      <HStack gap={2} vAlign="center" paddingInline={3} paddingBlock={2}>
                        <StackItem size="fill" style={{ minWidth: 0 }}>
                          <TaskRef id={selected} maxLines={1} />
                        </StackItem>
                        <StatusCell state={selectedState} />
                      </HStack>
                      <Divider />
                      <VStack paddingInline={3} paddingBlock={2}>
                        <MetadataList columns={2} label={{ position: 'top' }}>
                          <MetadataListItem label="Duration">
                            <Text type="body" hasTabularNumbers>
                              {fmtDur(selectedDuration)}
                            </Text>
                          </MetadataListItem>
                          <MetadataListItem label="CPU">
                            <Text type="body" hasTabularNumbers>
                              {selectedCpu === undefined ? '—' : `${selectedCpu}%`}
                            </Text>
                          </MetadataListItem>
                          <MetadataListItem label="Peak RAM">
                            <Text type="body" hasTabularNumbers>
                              {selectedStatus?.peakRssBytes !== undefined
                                ? formatBytes(selectedStatus.peakRssBytes)
                                : '—'}
                            </Text>
                          </MetadataListItem>
                          <MetadataListItem label="Exit code">
                            <Text type="body" hasTabularNumbers>
                              {selectedStatus?.exitCode ?? '—'}
                            </Text>
                          </MetadataListItem>
                          <MetadataListItem label="Started">
                            <Text type="body" hasTabularNumbers>
                              {fmtClock(selectedWindow?.startedAt)}
                            </Text>
                          </MetadataListItem>
                          <MetadataListItem label="Ended">
                            <Text type="body" hasTabularNumbers>
                              {fmtClock(selectedWindow?.endedAt)}
                            </Text>
                          </MetadataListItem>
                          <MetadataListItem label="Project">
                            <Text type="body">{selectedNode?.project ?? '—'}</Text>
                          </MetadataListItem>
                        </MetadataList>
                      </VStack>
                      <Divider />
                      <HStack paddingInline={3} paddingBlock={1}>
                        <Text type="label" color="secondary">
                          Output
                        </Text>
                      </HStack>
                      <StackItem size="fill" isScrollable style={{ minHeight: 0 }}>
                        <CodeBlock
                          code={selectedLog === '' ? '— no output —' : selectedLog}
                          size="sm"
                          width="100%"
                          container="section"
                          isWrapped
                        />
                        {/* auto-follow tail sentinel (IntersectionObserver target) */}
                        <span ref={logEndRef} aria-hidden="true" />
                      </StackItem>
                    </VStack>
                  )}
                </StackItem>
              </VStack>
            </LayoutPanel>
          </>
        ) : undefined
      }
    />
  )
}
