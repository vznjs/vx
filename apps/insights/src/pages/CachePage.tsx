import { For, Show, createMemo, createResource, createSignal } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import {
  getCacheBreakdown,
  getCacheStats,
  getOriginSignal,
  listCacheEntries,
} from '../api.ts'
import { formatBytes, formatDuration, formatPercent, formatRelativeTime } from '../format.ts'

type Sort = 'created_at' | 'accessed_at' | 'size_bytes' | 'duration_ms'

export function CachePage() {
  const origin = getOriginSignal()
  const [sort, setSort] = createSignal<Sort>('size_bytes')
  const [filter, setFilter] = createSignal('')
  const navigate = useNavigate()

  const [stats] = createResource(origin, () => getCacheStats())
  const [breakdown] = createResource(origin, () => getCacheBreakdown(50))
  const [entries] = createResource(
    () => ({ s: sort(), o: origin() }),
    (args) => listCacheEntries({ limit: 200, orderBy: args.s }),
  )

  const filtered = createMemo(() => {
    const rows = entries() ?? []
    const f = filter().toLowerCase()
    if (!f) return rows
    return rows.filter(
      (r) => `${r.project}#${r.task}`.toLowerCase().includes(f) || r.hash.includes(f),
    )
  })

  return (
    <div class="flex flex-col gap-6">
      <h1 class="text-base font-semibold m-0">Cache</h1>

      <Show when={stats() !== undefined}>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Entries" value={String(stats()!.entryCount)} />
          <Stat label="Total size" value={formatBytes(stats()!.totalBytes)} />
          <Stat label="Runs (24h)" value={String(stats()!.runCountLast24h)} />
          <Stat label="Hit rate (24h)" value={formatPercent(stats()!.hitRate24h)} />
        </div>
      </Show>

      {/* Breakdown by project */}
      <Show when={breakdown() !== undefined && breakdown()!.length > 0}>
        <div class="border border-border-muted rounded overflow-hidden">
          <div class="px-3 py-2 bg-bg-elevated border-b border-border-muted">
            <h2 class="text-xs font-semibold m-0 uppercase tracking-wider text-fg-muted">
              By project
            </h2>
          </div>
          <table class="w-full text-sm">
            <tbody>
              <For each={breakdown()}>
                {(p) => {
                  const widthPct = () => {
                    const max = Math.max(...(breakdown() ?? []).map((x) => x.totalBytes))
                    return max > 0 ? (p.totalBytes / max) * 100 : 0
                  }
                  return (
                    <tr class="border-t border-border-muted">
                      <td class="px-3 py-2 font-mono text-xs w-1/4">{p.project}</td>
                      <td class="px-3 py-2">
                        <div class="h-2 bg-bg rounded overflow-hidden">
                          <div
                            class="h-full bg-accent/60"
                            style={{ width: `${widthPct().toFixed(1)}%` }}
                          />
                        </div>
                      </td>
                      <td class="px-3 py-2 text-right text-xs text-fg-muted">
                        {p.entries} entries
                      </td>
                      <td class="px-3 py-2 text-right">{formatBytes(p.totalBytes)}</td>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      {/* Entries table */}
      <div class="border border-border-muted rounded overflow-hidden">
        <div class="flex items-center justify-between px-3 py-2 bg-bg-elevated border-b border-border-muted">
          <div class="flex items-center gap-3">
            <h2 class="text-xs font-semibold m-0 uppercase tracking-wider text-fg-muted">
              Entries
            </h2>
            <select
              value={sort()}
              onChange={(e) => setSort(e.currentTarget.value as Sort)}
              class="text-xs bg-bg border border-border-muted rounded px-2 py-1"
            >
              <option value="size_bytes">Largest first</option>
              <option value="created_at">Newest first</option>
              <option value="accessed_at">Recently accessed</option>
              <option value="duration_ms">Slowest first</option>
            </select>
          </div>
          <input
            type="text"
            placeholder="filter…"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            class="text-xs font-mono px-2 py-1 rounded border border-border-muted bg-bg w-60"
          />
        </div>
        <table class="w-full text-sm">
          <thead class="bg-bg-elevated text-fg-muted text-xs uppercase tracking-wider">
            <tr>
              <th class="text-left px-3 py-2 font-medium">Task</th>
              <th class="text-left px-3 py-2 font-medium">Hash</th>
              <th class="text-right px-3 py-2 font-medium">Size</th>
              <th class="text-right px-3 py-2 font-medium">Duration</th>
              <th class="text-right px-3 py-2 font-medium">Created</th>
              <th class="text-right px-3 py-2 font-medium">Accessed</th>
            </tr>
          </thead>
          <tbody>
            <For each={filtered()}>
              {(e) => (
                <tr
                  class="border-t border-border-muted hover:bg-bg-elevated cursor-pointer"
                  onClick={() =>
                    navigate(`/tasks/${encodeURIComponent(`${e.project}#${e.task}`)}`)
                  }
                >
                  <td class="px-3 py-2 font-mono text-xs">
                    {e.project}#{e.task}
                  </td>
                  <td class="px-3 py-2 font-mono text-xs text-fg-muted">{e.hash.slice(0, 12)}…</td>
                  <td class="px-3 py-2 text-right">{formatBytes(e.sizeBytes)}</td>
                  <td class="px-3 py-2 text-right">{formatDuration(e.durationMs)}</td>
                  <td class="px-3 py-2 text-right text-fg-muted text-xs">
                    {formatRelativeTime(e.createdAt)}
                  </td>
                  <td class="px-3 py-2 text-right text-fg-muted text-xs">
                    {formatRelativeTime(e.accessedAt)}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <Show when={filtered().length === 0}>
          <div class="px-3 py-8 text-fg-muted text-sm text-center">
            <Show
              when={(entries() ?? []).length === 0}
              fallback={<>No matching entries.</>}
            >
              No cache entries yet. Run a cacheable task to populate.
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

function Stat(props: { label: string; value: string }) {
  return (
    <div class="border border-border-muted rounded px-3 py-2 bg-bg-elevated">
      <div class="text-fg-muted text-[10px] uppercase tracking-wider">{props.label}</div>
      <div class="text-lg font-mono">{props.value}</div>
    </div>
  )
}
