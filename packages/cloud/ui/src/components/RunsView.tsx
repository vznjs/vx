// THE one Runs surface (cloud-data-model-2026-07 §7.4): spawn bar + the
// queued/live section + the historical invocations table, in one view.
// "Trigger MULTIPLE" = queue multiple — each press of Run submits another
// job over its own WebSocket (queueRun); the serve's FIFO queue serializes
// execution and streams each job's lifecycle + events back on the
// submitting socket. The running job expands inline into the extracted
// RunSession (live graph/flame, critical path, logs); on queue:done the row
// collapses, links to /runs/:runId, and the history table refetches.
//
// Active jobs + their sessions live at MODULE scope so navigating away and
// back doesn't drop the sockets or the live state — the SPA never reloads,
// and a queued job's socket must stay open (closing it cancels the job).

import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import { A } from '@solidjs/router'
import type { BaseComponentProps } from '@json-render/solid'
import {
  type QueueJobRow,
  fetchCatalogTasks,
  fetchQueue,
  getCapabilitiesSignal,
  getConnectionKey,
  getHistory,
  getVersion,
  listInvocations,
  queueRun,
} from '../api.ts'
import { DataTable, type Column } from '../jr/components.tsx'
import { Card, EmptyState } from './ui.tsx'
import { RunSession, createRunSession, type RunSessionState } from './RunSession.tsx'

type JobState = 'submitting' | 'queued' | 'running' | 'done' | 'refused'

interface ActiveJob {
  /** Local identity — the serve's jobId only arrives at queue:accepted. */
  key: number
  jobId: string | null
  tasks: readonly string[]
  state: JobState
  position: number
  ok: boolean | null
  runId?: string
  error?: string
  session: RunSessionState
  cancel: () => void
}

// Module scope: jobs (and their sockets/sessions) outlive route changes.
let nextKey = 1
const [active, setActive] = createStore<{ list: ActiveJob[] }>({ list: [] })
const [expandedKey, setExpandedKey] = createSignal<number | null>(null)
// Bumped on every queue:done so the history resource refetches — a module
// signal, not a captured `refetch`, so a done landing after the view
// unmounted can't poke a disposed resource.
const [historyVersion, setHistoryVersion] = createSignal(0)

function patchJob(key: number, patch: Partial<ActiveJob>): void {
  setActive('list', (j) => j.key === key, patch)
}

function removeJob(key: number): void {
  const job = active.list.find((j) => j.key === key)
  job?.session.dispose()
  setActive('list', (l) => l.filter((j) => j.key !== key))
  if (expandedKey() === key) setExpandedKey(null)
}

/** Wrap plain props as a json-render component context — the two-way catalog
 *  path: DataTable consumed directly from JSX. The getter keeps reads live. */
function jrCtx<P>(get: () => P): BaseComponentProps<P> {
  return {
    get props() {
      return get()
    },
    emit: () => {},
    on: () => ({ emit: () => {}, shouldPreventDefault: false, bound: false }),
  }
}

// The old views/runs.json table, plus the merged-in compare action (§4.2:
// the separate "Compare to previous" table became a per-row icon).
const HISTORY_COLUMNS: Column[] = [
  { key: 'runId', label: 'Run', kind: 'shorthash', len: 8 },
  { key: 'startedAt', label: 'Started', align: 'right', kind: 'relativeTime', baseTone: 'faint', sortable: true },
  { key: 'branch', label: 'Branch', baseTone: 'muted' },
  { key: 'commitSha', label: 'Commit', kind: 'shorthash', len: 8 },
  { key: '_ci', label: 'CI', kind: 'dots', dots: [{ field: '_ciToken', map: 'failureMode' }] },
  { key: '_tags', label: 'Tags', baseTone: 'faint' },
  { key: 'totalDurationMs', label: 'Duration', align: 'right', kind: 'duration', sortable: true },
  { key: 'taskCount', label: 'Tasks', align: 'right', sortable: true },
  { key: 'failedCount', label: 'Failed', align: 'right', tone: { gt: 0, tone: 'danger' }, sortable: true },
  { key: 'hitCount', label: 'Hits', align: 'right', baseTone: 'cache', sortable: true },
  { key: '_compare', label: '', kind: 'link', href: '/compare/{runId}', linkLabel: '⇄ compare' },
]

// Tags object { k: v } → "k=v, …" (empty string when no tags).
function tagsText(tags: Record<string, string> | undefined): string {
  if (!tags || typeof tags !== 'object') return ''
  return Object.entries(tags)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
}

export function RunsView() {
  const capabilities = getCapabilitiesSignal()
  const [version] = createResource(getConnectionKey, () => getVersion().catch(() => null))

  // Datalist names: the workspace catalog when this serve has one (§6.5),
  // else history-derived names (the pre-catalog fallback).
  const [catalogTasks] = createResource(
    () => (capabilities().known && capabilities().catalog ? getConnectionKey() : null),
    () => fetchCatalogTasks().catch(() => null),
  )
  const [history] = createResource(getConnectionKey, () => getHistory({ limit: 300 }).catch(() => []))
  const taskNames = createMemo(() => {
    const catalog = catalogTasks()
    const names = catalog
      ? catalog.tasks.map((t) => t.task)
      : (history() ?? []).map((h) => h.task)
    return Array.from(new Set(names)).sort()
  })

  // Historical invocations (refetches when a queued job completes).
  const [invocations] = createResource(
    () => `${getConnectionKey()}|${historyVersion()}`,
    () => listInvocations(200),
  )
  const historyRows = createMemo<Record<string, unknown>[]>(() =>
    (invocations() ?? []).map((r) => ({
      ...r,
      _ciToken: r.ci ? 'stable' : 'cold',
      _ci: r.ci ? 'CI' : 'local',
      _tags: tagsText(r.tags),
    })),
  )
  const historyStatus = () =>
    invocations.error ? ('error' as const) : invocations() === undefined ? ('loading' as const) : ('ok' as const)

  // Serve-side queue state, polled at 2s while the view is mounted (an
  // in-memory read) — surfaces FOREIGN jobs too (CLI delegations, other
  // dashboards) as state-only rows.
  const [queueJobs, setQueueJobs] = createSignal<QueueJobRow[]>([])
  onMount(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      try {
        setQueueJobs(await fetchQueue())
      } catch {
        setQueueJobs([])
      }
      if (stopped) return
      timer = setTimeout(() => void tick(), 2000)
    }
    void tick()
    onCleanup(() => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    })
  })

  const ownJobIds = createMemo(() => {
    const ids = new Set<string>()
    for (const j of active.list) if (j.jobId !== null) ids.add(j.jobId)
    return ids
  })
  const foreignJobs = createMemo(() => queueJobs().filter((q) => !ownJobIds().has(q.jobId)))
  const waitingCount = createMemo(
    () =>
      active.list.filter((j) => j.state === 'queued' || j.state === 'submitting').length +
      foreignJobs().filter((q) => q.state === 'queued').length,
  )
  const anyActive = () => active.list.length > 0 || foreignJobs().length > 0

  const [taskInput, setTaskInput] = createSignal('')

  // Honest workspace gate: the capability probe tells us whether this serve
  // can actually plan + execute runs — `version().workspace` is always set
  // (it falls back to the serve's cwd), so it can't be the signal.
  const workspaceMissing = () => capabilities().known && !capabilities().hasWorkspace
  const canRun = () =>
    taskInput().trim().length > 0 && version()?.workspace !== undefined && !workspaceMissing()

  function spawn(): void {
    const tasks = taskInput().split(/\s+/).filter(Boolean)
    const root = version()?.workspace
    if (tasks.length === 0 || root === undefined || workspaceMissing()) return
    const key = nextKey++
    const session = createRunSession(tasks)
    const handle = queueRun(tasks, root, {
      onAccepted: (jobId, position) => patchJob(key, { jobId, state: 'queued', position }),
      onPosition: (position) => patchJob(key, { position }),
      onStart: () => {
        patchJob(key, { state: 'running', position: 0 })
        session.start()
        // Only one job runs at a time — the running one owns the expansion.
        setExpandedKey(key)
      },
      onEvent: session.handleEvent,
      onResult: (ok) => session.finish(ok),
      onDone: (ok, runId) => {
        patchJob(key, { state: 'done', ok, ...(runId !== undefined ? { runId } : {}) })
        session.finish(ok)
        if (expandedKey() === key) setExpandedKey(null)
        setHistoryVersion((v) => v + 1)
      },
      onRefused: (message) => {
        patchJob(key, { state: 'refused', error: message })
        session.fail(message)
      },
      onError: (message) => {
        patchJob(key, { state: 'refused', error: message })
        session.fail(message)
      },
    })
    setActive('list', (l) => [
      ...l,
      {
        key,
        jobId: null,
        tasks,
        state: 'submitting' as JobState,
        position: 0,
        ok: null,
        session,
        cancel: handle.cancel,
      },
    ])
  }

  return (
    <div class="flex flex-col gap-4">
      {/* Spawn bar */}
      <div class="flex items-center gap-3 flex-wrap">
        <div>
          <h1 class="text-lg font-semibold m-0 tracking-tight">Runs</h1>
          <p class="text-fg-3 text-[12px] m-0 mt-0.5">Spawn runs, watch them execute, dig into history.</p>
        </div>
        <div class="flex-1" />
        <Show when={waitingCount() > 0}>
          <span class="text-[11px] font-mono text-fg-2 tabular-nums">queue: {waitingCount()} waiting</span>
        </Show>
        <form
          class="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            spawn()
          }}
        >
          <input
            list="vx-task-names"
            placeholder="task name, e.g. lint or test"
            value={taskInput()}
            onInput={(e) => setTaskInput(e.currentTarget.value)}
            class="w-64 font-mono text-[13px]"
            disabled={workspaceMissing()}
          />
          <datalist id="vx-task-names">
            <For each={taskNames()}>{(t) => <option value={t} />}</For>
          </datalist>
          <button
            type="submit"
            disabled={!canRun()}
            class="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-accent text-bg font-medium text-[13px] hover:brightness-110 transition disabled:opacity-40 disabled:cursor-not-allowed"
            title={workspaceMissing() ? 'This serve has no colocated workspace — runs are unavailable here.' : 'Each press queues another run.'}
          >
            <span class="i-tabler-player-play-filled" />
            Run
          </button>
        </form>
      </div>

      <Show when={workspaceMissing()}>
        <div class="rounded-lg border border-border bg-surface/40 px-4 py-2.5 text-[12px] text-fg-2 flex items-center gap-2">
          <span class="i-tabler-info-circle text-fg-3 shrink-0" aria-hidden="true" />
          <span>
            This serve has no colocated workspace — spawning runs is unavailable here. Start it inside your repo
            (<code class="font-mono">vx-cloud serve --ui</code>) to unlock the spawn bar; run history below still works.
          </span>
        </div>
      </Show>

      {/* Queued / live jobs */}
      <Show when={anyActive()}>
        <div class="rounded-xl border border-border bg-surface/40 overflow-hidden">
          <div class="px-4 py-2.5 border-b border-border/70 flex items-center gap-2">
            <span class="i-tabler-activity text-accent" aria-hidden="true" />
            <span class="text-[11px] font-semibold uppercase tracking-wider text-fg-2">Active</span>
            <Show when={waitingCount() > 0}>
              <span class="ml-auto text-[11px] font-mono text-fg-3 tabular-nums">{waitingCount()} waiting</span>
            </Show>
          </div>
          <For each={active.list}>{(job) => <ActiveRow job={job} />}</For>
          <For each={foreignJobs()}>
            {(q) => (
              <div class="px-4 py-2.5 flex items-center gap-3 border-t border-border/70 first:border-t-0">
                <span
                  class={q.state === 'running' ? 'i-tabler-refresh animate-spin text-accent' : 'i-tabler-clock text-fg-3'}
                  aria-hidden="true"
                />
                <span class="font-mono text-[13px] text-fg-1">{q.tasks.join(' ')}</span>
                <span class="text-[10px] font-mono text-fg-3 px-1.5 py-0.5 rounded border border-border" title="submitted outside this dashboard (CLI delegation or another client)">
                  cli
                </span>
                <span class="text-[11px] font-mono text-fg-2">
                  {q.state === 'running' ? 'running' : `queued · position ${q.position}`}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* History */}
      <Card title="History" noPad>
        <Show
          when={historyStatus() !== 'ok' || historyRows().length > 0}
          fallback={<EmptyState title="No invocations yet" hint="Spawn a run above, or push one from the CLI." cmd="vx run <task>" />}
        >
          {DataTable(
            jrCtx(() => ({
              rows: historyRows(),
              columns: HISTORY_COLUMNS,
              rowHref: '/runs/{runId}',
              filter: true,
              filterFrom: ['runId', 'branch', '_ci', '_tags'],
              filterPlaceholder: 'filter by run id, branch, CI, or tag…',
              initialSort: { key: 'startedAt', desc: true },
              emptyTitle: 'No invocations yet',
              emptyCmd: 'vx run <task>',
              status: historyStatus(),
            })),
          )}
        </Show>
      </Card>
    </div>
  )
}

function ActiveRow(props: { job: ActiveJob }) {
  const job = () => props.job
  const expanded = () => expandedKey() === job().key
  const expandable = () => job().state === 'running' || job().state === 'done'
  const progress = () => job().session.progress()

  const stateBadge = () => {
    switch (job().state) {
      case 'submitting':
        return <span class="text-[11px] font-mono text-fg-3">submitting…</span>
      case 'queued':
        return <span class="text-[11px] font-mono text-warn">queued · position {job().position}</span>
      case 'running':
        return (
          <span class="text-[11px] font-mono text-accent tabular-nums">
            running · {progress().done}/{progress().total || '—'}
          </span>
        )
      case 'done':
        return (
          <span class={`text-[11px] font-mono ${job().ok ? 'text-success' : 'text-danger'}`}>
            {job().ok ? 'passed' : 'failed'}
          </span>
        )
      case 'refused':
        return <span class="text-[11px] font-mono text-danger">{job().error ?? 'refused'}</span>
    }
  }

  const icon = () => {
    switch (job().state) {
      case 'submitting':
        return <span class="i-tabler-loader-2 animate-spin text-fg-3" aria-hidden="true" />
      case 'queued':
        return <span class="i-tabler-clock text-warn" aria-hidden="true" />
      case 'running':
        return <span class="i-tabler-refresh animate-spin text-accent" aria-hidden="true" />
      case 'done':
        return (
          <span
            class={job().ok ? 'i-tabler-circle-check text-success' : 'i-tabler-circle-x text-danger'}
            aria-hidden="true"
          />
        )
      case 'refused':
        return <span class="i-tabler-alert-triangle text-danger" aria-hidden="true" />
    }
  }

  return (
    <div class="border-t border-border/70 first:border-t-0">
      <div
        class="px-4 py-2.5 flex items-center gap-3"
        classList={{ 'cursor-pointer hover:bg-surface-hover/50': expandable() }}
        onClick={() => expandable() && setExpandedKey(expanded() ? null : job().key)}
      >
        {icon()}
        <span class="font-mono text-[13px] text-fg-1">{job().tasks.join(' ')}</span>
        {stateBadge()}
        <div class="flex-1" />
        <Show when={job().state === 'done' && job().runId !== undefined}>
          <A
            href={`/runs/${encodeURIComponent(job().runId!)}`}
            class="text-accent hover:underline text-[11px] font-mono"
            onClick={(e) => e.stopPropagation()}
          >
            view run →
          </A>
        </Show>
        <Show when={job().state === 'queued' || job().state === 'submitting'}>
          <button
            type="button"
            class="text-[11px] px-2 py-1 rounded border border-border text-fg-2 hover:text-fg hover:border-border-strong transition"
            onClick={(e) => {
              e.stopPropagation()
              job().cancel()
              removeJob(job().key)
            }}
          >
            Cancel
          </button>
        </Show>
        <Show when={job().state === 'done' || job().state === 'refused'}>
          <button
            type="button"
            class="text-fg-3 hover:text-fg transition"
            title="Dismiss"
            onClick={(e) => {
              e.stopPropagation()
              removeJob(job().key)
            }}
          >
            <span class="i-tabler-x" aria-hidden="true" />
          </button>
        </Show>
        <Show when={expandable()}>
          <span class={expanded() ? 'i-tabler-chevron-up text-fg-3' : 'i-tabler-chevron-down text-fg-3'} aria-hidden="true" />
        </Show>
      </div>
      <Show when={expanded()}>
        <div class="border-t border-border/70 p-3 h-[560px]">
          <RunSession session={job().session} />
        </div>
      </Show>
    </div>
  )
}
