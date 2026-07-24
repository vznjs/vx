// The reusable live-run session, extracted from the old /run cockpit
// (RunConsole) so the unified Runs view can embed one per active job
// (cloud-data-model-2026-07 §7.4). Two halves:
//
//   createRunSession(tasks) — the per-run STATE + event reducer (statuses /
//   timing / logs stores, progress, the live ticker, the graph fetch). It
//   lives OUTSIDE the component tree so events keep landing while the row is
//   collapsed; expanding just renders the current state.
//
//   <RunSession session={…}> — the live layout: progress bar, graph/flame
//   toggle, critical path + parallelism, per-task facts + logs. It consumes
//   RunGraph / Flamegraph strictly through their existing props.
//
// Live state lives in solid STORES keyed by task id — a chatty task streaming
// thousands of stdout chunks updates only its own key, instead of cloning the
// whole record per chunk and re-rendering every subscriber.

import { For, Show, createMemo, createSignal, type Accessor, type Setter } from 'solid-js'
import { createStore } from 'solid-js/store'
import { type GraphNode, type RunSummaryRow, type WireEvent, getGraph } from '../api.ts'
import { cpuPct, formatBytes, formatDuration, formatTime } from '../format.ts'
import { criticalPath, parallelism } from './critical-path.ts'
import { Flamegraph as FlameView, flameEdgesOf } from './Flamegraph.tsx'
import { RunGraph } from './RunGraph.tsx'
import { STATUS, toVizState, type VizState } from './status.tsx'
import { SegmentedToggle } from './ui.tsx'

const fmtClock = (ms?: number): string => (ms === undefined ? '—' : formatTime(ms))
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
// One duration formatter everywhere (format.ts) — shows ms / s / m / h so the
// session never disagrees with the charts/tables on a long task.
const fmtDur = (ms?: number) => (ms === undefined ? '—' : formatDuration(ms))

interface NodeStatus {
  state: VizState
  durationMs?: number
  exitCode?: number
  cpuMs?: number
  peakRssBytes?: number
}

interface TaskTiming {
  startedAt: number
  endedAt?: number
}

export interface RunSessionState {
  readonly tasks: readonly string[]
  nodes: Accessor<GraphNode[]>
  statuses: Record<string, NodeStatus>
  timing: Record<string, TaskTiming>
  logs: Record<string, string>
  now: Accessor<number>
  progress: Accessor<{ done: number; total: number }>
  concurrency: Accessor<number | undefined>
  running: Accessor<boolean>
  ok: Accessor<boolean | null>
  error: Accessor<string | null>
  selected: Accessor<string | null>
  setSelected: Setter<string | null>
  /** Feed one wire event into the reducer (kept flowing while collapsed). */
  handleEvent: (ev: WireEvent) => void
  /** queue:start — fetch the graph (layout + predicted cache) + begin ticking. */
  start: () => void
  /** The run's result frame landed. */
  finish: (ok: boolean) => void
  fail: (message: string) => void
  /** Stop the ticker; safe to call twice (finish/fail already do). */
  dispose: () => void
}

export function createRunSession(tasks: readonly string[]): RunSessionState {
  const [nodes, setNodes] = createSignal<GraphNode[]>([])
  const [statuses, setStatuses] = createStore<Record<string, NodeStatus>>({})
  // Per-task wall-clock window, observed from when each event arrives (the
  // outcome carries durationMs but cache hits have no wallclock ns) — enough
  // to draw a live flamegraph of the current run.
  const [timing, setTiming] = createStore<Record<string, TaskTiming>>({})
  const [logs, setLogs] = createStore<Record<string, string>>({})
  const [now, setNow] = createSignal(Date.now())
  const [progress, setProgress] = createSignal({ done: 0, total: 0 })
  const [concurrency, setConcurrency] = createSignal<number | undefined>(undefined)
  const [running, setRunning] = createSignal(false)
  const [ok, setOk] = createSignal<boolean | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [selected, setSelected] = createSignal<string | null>(null)

  // Plain interval (not a component effect — the session outlives collapse):
  // ticks only while the run is live so in-progress flame bars grow.
  let ticker: ReturnType<typeof setInterval> | null = null
  const stopTicker = () => {
    if (ticker !== null) clearInterval(ticker)
    ticker = null
  }

  const handleEvent = (ev: WireEvent): void => {
    if (ev.kind === 'run:start') {
      setProgress({ done: 0, total: ev.info.total })
      setConcurrency(ev.info.concurrency)
    } else if (ev.kind === 'task:start') {
      setStatuses(ev.task.id, { state: 'running' })
      setTiming(ev.task.id, { startedAt: Date.now() })
    } else if (ev.kind === 'task:stdout' || ev.kind === 'task:stderr') {
      // Append in place — only this task's key updates (no whole-record clone).
      setLogs(ev.taskId, (p) => (p ?? '') + ev.chunk)
    } else if (ev.kind === 'task:complete') {
      const end = Date.now()
      setStatuses(ev.outcome.taskId, {
        state: toVizState(ev.outcome.status),
        durationMs: ev.outcome.durationMs,
        exitCode: ev.outcome.exitCode,
        cpuMs: ev.outcome.cpuMs,
        peakRssBytes: ev.outcome.peakRssBytes,
      })
      setTiming(ev.outcome.taskId, (prev) => ({
        // Cache hits/instant tasks may complete without a start event — seed a
        // window from the reported duration so the bar still has width.
        startedAt: prev?.startedAt ?? end - ev.outcome.durationMs,
        endedAt: end,
      }))
      setProgress((p) => ({ ...p, done: p.done + 1 }))
    }
  }

  return {
    tasks,
    nodes,
    statuses,
    timing,
    logs,
    now,
    progress,
    concurrency,
    running,
    ok,
    error,
    selected,
    setSelected,
    handleEvent,
    start: () => {
      setNow(Date.now())
      setRunning(true)
      ticker ??= setInterval(() => setNow(Date.now()), 250)
      // Graph for layout/edges + predicted cache status; merge so live events
      // already received aren't clobbered.
      getGraph(tasks)
        .then((g) => {
          setNodes(g)
          for (const n of g) if (!statuses[n.id]) setStatuses(n.id, { state: 'queued' })
        })
        .catch(() => {})
    },
    finish: (result) => {
      setRunning(false)
      setOk(result)
      stopTicker()
    },
    fail: (message) => {
      setRunning(false)
      setError(message)
      stopTicker()
    },
    dispose: stopTicker,
  }
}

export function RunSession(props: { session: RunSessionState }) {
  const s = () => props.session
  const [view, setView] = createSignal<'graph' | 'flame'>('graph')

  // Per-node duration (ms): the reported duration once complete, else the live
  // elapsed time for a running task, else 0 (queued). Recomputes as `now`
  // ticks so the critical path grows during the run and settles on completion.
  const durationOf = (id: string): number => {
    const st = s().statuses[id]
    if (st?.durationMs !== undefined) return st.durationMs
    const t = s().timing[id]
    if (t && st?.state === 'running') return Math.max(0, (t.endedAt ?? s().now()) - t.startedAt)
    return 0
  }

  // A cache HIT restores ahead of its deps (the two-tier scheduler's restore
  // tier), so it doesn't wait for them — exclude it from the dependency-timing
  // chain or the floor counts upstream runtime the hit never waited for.
  const restoresAhead = (id: string): boolean => {
    const state = s().statuses[id]?.state
    return state === 'cache-hit' || state === 'cache-hit-remote'
  }

  // Longest-duration dependency chain (the wall-time floor) over COMPLETED
  // durations only. Deliberately NOT the live elapsed times: growing
  // in-progress durations made the longest chain flip between candidates
  // every 250ms tick, flashing the yellow highlight across different nodes
  // mid-run. Completed-only recomputes once per task completion — stable,
  // still live, and it settles on the true critical path at run end.
  const completedDurationOf = (id: string): number => s().statuses[id]?.durationMs ?? 0
  const critical = createMemo(() => criticalPath(s().nodes(), completedDurationOf, restoresAhead))
  const criticalSet = createMemo(() => new Set(critical().chain))

  // Predicted-from-cache summary (real tasks only; groups do no work). Shown
  // while queued nodes still exist — "N of M will restore" before work lands.
  const predicted = createMemo(() => {
    const real = s().nodes().filter((n) => !n.isGroup)
    const hits = real.filter((n) => n.cacheStatus === 'hit-local' || n.cacheStatus === 'hit-remote')
    const queued = real.filter((n) => (s().statuses[n.id]?.state ?? 'queued') === 'queued')
    return { total: real.length, hits: hits.length, anyQueued: queued.length > 0 }
  })

  // Selected-task accessors for the detail panel.
  const selectedStatus = (): NodeStatus | undefined => {
    const id = s().selected()
    return id !== null ? s().statuses[id] : undefined
  }
  const selectedState = (): VizState => selectedStatus()?.state ?? 'queued'
  const selectedCpuPct = (): number | undefined => {
    const id = s().selected()
    return cpuPct(selectedStatus()?.cpuMs, id !== null ? durationOf(id) : 0)
  }

  // Observed concurrency from the live per-task windows.
  const parallel = createMemo(() => {
    const clock = s().now()
    const intervals = Object.values(s().timing).map((t) => ({
      startedAt: t.startedAt,
      endedAt: t.endedAt ?? Math.max(clock, t.startedAt),
    }))
    return parallelism(intervals)
  })

  // Build flamegraph rows (RunSummaryRow shape) from live timing + status.
  const flameRows = createMemo<RunSummaryRow[]>(() => {
    const clock = s().now()
    return s()
      .nodes()
      // Groups (umbrella tasks) emit task events but do no work — exclude them
      // from the timeline entirely; the flame is about real execution windows.
      .filter((n) => s().timing[n.id] && !n.isGroup)
      .map((n) => {
        const t = s().timing[n.id]!
        const state = s().statuses[n.id]?.state ?? 'running'
        const status = state === 'queued' ? 'running' : state
        const startedAt = t.startedAt
        const endedAt = t.endedAt ?? Math.max(clock, startedAt)
        return {
          runId: null,
          project: n.project,
          task: n.task,
          status,
          exitCode: s().statuses[n.id]?.exitCode ?? 0,
          durationMs: s().statuses[n.id]?.durationMs ?? endedAt - startedAt,
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
  })

  // Dependency edges for the flame (dep → dependent = "what this unlocked").
  const flameEdges = createMemo(() => flameEdgesOf(s().nodes()))

  const pct = () => {
    const p = s().progress()
    return p.total > 0 ? Math.round((p.done / p.total) * 100) : 0
  }

  return (
    <div class="flex flex-col gap-3 h-full min-h-0">
      {/* Progress */}
      <div class="flex items-center gap-3">
        <div class="flex-1 h-2 rounded-full bg-surface-2 overflow-hidden">
          <div
            class="h-full rounded-full transition-all duration-300"
            classList={{
              'bg-danger': s().ok() === false,
              'bg-success': s().ok() === true,
              'bg-accent': s().ok() === null,
            }}
            style={{ width: `${pct()}%` }}
          />
        </div>
        <Show when={predicted().total > 0 && predicted().anyQueued}>
          <span class="text-[11px] font-mono text-cache-local tabular-nums shrink-0 inline-flex items-center gap-1" title="predicted from cache keys — before execution">
            <span class="i-tabler-bolt" aria-hidden="true" />
            {predicted().hits}/{predicted().total} predicted cached
          </span>
        </Show>
        <div class="text-[12px] font-mono text-fg-2 tabular-nums shrink-0">
          {s().progress().done}/{s().progress().total || '—'}
          <Show when={s().running()}> · running</Show>
          <Show when={!s().running() && s().ok() !== null}> · {s().ok() ? 'passed' : 'failed'}</Show>
        </div>
        <SegmentedToggle options={['graph', 'flame'] as const} value={view()} onChange={setView} />
      </div>

      <Show when={s().error()}>
        <div class="rounded-lg border border-danger/40 bg-danger/5 px-4 py-2.5 text-sm text-danger">{s().error()}</div>
      </Show>

      {/* Graph + logs */}
      <div class="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 min-h-0">
        {/* DAG / flamegraph */}
        <div class="rounded-xl border border-border bg-surface/40 overflow-hidden min-h-0 relative">
          <Show when={view() === 'flame'}>
            <div class="h-full p-2">
              <Show when={flameRows().length > 0} fallback={<div class="text-fg-3 text-sm p-4">Waiting for tasks…</div>}>
                <FlameView
                  tasks={flameRows()}
                  selectedId={s().selected() ?? undefined}
                  highlightIds={criticalSet()}
                  edges={flameEdges()}
                  onSelect={(t) => s().setSelected(`${t.project}#${t.task}`)}
                />
              </Show>
            </div>
          </Show>
          <Show when={view() === 'graph'}>
            <Show when={s().nodes().length > 0} fallback={<div class="text-fg-3 text-sm p-4">Resolving graph…</div>}>
              <RunGraph
                nodes={s().nodes()}
                stateOf={(id) => s().statuses[id]?.state ?? 'queued'}
                statsOf={(id) => ({
                  durationMs: durationOf(id),
                  cpuMs: s().statuses[id]?.cpuMs,
                  peakRssBytes: s().statuses[id]?.peakRssBytes,
                })}
                predictedOf={(id) => s().nodes().find((n) => n.id === id)?.cacheStatus}
                selectedId={s().selected()}
                highlightIds={criticalSet()}
                onSelect={s().setSelected}
              />
            </Show>
          </Show>
        </div>

        {/* Right column: critical path + parallelism, then logs */}
        <div class="flex flex-col gap-4 min-h-0">
          {/* Critical path + parallelism */}
          <div class="rounded-xl border border-border bg-surface/40 flex flex-col overflow-hidden shrink-0 max-h-[45%]">
            <div class="px-4 py-2.5 border-b border-border/70 flex items-center gap-2">
              <span class="i-tabler-route text-warn" />
              <span class="text-[11px] font-semibold uppercase tracking-wider text-fg-2">Critical path</span>
              <Show when={critical().chain.length > 0}>
                <span class="ml-auto text-[11px] font-mono text-warn tabular-nums">{fmtDur(critical().totalMs)}</span>
              </Show>
            </div>

            {/* Parallelism callout */}
            <div class="px-4 py-2 border-b border-border/70 flex items-center gap-3 text-[11px] text-fg-2">
              <span class="i-tabler-arrows-split-2 text-accent shrink-0" />
              <span class="font-mono tabular-nums">
                <span class="text-fg-1 font-semibold">{parallel().maxConcurrent}</span>
                <Show when={s().concurrency() !== undefined}>
                  <span class="text-fg-3"> / {s().concurrency()}</span>
                </Show>
                <span class="text-fg-3"> peak parallel</span>
              </span>
              <Show when={parallel().spanMs > 0}>
                <span class="ml-auto text-fg-3 font-mono tabular-nums">{Math.round((parallel().busyMs / parallel().spanMs) * 10) / 10}× avg</span>
              </Show>
            </div>

            <Show
              when={critical().chain.length > 0}
              fallback={<div class="flex-1 grid place-items-center text-fg-3 text-[12px] p-4 text-center">Computing…</div>}
            >
              <div class="overflow-auto min-h-0">
                <div class="px-4 py-1.5 text-[10px] text-fg-3">
                  {critical().chain.length === 1 ? 'This' : 'These'} {critical().chain.length} task{critical().chain.length === 1 ? ' is' : 's are'} your {fmtDur(critical().totalMs)} floor.
                </div>
                <For each={critical().chain}>
                  {(id, i) => {
                    const node = () => s().nodes().find((n) => n.id === id)
                    return (
                      <button
                        onClick={() => s().setSelected(id)}
                        class="w-full text-left px-4 py-1.5 flex items-center gap-2 hover:bg-surface-hover transition border-l-2"
                        classList={{ 'border-accent bg-accent/5': s().selected() === id, 'border-transparent': s().selected() !== id }}
                      >
                        <span class="text-[10px] text-fg-3 font-mono w-4 shrink-0 tabular-nums">{i() + 1}</span>
                        <span class="font-mono text-[12px] text-fg-1 truncate">{node()?.task ?? id}</span>
                        <span class="text-[10px] text-fg-3 font-mono truncate hidden sm:inline">{node()?.project}</span>
                        <span class="ml-auto text-[11px] font-mono text-fg-2 tabular-nums shrink-0">{fmtDur(durationOf(id))}</span>
                      </button>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>

          {/* Task detail panel: facts + logs */}
          <div class="rounded-xl border border-border bg-surface/40 flex flex-col flex-1 min-h-0 overflow-hidden">
            <div class="px-4 py-2.5 border-b border-border/70 flex items-center gap-2">
              <Show when={s().selected()} fallback={<span class="i-tabler-info-circle text-fg-3" />}>
                <span class={`${STATUS[selectedState()].icon} ${STATUS[selectedState()].dot} shrink-0`} classList={{ 'animate-spin': selectedState() === 'running' }} />
              </Show>
              <span class="text-[11px] font-semibold uppercase tracking-wider text-fg-2 truncate">
                {s().selected() ?? 'Task details'}
              </span>
            </div>
            <Show
              when={s().selected()}
              fallback={<div class="flex-1 grid place-items-center text-fg-3 text-[12px] p-4 text-center">Click a node to view its details + output.</div>}
            >
              {/* Facts grid */}
              <div class="px-4 py-3 border-b border-border/70 grid grid-cols-2 gap-x-5 gap-y-2 text-[11px] shrink-0">
                <Fact label="Status">
                  <span class={`inline-flex items-center gap-1 ${STATUS[selectedState()].dot}`}>
                    <span class={`${STATUS[selectedState()].icon}`} classList={{ 'animate-spin': selectedState() === 'running' }} />
                    {STATUS[selectedState()].label}
                  </span>
                </Fact>
                <Fact label="Duration">{fmtDur(durationOf(s().selected()!))}</Fact>
                <Fact label="CPU">{selectedCpuPct() === undefined ? '—' : `${selectedCpuPct()}%`}</Fact>
                <Fact label="Peak RAM">{selectedStatus()?.peakRssBytes !== undefined ? formatBytes(selectedStatus()!.peakRssBytes!) : '—'}</Fact>
                <Fact label="Started">{fmtClock(s().timing[s().selected()!]?.startedAt)}</Fact>
                <Fact label="Ended">{fmtClock(s().timing[s().selected()!]?.endedAt)}</Fact>
                <Fact label="Exit code">{selectedStatus()?.exitCode ?? '—'}</Fact>
                <Fact label="Project">{s().nodes().find((n) => n.id === s().selected())?.project ?? '—'}</Fact>
              </div>
              {/* Logs */}
              <div class="px-4 pt-2 pb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-fg-3 shrink-0">
                <span class="i-tabler-terminal-2" />
                output
              </div>
              <pre class="flex-1 overflow-auto m-0 px-4 pb-4 text-[11px] leading-relaxed font-mono text-fg-1 whitespace-pre-wrap break-words">
                {stripAnsi(s().logs[s().selected()!] ?? '') || '— no output —'}
              </pre>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}

function Fact(props: { label: string; children: import('solid-js').JSX.Element }) {
  return (
    <div class="flex flex-col gap-0.5 min-w-0">
      <span class="text-[10px] uppercase tracking-wider text-fg-3">{props.label}</span>
      <span class="font-mono text-fg-1 truncate tabular-nums">{props.children}</span>
    </div>
  )
}
