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

import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
} from 'solid-js'
import { createStore } from 'solid-js/store'
import { A, useSearchParams } from '@solidjs/router'
import type { BaseComponentProps } from '@json-render/solid'
import {
  type InvocationDetail,
  type QueueJobRow,
  fetchCatalogTasks,
  fetchHermeticity,
  fetchQueue,
  getCacheStats,
  getCapabilitiesSignal,
  getConnectionKey,
  getFlakiest,
  getHistory,
  getVersion,
  listInvocations,
  listRuns,
  queueRun,
} from '../api.ts'
import {
  type RunResultFilter,
  type RunTick,
  countTone,
  distinctBranches,
  distinctCommits,
  filterInvocations,
  passRateWithin,
  rateTone,
  runTicks,
} from '../jr/functions.ts'
import { formatDuration, formatPercent, formatRelativeTime } from '../format.ts'
import { identityStable, useVisibilityRefresh } from '../live.ts'
import { DataTable, type Column } from '../jr/components.tsx'
import { Card, EmptyState, MetricCard } from './ui.tsx'
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
  // Live auto-refresh: history, invocations and the health tiles re-fetch on a
  // visibility-aware 5s tick (paused while the tab is hidden). The queue poll
  // below keeps its own faster cadence; the live-run WebSocket is untouched.
  const liveTick = useVisibilityRefresh(5000)
  const [searchParams, setSearchParams] = useSearchParams()
  // `/version` exists only on serves with a colocated workspace (the platform
  // removed it) — probing it unconditionally is a guaranteed 404 per mount.
  // Gate on the catalog capability: no catalog ⇒ no workspace ⇒ spawn stays
  // honestly disabled without ever firing the request.
  const [version] = createResource(
    () => (capabilities().known && capabilities().catalog ? getConnectionKey() : null),
    () => getVersion().catch(() => null),
  )

  // Datalist names: the workspace catalog when this serve has one (§6.5),
  // else history-derived names (the pre-catalog fallback).
  const [catalogTasks] = createResource(
    () => (capabilities().known && capabilities().catalog ? getConnectionKey() : null),
    () => fetchCatalogTasks().catch(() => null),
  )
  const [history] = createResource(
    () => `${getConnectionKey()}|${liveTick()}`,
    () => getHistory({ limit: 300 }).catch(() => []),
  )
  const taskNames = createMemo(() => {
    const catalog = catalogTasks()
    const names = catalog
      ? catalog.tasks.map((t) => t.task)
      : (history() ?? []).map((h) => h.task)
    return Array.from(new Set(names)).sort()
  })

  // Historical invocations (refetches when a queued job completes, on each
  // live tick, and on connection/workspace switch). The fetch is CAUGHT (to
  // null) and the last good rows are held outside the resource: with the 5s
  // tick this path is hot, and an uncaught rejection from one failed poll
  // (serve restart, laptop wake) would permanently wedge every downstream
  // memo while the view still looked live — while blanking to the error
  // state on a blip would flash a populated table empty for a tick.
  // identityStable: a data-identical poll returns the SAME reference, so the
  // downstream memo chain (invocationRows → historyRows → table rows) stops
  // propagating and the 200-row table does zero DOM work on an unchanged tick.
  const stableInvocations = identityStable<InvocationDetail[] | null>()
  const [invocations] = createResource(
    () => `${getConnectionKey()}|${historyVersion()}|${liveTick()}`,
    async () => stableInvocations(await listInvocations(200).catch(() => null)),
  )
  let lastGoodInvocations: InvocationDetail[] | undefined
  // Scope the last-good cache to the connection. It exists so a transient failed
  // poll on the SAME connection keeps the table populated — but on an org /
  // workspace / origin switch it must be dropped, or a FAILED first fetch on the
  // new connection (403 with no access, a blip) would render the PREVIOUS
  // tenant's run history + CI-health under the new context. `defer` so it resets
  // only on a real change, not the initial mount.
  createEffect(
    on(
      getConnectionKey,
      () => {
        lastGoodInvocations = undefined
      },
      { defer: true },
    ),
  )
  const invocationRows = createMemo<InvocationDetail[] | undefined>(() => {
    const v = invocations()
    if (v !== null && v !== undefined) lastGoodInvocations = v
    return lastGoodInvocations
  })
  const historyRows = createMemo<Record<string, unknown>[]>(() =>
    (invocationRows() ?? []).map((r) => ({
      ...r,
      _ciToken: r.ci ? 'stable' : 'cold',
      _ci: r.ci ? 'CI' : 'local',
      _tags: tagsText(r.tags),
    })),
  )
  const historyStatus = () =>
    invocationRows() !== undefined
      ? ('ok' as const)
      : invocations() === null
        ? ('error' as const)
        : ('loading' as const)

  // -- Faceted filters (URL-persisted) --------------------------------------
  // result / branch / project ride the hash query (#/runs?result=failed&…) so
  // a filtered view is shareable + restores on load. Setting a facet to its
  // default removes the param (a clean URL).
  const resultFilter = (): RunResultFilter => {
    const v = searchParams.result
    return v === 'passed' || v === 'failed' ? v : 'all'
  }
  const branchFilter = (): string => (typeof searchParams.branch === 'string' ? searchParams.branch : '')
  const projectFilter = (): string => (typeof searchParams.project === 'string' ? searchParams.project : '')
  const commitFilter = (): string => (typeof searchParams.commit === 'string' ? searchParams.commit : '')
  const setResult = (v: RunResultFilter): void => setSearchParams({ result: v === 'all' ? undefined : v })
  const setBranch = (v: string): void => setSearchParams({ branch: v === '' ? undefined : v })
  const setProject = (v: string): void => setSearchParams({ project: v === '' ? undefined : v })
  const setCommit = (v: string): void => setSearchParams({ commit: v === '' ? undefined : v })
  const clearFilters = (): void =>
    setSearchParams({ result: undefined, branch: undefined, project: undefined, commit: undefined })
  const anyFilter = () =>
    resultFilter() !== 'all' || branchFilter() !== '' || projectFilter() !== '' || commitFilter() !== ''

  // The active facet value is always included so its <option> exists on a
  // deep-link load (before invocations/history arrive) — otherwise the select
  // can't display the restored value even though the filter is applied.
  const branchNames = createMemo(() => {
    const set = new Set(distinctBranches(invocationRows() ?? []))
    if (branchFilter() !== '') set.add(branchFilter())
    return Array.from(set).sort()
  })
  const projectNames = createMemo(() => {
    const set = new Set<string>()
    for (const h of history() ?? []) set.add(h.project)
    const cat = catalogTasks()
    if (cat) for (const t of cat.tasks) set.add(t.project)
    if (projectFilter() !== '') set.add(projectFilter())
    return Array.from(set).sort()
  })
  // Commit SHAs seen in the loaded invocations (most-recent-first). The active
  // value is always present so a deep-linked commit restores its <option>.
  const commitShas = createMemo(() => {
    const list = distinctCommits(invocationRows() ?? [])
    const active = commitFilter()
    if (active !== '' && !list.includes(active)) list.unshift(active)
    return list
  })

  // Project → the set of runIds that touched it (invocation headers carry no
  // project, so the server /v1/runs?project= filter names the runs, and we
  // intersect). Only fetched while a project facet is active. The value
  // carries WHICH project it belongs to: on an A→B facet switch Solid keeps
  // serving A's value while B loads, and filtering by the wrong project's set
  // (or by nothing at all on first activation) would show wrong rows under an
  // active chip.
  const [projectRunIds] = createResource(
    () => (projectFilter() === '' ? null : `${getConnectionKey()}|${projectFilter()}|${liveTick()}`),
    async () => {
      const project = projectFilter()
      const runs = await listRuns({ project, limit: 2000 }).catch(() => [])
      return {
        project,
        ids: new Set(runs.map((r) => r.runId).filter((id): id is string => id !== null)),
      }
    },
  )

  // `undefined` = an active project facet is still resolving — the table shows
  // a loading state instead of unfiltered (or wrongly-filtered) rows.
  const filteredRows = createMemo<Record<string, unknown>[] | undefined>(() => {
    let rows = filterInvocations(historyRows(), {
      result: resultFilter(),
      branch: branchFilter(),
      commit: commitFilter(),
    })
    if (projectFilter() !== '') {
      const v = projectRunIds()
      if (v === undefined || v.project !== projectFilter()) return undefined
      rows = rows.filter((r) => typeof r.runId === 'string' && v.ids.has(r.runId))
    }
    return rows
  })

  // -- CI health strip (identity-stable: unchanged ticks re-render nothing) --
  const stableStats = identityStable<Awaited<ReturnType<typeof getCacheStats>> | null>()
  const [stats] = createResource(
    () => `${getConnectionKey()}|${liveTick()}`,
    async () => stableStats(await getCacheStats().catch(() => null)),
  )
  // Caught to null, NOT [] — a failed /v1/flakiness probe must render '—',
  // never a confident green "0 flaky".
  const stableFlaky = identityStable<Awaited<ReturnType<typeof getFlakiest>> | null>()
  const [flaky] = createResource(
    () => `${getConnectionKey()}|${liveTick()}`,
    async () => stableFlaky(await getFlakiest(100).catch(() => null)),
  )
  const stableHermeticity = identityStable<Awaited<ReturnType<typeof fetchHermeticity>> | null>()
  const [hermeticity] = createResource(
    () => `${getConnectionKey()}|${liveTick()}`,
    async () => stableHermeticity(await fetchHermeticity(50).catch(() => null)),
  )
  const ticks = createMemo<RunTick[]>(() => runTicks(invocationRows() ?? [], 24))
  const passRate24h = createMemo(() =>
    passRateWithin(invocationRows() ?? [], 24 * 60 * 60 * 1000, Date.now()),
  )
  const flakyCount = () => flaky()?.length
  const nonHermeticCount = () => hermeticity()?.divergent.length

  // Serve-side queue state, polled at 2s while the view is mounted (an
  // in-memory read) — surfaces FOREIGN jobs too (CLI delegations, other
  // dashboards) as state-only rows. Gated on the /v1/meta `queue` capability:
  // the platform has no queue, and polling its removed endpoint was a
  // guaranteed 404 every 2 seconds plus per-tick state churn.
  const [queueJobs, setQueueJobs] = createSignal<QueueJobRow[]>([])
  createEffect(() => {
    if (!(capabilities().known && capabilities().queue)) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      try {
        setQueueJobs(await fetchQueue())
      } catch {
        // keep the last-good rows — one blipped poll must not blank active
        // foreign CLI jobs for a tick
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

      {/* CI health strip — recent run outcomes + at-a-glance health tiles. */}
      <HealthStrip
        ticks={ticks()}
        passRate={passRate24h()}
        flakyCount={flakyCount()}
        hitRate24h={stats()?.hitRate24h}
        nonHermetic={nonHermeticCount()}
      />

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
          {/* Faceted filters (URL-persisted) above the existing free-text one. */}
          <div class="px-4 py-2.5 border-b border-border/70 flex items-center gap-2.5 flex-wrap text-[12px]">
            <span class="text-[10px] uppercase tracking-wider text-fg-3 font-semibold">Filter</span>
            <select value={resultFilter()} onChange={(e) => setResult(e.currentTarget.value as RunResultFilter)} class="text-[12px]" aria-label="result">
              <option value="all">All results</option>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
            </select>
            <select value={branchFilter()} onChange={(e) => setBranch(e.currentTarget.value)} class="text-[12px]" aria-label="branch">
              <option value="">All branches</option>
              <For each={branchNames()}>{(b) => <option value={b}>{b}</option>}</For>
            </select>
            <select value={projectFilter()} onChange={(e) => setProject(e.currentTarget.value)} class="text-[12px]" aria-label="project">
              <option value="">All projects</option>
              <For each={projectNames()}>{(p) => <option value={p}>{p}</option>}</For>
            </select>
            <select value={commitFilter()} onChange={(e) => setCommit(e.currentTarget.value)} class="text-[12px] font-mono" aria-label="commit">
              <option value="">All commits</option>
              <For each={commitShas()}>{(c) => <option value={c}>{c.slice(0, 8)}</option>}</For>
            </select>
            <Show when={anyFilter()}>
              <div class="flex items-center gap-1.5 flex-wrap">
                <Show when={resultFilter() !== 'all'}>
                  <Chip label={resultFilter()} onClear={() => setResult('all')} />
                </Show>
                <Show when={branchFilter() !== ''}>
                  <Chip label={`branch: ${branchFilter()}`} onClear={() => setBranch('')} />
                </Show>
                <Show when={projectFilter() !== ''}>
                  <Chip label={`project: ${projectFilter()}`} onClear={() => setProject('')} />
                </Show>
                <Show when={commitFilter() !== ''}>
                  <Chip label={`commit: ${commitFilter().slice(0, 8)}`} onClear={() => setCommit('')} />
                </Show>
                <button type="button" onClick={clearFilters} class="text-[11px] text-fg-3 hover:text-fg underline-offset-2 hover:underline">
                  clear all
                </button>
              </div>
            </Show>
            <span data-testid="runs-count" class="ml-auto text-[11px] font-mono text-fg-3 tabular-nums">
              {filteredRows() === undefined ? '…' : `${filteredRows()!.length} runs`}
            </span>
          </div>
          {DataTable(
            jrCtx(() => ({
              rows: filteredRows() ?? [],
              columns: HISTORY_COLUMNS,
              rowHref: '/runs/{runId}',
              filter: true,
              filterFrom: ['runId', 'branch', '_ci', '_tags'],
              filterPlaceholder: 'filter by run id, branch, CI, or tag…',
              initialSort: { key: 'startedAt', desc: true },
              emptyTitle: anyFilter() ? 'No runs match these filters' : 'No invocations yet',
              emptyHint: anyFilter() ? 'Clear a filter to widen the results.' : undefined,
              emptyCmd: anyFilter() ? undefined : 'vx run <task>',
              // A resolving project facet reads as loading, never as wrong rows.
              status: filteredRows() === undefined ? 'loading' : historyStatus(),
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

/** A clearable active-filter chip. */
function Chip(props: { label: string; onClear: () => void }) {
  return (
    <span class="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full border border-border bg-surface-2/60 text-[11px] font-mono text-fg-1">
      {props.label}
      <button
        type="button"
        class="i-tabler-x text-fg-3 hover:text-fg text-[12px] leading-none"
        aria-label={`clear ${props.label}`}
        onClick={props.onClear}
      />
    </span>
  )
}

/**
 * The CI-health read atop Runs: a strip of recent-run status ticks (last ~24,
 * newest on the right, each a link into its run) + four health tiles (pass
 * rate 24h, flaky tasks, cache hit rate 24h, non-hermetic keys), tinted green/
 * amber/red by threshold and linking to the entity that explains each.
 */
function HealthStrip(props: {
  ticks: RunTick[]
  passRate: number | undefined
  flakyCount: number | undefined
  hitRate24h: number | undefined
  nonHermetic: number | undefined
}) {
  const pad = () => Math.max(0, 24 - props.ticks.length)
  return (
    <div data-testid="ci-health" class="rounded-xl border border-border bg-surface/40 p-4 flex flex-col gap-3.5">
      <div class="flex items-center gap-2">
        <span class="i-tabler-heartbeat text-accent" aria-hidden="true" />
        <span class="text-[11px] font-semibold uppercase tracking-wider text-fg-2">CI health</span>
        <span class="ml-auto text-[10px] font-mono text-fg-3">last {props.ticks.length} runs</span>
      </div>

      <Show
        when={props.ticks.length > 0}
        fallback={<div class="text-fg-3 text-[12px]">No runs yet — spawn one above or push from the CLI.</div>}
      >
        <div class="flex items-end gap-1 overflow-x-auto pb-1">
          <For each={Array.from({ length: pad() })}>
            {() => <span class="w-2 h-6 rounded-sm shrink-0 bg-fg-3/25" />}
          </For>
          <For each={props.ticks}>
            {(t) => (
              <A
                href={`/runs/${encodeURIComponent(t.runId)}`}
                class={`w-2 h-6 rounded-sm shrink-0 transition hover:opacity-70 ${t.ok ? 'bg-success' : 'bg-danger'}`}
                aria-label={`${t.ok ? 'passed' : 'failed'} run`}
                title={`${t.label || 'run'} · ${t.ok ? 'passed' : 'failed'} · ${formatRelativeTime(t.startedAt)} · ${formatDuration(t.durationMs)}`}
              />
            )}
          </For>
        </div>
      </Show>

      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <HealthTile
          href="/insights"
          label="Pass rate (24h)"
          value={props.passRate === undefined ? '—' : formatPercent(props.passRate, 0)}
          sub="runs that exited clean"
          tone={props.passRate === undefined ? 'default' : rateTone(props.passRate, 0.9, 0.7)}
        />
        <HealthTile
          href="/insights"
          label="Flaky tasks"
          value={props.flakyCount === undefined ? '—' : String(props.flakyCount)}
          sub="confirmed + inferred"
          tone={props.flakyCount === undefined ? 'default' : countTone(props.flakyCount, 3)}
        />
        <HealthTile
          href="/cache"
          label="Cache hit rate (24h)"
          value={props.hitRate24h === undefined ? '—' : formatPercent(props.hitRate24h, 0)}
          sub="restored vs re-run"
          tone={props.hitRate24h === undefined ? 'default' : rateTone(props.hitRate24h, 0.5, 0.2)}
        />
        <HealthTile
          href="/insights"
          label="Non-hermetic keys"
          value={props.nonHermetic === undefined ? '—' : String(props.nonHermetic)}
          sub="diverging output trees"
          tone={props.nonHermetic === undefined ? 'default' : countTone(props.nonHermetic, 1)}
        />
      </div>
    </div>
  )
}

/** A health tile — a MetricCard wrapped in a link to its explaining entity. */
function HealthTile(props: {
  href: string
  label: string
  value: string
  sub?: string
  tone: 'default' | 'good' | 'warn' | 'bad'
}) {
  return (
    <A href={props.href} class="no-underline block">
      <MetricCard label={props.label} value={props.value} sub={props.sub} tone={props.tone} />
    </A>
  )
}
