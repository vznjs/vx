import { For, Show, createMemo, createResource, createSignal } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { getHistory, getOriginSignal, type TaskHistoryRow } from '../api.ts'
import { Card, EmptyState } from '../components/ui.tsx'
import { HBar } from '../components/charts.tsx'
import { formatDuration, formatPercent, formatRelativeTime, paletteFor } from '../format.ts'

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

  const maxTotal = createMemo(() => Math.max(1, ...(history() ?? []).map((t) => t.totalDurationMs)))

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
          class="text-[12px] font-mono w-72"
        />
      </div>
      <Show when={history.error}>
        <div class="text-danger font-mono text-sm">Failed to load: {String(history.error)}</div>
      </Show>
      <Card noPad>
        <Show when={(history() ?? []).length > 0} fallback={<EmptyState title="No task history yet" cmd="vx run <task>" />}>
          <table class="w-full text-[12px]">
            <thead class="bg-surface-2/40">
              <tr class="text-fg-3 text-[10px] uppercase tracking-wider">
                <Th k="id" curr={sortKey()} desc={sortDesc()} onSort={onSort} align="left">Task</Th>
                <Th k="runs" curr={sortKey()} desc={sortDesc()} onSort={onSort}>Runs</Th>
                <Th k="successRate" curr={sortKey()} desc={sortDesc()} onSort={onSort}>Success</Th>
                <Th k="hitRate" curr={sortKey()} desc={sortDesc()} onSort={onSort}>Hit</Th>
                <Th k="avgDurationMs" curr={sortKey()} desc={sortDesc()} onSort={onSort}>Avg</Th>
                <Th k="p50DurationMs" curr={sortKey()} desc={sortDesc()} onSort={onSort}>p50</Th>
                <Th k="p99DurationMs" curr={sortKey()} desc={sortDesc()} onSort={onSort}>p99</Th>
                <Th k="totalDurationMs" curr={sortKey()} desc={sortDesc()} onSort={onSort}>Total time</Th>
                <Th k="lastSeenAt" curr={sortKey()} desc={sortDesc()} onSort={onSort}>Last</Th>
              </tr>
            </thead>
            <tbody>
              <For each={filtered()}>
                {(r) => (
                  <tr
                    class="border-t border-border hover:bg-surface-hover cursor-pointer"
                    onClick={() => navigate(`/tasks/${encodeURIComponent(r.id)}`)}
                  >
                    <td class="px-4 py-2 font-mono">
                      <div class="flex items-center gap-2">
                        <FailureBadge mode={r.failureMode} />
                        <span class={`inline-block w-1.5 h-1.5 rounded-full bg-${paletteFor(r.project)}`} />
                        <span class="truncate">{r.id}</span>
                      </div>
                    </td>
                    <td class="px-4 py-2 text-right font-mono">{r.runs}</td>
                    <td class="px-4 py-2 text-right font-mono" classList={{ 'text-danger': r.failures > 0 && r.successRate < 0.9 }}>
                      {formatPercent(r.successRate, 0)}
                    </td>
                    <td class="px-4 py-2 text-right font-mono text-cache-local">{formatPercent(r.hitRate, 0)}</td>
                    <td class="px-4 py-2 text-right font-mono">{formatDuration(r.avgDurationMs ?? 0)}</td>
                    <td class="px-4 py-2 text-right font-mono">{formatDuration(r.p50DurationMs ?? 0)}</td>
                    <td class="px-4 py-2 text-right font-mono">{formatDuration(r.p99DurationMs ?? 0)}</td>
                    <td class="px-4 py-2 text-right font-mono">
                      <div class="flex items-center gap-2 justify-end">
                        <span class="w-14">{formatDuration(r.totalDurationMs)}</span>
                        <div class="w-16">
                          <HBar fraction={r.totalDurationMs / maxTotal()} colorClass={`bg-${paletteFor(r.project)}`} />
                        </div>
                      </div>
                    </td>
                    <td class="px-4 py-2 text-right text-fg-3 font-mono text-[10px]">
                      {r.lastSeenAt !== undefined ? formatRelativeTime(r.lastSeenAt) : '—'}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <Show when={filtered().length === 0}>
            <div class="px-4 py-8 text-fg-3 text-sm text-center">No matching tasks.</div>
          </Show>
        </Show>
      </Card>
    </div>
  )
}

function sortValue(r: TaskHistoryRow, k: SortKey): number | string {
  switch (k) {
    case 'id': return r.id
    case 'runs': return r.runs
    case 'successRate': return r.successRate
    case 'hitRate': return r.hitRate
    case 'avgDurationMs': return r.avgDurationMs ?? 0
    case 'p50DurationMs': return r.p50DurationMs ?? 0
    case 'p99DurationMs': return r.p99DurationMs ?? 0
    case 'totalDurationMs': return r.totalDurationMs
    case 'lastSeenAt': return r.lastSeenAt ?? 0
  }
}

function Th(props: { k: SortKey; curr: SortKey; desc: boolean; onSort: (k: SortKey) => void; align?: 'left' | 'right'; children: any }) {
  const active = () => props.curr === props.k
  return (
    <th
      class="px-4 py-2 font-semibold cursor-pointer select-none hover:text-fg"
      classList={{ 'text-right': props.align !== 'left', 'text-left': props.align === 'left', 'text-fg': active() }}
      onClick={() => props.onSort(props.k)}
    >
      {props.children}
      <Show when={active()}><span class="ml-1">{props.desc ? '↓' : '↑'}</span></Show>
    </th>
  )
}

function FailureBadge(props: { mode: TaskHistoryRow['failureMode'] }) {
  const color = () =>
    props.mode === 'stable' ? 'bg-success'
      : props.mode === 'flaky-recoverable' ? 'bg-warn'
        : 'bg-danger'
  return <span class={`inline-block w-1.5 h-1.5 rounded-full ${color()}`} title={props.mode} aria-label={props.mode} />
}
