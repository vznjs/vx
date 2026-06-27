// The run cockpit: trigger a task, watch its DAG execute live, inspect logs.
//
// On Run we fetch the task graph (nodes + edges, predicted cache status) and
// open a WebSocket to vx serve; the streamed events drive each node's live
// status, an overall progress bar, and per-task log capture. Running while a
// run is in progress is forbidden (the Run button is disabled until it
// finishes) — one run at a time avoids the output-cleaning race between
// overlapping different-hash runs (docs/design/execution-service-2026-06.md).
// Stop abandons watching the current run so the UI can recover.

import { For, Show, batch, createMemo, createResource, createSignal, onCleanup } from 'solid-js'
import { type GraphNode, type WireEvent, getGraph, getOrigin, getHistory, getVersion, runTasks } from '../api.ts'
import { layoutGraph } from '../run-graph-layout.ts'
import { EmptyState } from './ui.tsx'

const NODE_W = 178
const NODE_H = 56
const COL_GAP = 60
const ROW_GAP = 16

type NodeState = 'queued' | 'running' | 'success' | 'cache-hit' | 'failed' | 'skipped' | 'aborted'
interface NodeStatus {
  state: NodeState
  durationMs?: number
  exitCode?: number
}

const STATE_STYLE: Record<NodeState, string> = {
  queued: 'border-border bg-surface text-fg-3',
  running: 'border-accent/60 bg-accent/10 text-fg-1 shadow-glow',
  success: 'border-success/50 bg-success/10 text-fg-1',
  'cache-hit': 'border-cache-local/50 bg-cache-local/10 text-fg-1',
  failed: 'border-danger/60 bg-danger/10 text-fg-1',
  skipped: 'border-warn/50 bg-warn/10 text-fg-2',
  aborted: 'border-border bg-surface-2 text-fg-3',
}
const STATE_ICON: Record<NodeState, string> = {
  queued: 'i-tabler-circle-dashed text-fg-3',
  running: 'i-tabler-loader-2 animate-spin text-accent',
  success: 'i-tabler-circle-check text-success',
  'cache-hit': 'i-tabler-bolt text-cache-local',
  failed: 'i-tabler-circle-x text-danger',
  skipped: 'i-tabler-circle-minus text-warn',
  aborted: 'i-tabler-ban text-fg-3',
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
  const [logs, setLogs] = createSignal<Record<string, string>>({})
  const [selected, setSelected] = createSignal<string | null>(null)
  const [running, setRunning] = createSignal(false)
  const [started, setStarted] = createSignal(false)
  const [progress, setProgress] = createSignal({ done: 0, total: 0 })
  const [runError, setRunError] = createSignal<string | null>(null)
  const [ok, setOk] = createSignal<boolean | null>(null)

  let cancel: (() => void) | null = null
  onCleanup(() => cancel?.())

  const layout = createMemo(() => layoutGraph(nodes()))

  function handleEvent(ev: WireEvent) {
    if (ev.kind === 'run:start') setProgress({ done: 0, total: ev.info.total })
    else if (ev.kind === 'task:start') setStatuses((p) => ({ ...p, [ev.task.id]: { state: 'running' } }))
    else if (ev.kind === 'task:stdout' || ev.kind === 'task:stderr')
      setLogs((p) => ({ ...p, [ev.taskId]: (p[ev.taskId] ?? '') + ev.chunk }))
    else if (ev.kind === 'task:complete') {
      setStatuses((p) => ({
        ...p,
        [ev.outcome.taskId]: { state: mapStatus(ev.outcome.status), durationMs: ev.outcome.durationMs, exitCode: ev.outcome.exitCode },
      }))
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
      setLogs({})
      setSelected(null)
      setProgress({ done: 0, total: 0 })
      setRunError(null)
      setOk(null)
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
          {/* DAG */}
          <div class="rounded-xl border border-border bg-surface/40 overflow-auto p-5 min-h-0">
            <Show when={nodes().length > 0} fallback={<div class="text-fg-3 text-sm p-4">Resolving graph…</div>}>
              <div
                class="relative"
                style={{
                  width: `${layout().layerCount * (NODE_W + COL_GAP)}px`,
                  height: `${Math.max(1, layout().maxRows) * (NODE_H + ROW_GAP)}px`,
                }}
              >
                {/* edges */}
                <svg class="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
                  <For each={nodes()}>
                    {(n) => {
                      const to = () => layout().nodes.get(n.id)
                      return (
                        <For each={n.deps}>
                          {(depId) => {
                            const from = () => layout().nodes.get(depId)
                            return (
                              <Show when={from() && to()}>
                                {(() => {
                                  const sx = from()!.layer * (NODE_W + COL_GAP) + NODE_W
                                  const sy = from()!.row * (NODE_H + ROW_GAP) + NODE_H / 2
                                  const tx = to()!.layer * (NODE_W + COL_GAP)
                                  const ty = to()!.row * (NODE_H + ROW_GAP) + NODE_H / 2
                                  const mx = (sx + tx) / 2
                                  return (
                                    <path
                                      d={`M ${sx},${sy} C ${mx},${sy} ${mx},${ty} ${tx},${ty}`}
                                      fill="none"
                                      class="stroke-border-strong"
                                      stroke-width="1.5"
                                    />
                                  )
                                })()}
                              </Show>
                            )
                          }}
                        </For>
                      )
                    }}
                  </For>
                </svg>
                {/* nodes */}
                <For each={nodes()}>
                  {(n) => {
                    const pos = () => layout().nodes.get(n.id)
                    const st = () => statuses()[n.id]?.state ?? 'queued'
                    return (
                      <Show when={pos()}>
                        <button
                          onClick={() => setSelected(n.id)}
                          class={`absolute rounded-lg border px-3 py-2 text-left transition-all flex flex-col justify-center gap-0.5 ${STATE_STYLE[st()]}`}
                          classList={{ 'ring-2 ring-accent ring-offset-2 ring-offset-bg': selected() === n.id }}
                          style={{
                            left: `${pos()!.layer * (NODE_W + COL_GAP)}px`,
                            top: `${pos()!.row * (NODE_H + ROW_GAP)}px`,
                            width: `${NODE_W}px`,
                            height: `${NODE_H}px`,
                          }}
                          title={n.id}
                        >
                          <div class="flex items-center gap-1.5 min-w-0">
                            <span class={`${STATE_ICON[st()]} text-sm shrink-0`} />
                            <span class="font-mono text-[12px] truncate">{n.task}</span>
                          </div>
                          <div class="flex items-center gap-1.5 text-[10px] text-fg-3 font-mono">
                            <span class="truncate">{n.project}</span>
                            <Show when={statuses()[n.id]?.durationMs !== undefined}>
                              <span class="ml-auto shrink-0">{fmtDur(statuses()[n.id]?.durationMs)}</span>
                            </Show>
                          </div>
                        </button>
                      </Show>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>

          {/* Log panel */}
          <div class="rounded-xl border border-border bg-surface/40 flex flex-col min-h-0 overflow-hidden">
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
      </Show>
    </div>
  )
}
