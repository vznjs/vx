import { For, Show, createMemo, createResource, createSignal } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { getHistory, getOriginSignal, type TaskHistoryRow } from '../api.ts'
import { formatDuration, formatPercent, formatRelativeTime } from '../format.ts'

type SortKey =
  | 'id'
  | 'runs'
  | 'successRate'
  | 'hitRate'
  | 'avgDurationMs'
  | 'p50DurationMs'
  | 'p99DurationMs'
  | 'totalDurationMs'
  | 'lastSeenAt'

export function Tasks() {
  const origin = getOriginSignal()
  const [history] = createResource(origin, () => getHistory(500))
  const [filter, setFilter] = createSignal('')
  const [sortKey, setSortKey] = createSignal<SortKey>('totalDurationMs')
  const [sortDesc, setSortDesc] = createSignal(true)
  const navigate = useNavigate()

  const filtered = createMemo(() => {
    const rows = history() ?? []
    const f = filter().toLowerCase()
    const filt = f ? rows.filter((r) => r.id.toLowerCase().includes(f)) : rows
    return [...filt].sort((a, b) => {
      const av = sortValue(a, sortKey())
      const bv = sortValue(b, sortKey())
      const cmp = av === bv ? 0 : av > bv ? 1 : -1
      return sortDesc() ? -cmp : cmp
    })
  })

  function onSort(k: SortKey) {
    if (sortKey() === k) setSortDesc(!sortDesc())
    else {
      setSortKey(k)
      setSortDesc(true)
    }
  }

  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-3">
        <h1 class="text-base font-semibold m-0">Tasks</h1>
        <input
          type="text"
          placeholder="filter by project#task…"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          class="text-xs font-mono px-2 py-1 rounded border border-border-muted bg-bg w-72"
        />
      </div>
      <Show when={history.error}>
        <div class="text-failure font-mono text-sm">Failed to load: {String(history.error)}</div>
      </Show>
      <Show when={history.loading}>
        <div class="text-fg-muted text-sm">Loading…</div>
      </Show>
      <Show when={history() !== undefined}>
        <div class="border border-border-muted rounded overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-bg-elevated text-fg-muted text-xs uppercase tracking-wider">
              <tr>
                <Th k="id" curr={sortKey()} desc={sortDesc()} onSort={onSort} align="left">
                  Task
                </Th>
                <Th k="runs" curr={sortKey()} desc={sortDesc()} onSort={onSort}>
                  Runs
                </Th>
                <Th k="successRate" curr={sortKey()} desc={sortDesc()} onSort={onSort}>
                  Success
                </Th>
                <Th k="hitRate" curr={sortKey()} desc={sortDesc()} onSort={onSort}>
                  Hit
                </Th>
                <Th k="avgDurationMs" curr={sortKey()} desc={sortDesc()} onSort={onSort}>
                  Avg
                </Th>
                <Th k="p50DurationMs" curr={sortKey()} desc={sortDesc()} onSort={onSort}>
                  p50
                </Th>
                <Th k="p99DurationMs" curr={sortKey()} desc={sortDesc()} onSort={onSort}>
                  p99
                </Th>
                <Th k="totalDurationMs" curr={sortKey()} desc={sortDesc()} onSort={onSort}>
                  Total time
                </Th>
                <Th k="lastSeenAt" curr={sortKey()} desc={sortDesc()} onSort={onSort}>
                  Last run
                </Th>
              </tr>
            </thead>
            <tbody>
              <For each={filtered()}>
                {(r) => (
                  <tr
                    class="border-t border-border-muted hover:bg-bg-elevated cursor-pointer"
                    onClick={() => navigate(`/tasks/${encodeURIComponent(r.id)}`)}
                  >
                    <td class="px-3 py-2 font-mono text-xs">
                      <FailureBadge mode={r.failureMode} />
                      <span class="ml-2">{r.id}</span>
                    </td>
                    <td class="px-3 py-2 text-right">{r.runs}</td>
                    <td
                      class="px-3 py-2 text-right"
                      classList={{ 'text-failure': r.failures > 0 && r.successRate < 0.9 }}
                    >
                      {formatPercent(r.successRate)}
                    </td>
                    <td class="px-3 py-2 text-right text-cache">{formatPercent(r.hitRate)}</td>
                    <td class="px-3 py-2 text-right">{formatDuration(r.avgDurationMs ?? 0)}</td>
                    <td class="px-3 py-2 text-right">{formatDuration(r.p50DurationMs ?? 0)}</td>
                    <td class="px-3 py-2 text-right">{formatDuration(r.p99DurationMs ?? 0)}</td>
                    <td class="px-3 py-2 text-right">{formatDuration(r.totalDurationMs)}</td>
                    <td class="px-3 py-2 text-right text-fg-muted text-xs">
                      {r.lastSeenAt !== undefined ? formatRelativeTime(r.lastSeenAt) : '—'}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <Show when={filtered().length === 0}>
            <div class="px-3 py-8 text-fg-muted text-sm text-center">
              No matching tasks.
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function sortValue(r: TaskHistoryRow, k: SortKey): number | string {
  switch (k) {
    case 'id':
      return r.id
    case 'runs':
      return r.runs
    case 'successRate':
      return r.successRate
    case 'hitRate':
      return r.hitRate
    case 'avgDurationMs':
      return r.avgDurationMs ?? 0
    case 'p50DurationMs':
      return r.p50DurationMs ?? 0
    case 'p99DurationMs':
      return r.p99DurationMs ?? 0
    case 'totalDurationMs':
      return r.totalDurationMs
    case 'lastSeenAt':
      return r.lastSeenAt ?? 0
  }
}

function Th(props: {
  k: SortKey
  curr: SortKey
  desc: boolean
  onSort: (k: SortKey) => void
  align?: 'left' | 'right'
  children: ReturnType<typeof Element>
}) {
  const active = () => props.curr === props.k
  return (
    <th
      class="px-3 py-2 font-medium cursor-pointer select-none hover:text-fg"
      classList={{
        'text-right': props.align !== 'left',
        'text-left': props.align === 'left',
        'text-fg': active(),
      }}
      onClick={() => props.onSort(props.k)}
    >
      {props.children}
      <Show when={active()}>
        <span class="ml-1">{props.desc ? '↓' : '↑'}</span>
      </Show>
    </th>
  )
}

function FailureBadge(props: { mode: TaskHistoryRow['failureMode'] }) {
  const color = () =>
    props.mode === 'stable'
      ? 'bg-success'
      : props.mode === 'flaky-recoverable'
        ? 'bg-skipped'
        : 'bg-failure'
  return (
    <span
      class={`inline-block w-2 h-2 rounded-full ${color()}`}
      title={props.mode}
      aria-label={props.mode}
    />
  )
}
