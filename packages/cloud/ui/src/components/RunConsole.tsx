// The run cockpit: trigger a task, watch its DAG execute live, inspect logs.
//
// On Run we fetch the task graph (nodes + edges, predicted cache status) and
// open a WebSocket to vx serve; the streamed events drive each node's live
// status, an overall progress bar, and per-task log capture. Running while a
// run is in progress is forbidden (the Run button is disabled until it
// finishes) — one run at a time avoids the output-cleaning race between
// overlapping different-hash runs (docs/design/execution-service-2026-06.md).
// Stop abandons watching the current run so the UI can recover.

import { For, Show, batch, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js'
import { type GraphNode, type RunSummaryRow, type WireEvent, getGraph, getOrigin, getHistory, getVersion, runTasks } from '../api.ts'
import { criticalPath, parallelism } from './critical-path.ts'
import { Flamegraph as FlameView } from './Flamegraph.tsx'
import { RunGraph, type RunGraphState } from './RunGraph.tsx'
import { EmptyState } from './ui.tsx'

type NodeState = 'queued' | 'running' | 'success' | 'cache-hit' | 'failed' | 'skipped' | 'aborted'
interface NodeStatus {
  state: NodeState
  durationMs?: number
  exitCode?: number
}

function mapStatus(status: string): NodeState {
  if (status === 'failed') return 'failed'
  if (status === 'cache-hit' || status === 'cache-hit-remote') return 'cache-hit'
  if (status === 'skipped') return 'skipped'
  if (status === 'aborted') return 'aborted'
  return 'success'
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
const fmtDur = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`)

export function RunConsole() {
  const [version] = createResource(getOrigin, () => getVersion().catch(() => null))
  const [history] = createResource(getOrigin, () => getHistory({ limit: 300 }).catch(() => []))
  const taskNames = createMemo(() => Array.from(new Set((history() ?? []).map((h) => h.task))).sort())

  const [taskInput, setTaskInput] = createSignal('')
  const [nodes, setNodes] = createSignal<GraphNode[]>([])
  const [statuses, setStatuses] = createSignal<Record<string, NodeStatus>>({})
  // Per-task wall-clock window, observed from when each event arrives (the
  // outcome carries durationMs but cache hits have no wallclock ns) — enough to
  // draw a live flamegraph of the current run.
  const [timing, setTiming] = createSignal<Record<string, { startedAt: number; endedAt?: number }>>({})
  const [logs, setLogs] = createSignal<Record<string, string>>({})
  const [selected, setSelected] = createSignal<string | null>(null)
  const [running, setRunning] = createSignal(false)
  const [started, setStarted] = createSignal(false)
  const [view, setView] = createSignal<'graph' | 'flame'>('graph')
  const [now, setNow] = createSignal(0)
  const [progress, setProgress] = createSignal({ done: 0, total: 0 })
  const [runError, setRunError] = createSignal<string | null>(null)
  const [ok, setOk] = createSignal<boolean | null>(null)
  // Configured worker count from run:start (undefined if the server didn't send it).
  const [concurrency, setConcurrency] = createSignal<number | undefined>(undefined)

  let cancel: (() => void) | null = null
  onCleanup(() => cancel?.())
  // Ticks only while a run is live so in-progress flame bars grow.
  onMount(() => {
    const id = setInterval(() => running() && setNow(Date.now()), 250)
    onCleanup(() => clearInterval(id))
  })

  // Per-node duration (ms): the reported duration once complete, else the live
  // elapsed time for a running task, else 0 (queued). Recomputes as `now` ticks
  // so the critical path grows during the run and settles on completion.
  const durationOf = (id: string): number => {
    const st = statuses()[id]
    if (st?.durationMs !== undefined) return st.durationMs
    const t = timing()[id]
    if (t && st?.state === 'running') return Math.max(0, (t.endedAt ?? now()) - t.startedAt)
    return 0
  }

  // Longest-duration dependency chain (the wall-time floor) over the live graph.
  const critical = createMemo(() => {
    now() // track the tick so in-progress chains grow
    return criticalPath(nodes(), durationOf)
  })
  const criticalSet = createMemo(() => new Set(critical().chain))

  // Observed concurrency from the live per-task windows.
  const parallel = createMemo(() => {
    const tm = timing()
    const clock = now()
    const intervals = Object.values(tm).map((t) => ({ startedAt: t.startedAt, endedAt: t.endedAt ?? Math.max(clock, t.startedAt) }))
    return parallelism(intervals)
  })

  // Build flamegraph rows (RunSummaryRow shape) from live timing + status.
  const flameRows = createMemo<RunSummaryRow[]>(() => {
    const tm = timing()
    const st = statuses()
    const clock = now()
    return nodes()
      .filter((n) => tm[n.id])
      .map((n) => {
        const t = tm[n.id]!
        const state = st[n.id]?.state ?? 'running'
        const status = state === 'queued' ? 'running' : state
        const startedAt = t.startedAt
        const endedAt = t.endedAt ?? Math.max(clock, startedAt)
        return {
          runId: null,
          project: n.project,
          task: n.task,
          status,
          exitCode: st[n.id]?.exitCode ?? 0,
          durationMs: st[n.id]?.durationMs ?? endedAt - startedAt,
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

  function handleEvent(ev: WireEvent) {
    if (ev.kind === 'run:start') {
      setProgress({ done: 0, total: ev.info.total })
      setConcurrency(ev.info.concurrency)
    }
    else if (ev.kind === 'task:start') {
      setStatuses((p) => ({ ...p, [ev.task.id]: { state: 'running' } }))
      setTiming((p) => ({ ...p, [ev.task.id]: { startedAt: Date.now() } }))
    } else if (ev.kind === 'task:stdout' || ev.kind === 'task:stderr')
      setLogs((p) => ({ ...p, [ev.taskId]: (p[ev.taskId] ?? '') + ev.chunk }))
    else if (ev.kind === 'task:complete') {
      const end = Date.now()
      setStatuses((p) => ({
        ...p,
        [ev.outcome.taskId]: { state: mapStatus(ev.outcome.status), durationMs: ev.outcome.durationMs, exitCode: ev.outcome.exitCode },
      }))
      setTiming((p) => {
        const prev = p[ev.outcome.taskId]
        // Cache hits/instant tasks may complete without a start event — seed a
        // window from the reported duration so the bar still has width.
        const startedAt = prev?.startedAt ?? end - ev.outcome.durationMs
        return { ...p, [ev.outcome.taskId]: { startedAt, endedAt: end } }
      })
      setProgress((p) => ({ ...p, done: p.done + 1 }))
    }
  }

  function start() {
    if (running()) return // forbid running while a run is in progress
    const tasks = taskInput().split(/\s+/).filter(Boolean)
    const root = version()?.workspace
    if (tasks.length === 0 || !root) return
    batch(() => {
      setStatuses({})
      setTiming({})
      setLogs({})
      setSelected(null)
      setProgress({ done: 0, total: 0 })
      setRunError(null)
      setOk(null)
      setConcurrency(undefined)
      setNow(Date.now())
      setRunning(true)
      setStarted(true)
      setNodes([])
    })
    // Graph for layout/edges; merge so live events already received aren't clobbered.
    getGraph(tasks)
      .then((g) => {
        setNodes(g)
        setStatuses((prev) => {
          const next = { ...prev }
          for (const n of g) if (!next[n.id]) next[n.id] = { state: 'queued' }
          return next
        })
      })
      .catch(() => {})
    cancel = runTasks(tasks, root, {
      onEvent: handleEvent,
      onResult: (r) => {
        setRunning(false)
        setOk(r.ok)
        cancel = null
      },
      onError: (m) => {
        setRunError(m)
        setRunning(false)
        cancel = null
      },
    })
  }

  const canRun = () => !running() && taskInput().trim().length > 0 && version()?.workspace !== undefined
  const pct = () => {
    const p = progress()
    return p.total > 0 ? Math.round((p.done / p.total) * 100) : 0
  }

  return (
    <div class="flex flex-col gap-4 h-[calc(100vh-6.5rem)]">
      {/* Control bar */}
      <div class="flex items-center gap-3 flex-wrap">
        <div>
          <h1 class="text-lg font-semibold m-0 tracking-tight">Run</h1>
          <p class="text-fg-3 text-[12px] m-0 mt-0.5">Trigger a task and watch its graph execute live.</p>
        </div>
        <div class="flex-1" />
        <form
          class="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            start()
          }}
        >
          <input
            list="vx-task-names"
            placeholder="task name, e.g. lint or test"
            value={taskInput()}
            onInput={(e) => setTaskInput(e.currentTarget.value)}
            class="w-64 font-mono text-[13px]"
          />
          <datalist id="vx-task-names">
            <For each={taskNames()}>{(t) => <option value={t} />}</For>
          </datalist>
          <button
            type="submit"
            disabled={!canRun()}
            class="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-accent text-bg font-medium text-[13px] hover:brightness-110 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span class={running() ? 'i-tabler-refresh animate-spin' : 'i-tabler-player-play-filled'} />
            {started() ? 'Rerun' : 'Run'}
          </button>
          <Show when={running()}>
            <button
              type="button"
              onClick={() => {
                cancel?.()
                cancel = null
                setRunning(false)
              }}
              class="px-3 py-2 rounded-lg border border-border text-fg-2 hover:text-fg hover:border-border-strong text-[13px] transition"
            >
              Stop
            </button>
          </Show>
        </form>
      </div>

      {/* Progress */}
      <Show when={started()}>
        <div class="flex items-center gap-3">
          <div class="flex-1 h-2 rounded-full bg-surface-2 overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-300"
              classList={{
                'bg-danger': ok() === false,
                'bg-success': ok() === true,
                'bg-accent': ok() === null,
              }}
              style={{ width: `${pct()}%` }}
            />
          </div>
          <div class="text-[12px] font-mono text-fg-2 tabular-nums shrink-0">
            {progress().done}/{progress().total || '—'}
            <Show when={running()}> · running</Show>
            <Show when={!running() && ok() !== null}> · {ok() ? 'passed' : 'failed'}</Show>
          </div>
          <div class="flex items-center gap-0.5 shrink-0 rounded-lg border border-border bg-surface-2/50 p-0.5 text-[12px]">
            <For each={['graph', 'flame'] as const}>
              {(v) => (
                <button
                  onClick={() => setView(v)}
                  class="px-3 py-1 rounded-md transition capitalize"
                  classList={{ 'bg-surface-hover text-fg': view() === v, 'text-fg-3 hover:text-fg-2': view() !== v }}
                >
                  {v}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={runError()}>
        <div class="rounded-lg border border-danger/40 bg-danger/5 px-4 py-2.5 text-sm text-danger">{runError()}</div>
      </Show>

      {/* Graph + logs */}
      <Show
        when={started()}
        fallback={
          <div class="flex-1 rounded-xl border border-border bg-surface/40">
            <EmptyState title="No run yet" hint="Enter a task above and press Run to see its graph execute." cmd="vx run <task>" />
          </div>
        }
      >
        <div class="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 min-h-0">
          {/* DAG / flamegraph */}
          <div class="rounded-xl border border-border bg-surface/40 overflow-hidden min-h-0 relative">
            <Show when={view() === 'flame'}>
              <div class="overflow-auto p-5 h-full">
                <Show when={flameRows().length > 0} fallback={<div class="text-fg-3 text-sm p-4">Waiting for tasks…</div>}>
                  <FlameView
                    tasks={flameRows()}
                    selectedId={selected() ?? undefined}
                    highlightIds={criticalSet()}
                    onSelect={(t) => setSelected(`${t.project}#${t.task}`)}
                  />
                </Show>
              </div>
            </Show>
            <Show when={view() === 'graph'}>
              <Show when={nodes().length > 0} fallback={<div class="text-fg-3 text-sm p-4">Resolving graph…</div>}>
                <RunGraph
                  nodes={nodes()}
                  stateOf={(id) => (statuses()[id]?.state ?? 'queued') as RunGraphState}
                  durationOf={durationOf}
                  selectedId={selected()}
                  highlightIds={criticalSet()}
                  onSelect={setSelected}
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
                  <Show when={concurrency() !== undefined}>
                    <span class="text-fg-3"> / {concurrency()}</span>
                  </Show>
                  <span class="text-fg-3"> peak parallel</span>
                </span>
                <Show when={parallel().spanMs > 0}>
                  <span class="ml-auto text-fg-3 font-mono tabular-nums">{Math.round((parallel().busyMs / parallel().spanMs) * 10) / 10}× avg</span>
                </Show>
              </div>

              <Show
                when={critical().chain.length > 0}
                fallback={<div class="flex-1 grid place-items-center text-fg-3 text-[12px] p-4 text-center">{started() ? 'Computing…' : 'Run to see the wall-time floor.'}</div>}
              >
                <div class="overflow-auto min-h-0">
                  <div class="px-4 py-1.5 text-[10px] text-fg-3">
                    These {critical().chain.length} task{critical().chain.length === 1 ? '' : 's'} are your {fmtDur(critical().totalMs)} floor.
                  </div>
                  <For each={critical().chain}>
                    {(id, i) => {
                      const node = () => nodes().find((n) => n.id === id)
                      return (
                        <button
                          onClick={() => setSelected(id)}
                          class="w-full text-left px-4 py-1.5 flex items-center gap-2 hover:bg-surface-hover transition border-l-2"
                          classList={{ 'border-accent bg-accent/5': selected() === id, 'border-transparent': selected() !== id }}
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

            {/* Log panel */}
            <div class="rounded-xl border border-border bg-surface/40 flex flex-col flex-1 min-h-0 overflow-hidden">
              <div class="px-4 py-2.5 border-b border-border/70 flex items-center gap-2">
                <span class="i-tabler-terminal-2 text-fg-3" />
                <span class="text-[11px] font-semibold uppercase tracking-wider text-fg-2 truncate">
                  {selected() ? selected() : 'Logs'}
                </span>
              </div>
              <Show
                when={selected()}
                fallback={<div class="flex-1 grid place-items-center text-fg-3 text-[12px] p-4 text-center">Click a node to view its output.</div>}
              >
                <pre class="flex-1 overflow-auto m-0 p-4 text-[11px] leading-relaxed font-mono text-fg-1 whitespace-pre-wrap break-words">
                  {stripAnsi(logs()[selected()!] ?? '') || '— no output —'}
                </pre>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}
