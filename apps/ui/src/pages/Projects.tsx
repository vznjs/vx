import { For, Show, createMemo, createResource, createSignal } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { getOriginSignal, listProjects, type ProjectRollup } from '../api.ts'
import { Card, EmptyState } from '../components/ui.tsx'
import { HBar } from '../components/charts.tsx'
import { formatBytes, formatDuration, formatPercent, formatRelativeTime, paletteFor } from '../format.ts'

type Sort = 'name' | 'runs' | 'totalDurationMs' | 'estimatedTimeSavedMs' | 'hitRate' | 'cacheBytes' | 'lastRunAt' | 'failures'

export function Projects() {
  const origin = getOriginSignal()
  const [data] = createResource(origin, () => listProjects(500))
  const [sort, setSort] = createSignal<Sort>('totalDurationMs')
  const [desc, setDesc] = createSignal(true)
  const [filter, setFilter] = createSignal('')
  const navigate = useNavigate()

  const rows = createMemo(() => {
    const items = data() ?? []
    const f = filter().toLowerCase().trim()
    const filtered = f ? items.filter((p) => p.project.toLowerCase().includes(f)) : items
    return [...filtered].sort((a, b) => {
      const va = pluck(a, sort())
      const vb = pluck(b, sort())
      const cmp = va === vb ? 0 : va > vb ? 1 : -1
      return desc() ? -cmp : cmp
    })
  })

  const totals = createMemo(() => {
    const items = data() ?? []
    return {
      totalTime: items.reduce((a, p) => a + p.totalDurationMs, 0),
      maxTime: Math.max(1, ...items.map((p) => p.totalDurationMs)),
      maxSaved: Math.max(1, ...items.map((p) => p.estimatedTimeSavedMs)),
      maxBytes: Math.max(1, ...items.map((p) => p.cacheBytes)),
    }
  })

  function onSort(k: Sort) {
    if (sort() === k) setDesc(!desc())
    else {
      setSort(k)
      setDesc(true)
    }
  }

  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-3">
        <h1 class="text-base font-semibold m-0">Projects</h1>
        <input
          type="text"
          placeholder="filter…"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          class="text-[12px] font-mono w-64"
        />
      </div>

      <Card noPad>
        <Show when={(data() ?? []).length > 0} fallback={<EmptyState title="No projects discovered" cmd="vx run <task>" />}>
          <table class="w-full text-[12px]">
            <thead class="bg-surface-2/40">
              <tr class="text-fg-3 text-[10px] uppercase tracking-wider">
                <Th k="name" curr={sort()} desc={desc()} onSort={onSort} align="left">Project</Th>
                <Th k="runs" curr={sort()} desc={desc()} onSort={onSort}>Runs</Th>
                <Th k="failures" curr={sort()} desc={desc()} onSort={onSort}>Failures</Th>
                <Th k="hitRate" curr={sort()} desc={desc()} onSort={onSort}>Hit %</Th>
                <Th k="totalDurationMs" curr={sort()} desc={desc()} onSort={onSort}>Total time</Th>
                <Th k="estimatedTimeSavedMs" curr={sort()} desc={desc()} onSort={onSort}>Saved</Th>
                <Th k="cacheBytes" curr={sort()} desc={desc()} onSort={onSort}>Cache</Th>
                <Th k="lastRunAt" curr={sort()} desc={desc()} onSort={onSort}>Last run</Th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(p) => (
                  <tr
                    class="border-t border-border hover:bg-surface-hover cursor-pointer"
                    onClick={() => navigate(`/projects/${encodeURIComponent(p.project)}`)}
                  >
                    <td class="px-4 py-2 font-mono">
                      <div class="flex items-center gap-2">
                        <span class={`inline-block w-1.5 h-1.5 rounded-full bg-${paletteFor(p.project)}`} />
                        <span class="truncate">{p.project}</span>
                        <span class="text-fg-3 text-[10px]">· {p.taskCount} tasks</span>
                      </div>
                    </td>
                    <td class="px-4 py-2 text-right font-mono">{p.runs}</td>
                    <td class="px-4 py-2 text-right font-mono" classList={{ 'text-danger': p.failures > 0 }}>{p.failures}</td>
                    <td class="px-4 py-2 text-right font-mono text-cache-local">{formatPercent(p.hitRate, 0)}</td>
                    <td class="px-4 py-2 text-right font-mono">
                      <div class="flex items-center gap-2 justify-end">
                        <span class="w-16">{formatDuration(p.totalDurationMs)}</span>
                        <div class="w-20">
                          <HBar fraction={p.totalDurationMs / totals().maxTime} colorClass={`bg-${paletteFor(p.project)}`} />
                        </div>
                      </div>
                    </td>
                    <td class="px-4 py-2 text-right font-mono text-success">{formatDuration(p.estimatedTimeSavedMs)}</td>
                    <td class="px-4 py-2 text-right font-mono">{formatBytes(p.cacheBytes)}</td>
                    <td class="px-4 py-2 text-right text-fg-3 font-mono text-[10px]">{p.lastRunAt ? formatRelativeTime(p.lastRunAt) : '—'}</td>
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

function pluck(p: ProjectRollup, k: Sort): number | string {
  switch (k) {
    case 'name': return p.project
    case 'runs': return p.runs
    case 'failures': return p.failures
    case 'hitRate': return p.hitRate
    case 'totalDurationMs': return p.totalDurationMs
    case 'estimatedTimeSavedMs': return p.estimatedTimeSavedMs
    case 'cacheBytes': return p.cacheBytes
    case 'lastRunAt': return p.lastRunAt ?? 0
  }
}

function Th(props: { k: Sort; curr: Sort; desc: boolean; onSort: (k: Sort) => void; align?: 'left' | 'right'; children: any }) {
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
