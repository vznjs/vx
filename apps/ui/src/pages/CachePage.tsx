import { For, Show, createMemo, createResource, createSignal } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import {
  getCacheBreakdown,
  getCacheSavings,
  getCacheStats,
  getOriginSignal,
  getStorageGrowth,
  listCacheEntries,
} from '../api.ts'
import { Card, EmptyState, MetricCard } from '../components/ui.tsx'
import { HBar, LineChart, Treemap } from '../components/charts.tsx'
import { formatBytes, formatDate, formatDuration, formatPercent, formatRelativeTime, paletteFor } from '../format.ts'

type Sort = 'created_at' | 'accessed_at' | 'size_bytes' | 'duration_ms'

export function CachePage() {
  const origin = getOriginSignal()
  const [sort, setSort] = createSignal<Sort>('size_bytes')
  const [filter, setFilter] = createSignal('')
  const navigate = useNavigate()

  const [stats] = createResource(origin, () => getCacheStats())
  const [savings] = createResource(origin, () => getCacheSavings())
  const [breakdown] = createResource(origin, () => getCacheBreakdown(100))
  const [storage] = createResource(origin, () => getStorageGrowth(30))
  const [entries] = createResource(
    () => ({ s: sort(), o: origin() }),
    (args) => listCacheEntries({ limit: 200, orderBy: args.s }),
  )

  const filtered = createMemo(() => {
    const rows = entries() ?? []
    const f = filter().toLowerCase()
    if (!f) return rows
    return rows.filter((r) => `${r.project}#${r.task}`.toLowerCase().includes(f) || r.hash.includes(f))
  })

  return (
    <div class="flex flex-col gap-5">
      <h1 class="text-base font-semibold m-0">Cache</h1>

      <Show when={stats() && savings()}>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MetricCard label="Entries" value={String(stats()!.entryCount)} />
          <MetricCard label="Total size" value={formatBytes(stats()!.totalBytes)} />
          <MetricCard label="Hit rate (24h)" value={formatPercent(stats()!.hitRate24h, 0)} sub={`${stats()!.hitCountLast24h} hits`} />
          <MetricCard label="Time saved (all-time)" value={formatDuration(savings()!.estimatedTimeSavedTotalMs)} tone="good" />
        </div>
      </Show>

      <div class="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <Card title="Storage by project">
          <Show when={breakdown()?.some((p) => p.totalBytes > 0)} fallback={<EmptyState title="No cached output yet" />}>
            <Treemap
              data={(breakdown() ?? []).map((p) => ({ label: p.project, value: p.totalBytes, colorClass: `fill-${paletteFor(p.project)}` }))}
              format={(v) => formatBytes(v)}
              height={240}
            />
          </Show>
        </Card>

        <Card title="By project" noPad>
          <Show when={(breakdown() ?? []).length > 0} fallback={<EmptyState title="No data" />}>
            <For each={breakdown()}>
              {(p) => {
                const max = Math.max(...(breakdown() ?? []).map((x) => x.totalBytes))
                return (
                  <div class="flex flex-col gap-1 px-4 py-2 border-t border-border first:border-t-0">
                    <div class="flex items-center gap-2 text-[12px]">
                      <span class={`inline-block w-1.5 h-1.5 rounded-full bg-${paletteFor(p.project)}`} />
                      <span class="font-mono truncate flex-1">{p.project}</span>
                      <span class="text-fg-3 font-mono text-[10px]">{p.entries}×</span>
                      <span class="font-mono">{formatBytes(p.totalBytes)}</span>
                    </div>
                    <HBar fraction={p.totalBytes / max} colorClass={`bg-${paletteFor(p.project)}`} />
                  </div>
                )
              }}
            </For>
          </Show>
        </Card>
      </div>

      <Card title="Storage growth (last 30 days)">
        <Show when={storage()?.length} fallback={<EmptyState title="No data" />}>
          <LineChart
            xs={storage()?.map((p) => p.t) ?? []}
            series={[
              { name: 'bytes added', strokeClass: 'stroke-accent-2', areaClass: 'fill-accent-2/10', data: storage()?.map((p) => p.bytesAdded) ?? [] },
            ]}
            formatX={(t) => formatDate(t)}
            formatY={(v) => formatBytes(v)}
            height={160}
          />
        </Show>
      </Card>

      <Card noPad>
        <div class="flex items-center justify-between px-4 py-2 border-b border-border">
          <div class="flex items-center gap-3">
            <h2 class="text-xs font-semibold m-0 uppercase tracking-wider text-fg-2">Entries</h2>
            <select value={sort()} onChange={(e) => setSort(e.currentTarget.value as Sort)} class="text-[11px]">
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
            class="text-[11px] font-mono w-60"
          />
        </div>
        <Show when={filtered().length > 0} fallback={<EmptyState title="No matching entries" />}>
          <table class="w-full text-[12px]">
            <thead class="bg-surface-2/40">
              <tr class="text-fg-3 text-[10px] uppercase tracking-wider">
                <th class="text-left px-4 py-2 font-semibold">Task</th>
                <th class="text-left px-4 py-2 font-semibold">Hash</th>
                <th class="text-right px-4 py-2 font-semibold">Size</th>
                <th class="text-right px-4 py-2 font-semibold">Duration</th>
                <th class="text-right px-4 py-2 font-semibold">Created</th>
                <th class="text-right px-4 py-2 font-semibold">Accessed</th>
              </tr>
            </thead>
            <tbody>
              <For each={filtered()}>
                {(e) => (
                  <tr
                    class="border-t border-border hover:bg-surface-hover cursor-pointer"
                    onClick={() => navigate(`/tasks/${encodeURIComponent(`${e.project}#${e.task}`)}`)}
                  >
                    <td class="px-4 py-1.5 font-mono">
                      <span class="text-fg-3">{e.project}#</span>{e.task}
                    </td>
                    <td class="px-4 py-1.5 font-mono text-[10px] text-fg-3">{e.hash.slice(0, 12)}…</td>
                    <td class="px-4 py-1.5 text-right font-mono">{formatBytes(e.sizeBytes)}</td>
                    <td class="px-4 py-1.5 text-right font-mono">{formatDuration(e.durationMs)}</td>
                    <td class="px-4 py-1.5 text-right text-fg-3 font-mono text-[10px]">{formatRelativeTime(e.createdAt)}</td>
                    <td class="px-4 py-1.5 text-right text-fg-3 font-mono text-[10px]">{formatRelativeTime(e.accessedAt)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </Card>
    </div>
  )
}
