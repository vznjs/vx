import { For, Show, createMemo, createResource, createSignal } from 'solid-js'
import { getHistory, listProjects } from '../api.ts'

type Item =
  | { kind: 'nav'; href: string; label: string; group: string }
  | { kind: 'project'; project: string; href: string; group: string; label: string }
  | { kind: 'task'; id: string; href: string; group: string; label: string }

const STATIC_NAV: Item[] = [
  { kind: 'nav', href: '/', label: 'Overview', group: 'Navigation' },
  { kind: 'nav', href: '/projects', label: 'Projects', group: 'Navigation' },
  { kind: 'nav', href: '/tasks', label: 'Tasks', group: 'Navigation' },
  { kind: 'nav', href: '/bottlenecks', label: 'Bottlenecks', group: 'Navigation' },
  { kind: 'nav', href: '/trends', label: 'Trends', group: 'Navigation' },
  { kind: 'nav', href: '/cache', label: 'Cache', group: 'Navigation' },
]

export function CommandPalette(props: {
  open: boolean
  onClose: () => void
  onSelect: (href: string) => void
}) {
  const [query, setQuery] = createSignal('')
  const [active, setActive] = createSignal(0)
  const [projects] = createResource(
    () => props.open,
    async (open) => (open ? await listProjects(100) : []),
  )
  const [tasks] = createResource(
    () => props.open,
    async (open) => (open ? await getHistory(500) : []),
  )

  const all = createMemo<Item[]>(() => {
    const items: Item[] = [...STATIC_NAV]
    for (const p of projects() ?? []) {
      items.push({
        kind: 'project',
        project: p.project,
        href: `/projects/${encodeURIComponent(p.project)}`,
        group: 'Projects',
        label: p.project,
      })
    }
    for (const t of tasks() ?? []) {
      items.push({
        kind: 'task',
        id: t.id,
        href: `/tasks/${encodeURIComponent(t.id)}`,
        group: 'Tasks',
        label: t.id,
      })
    }
    return items
  })

  const filtered = createMemo(() => {
    const q = query().toLowerCase().trim()
    if (!q) return all().slice(0, 8)
    return all()
      .filter((i) => i.label.toLowerCase().includes(q))
      .slice(0, 50)
  })

  const grouped = createMemo(() => {
    const map = new Map<string, Item[]>()
    for (const item of filtered()) {
      if (!map.has(item.group)) map.set(item.group, [])
      map.get(item.group)!.push(item)
    }
    return Array.from(map.entries())
  })

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(filtered().length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const sel = filtered()[active()]
      if (sel) props.onSelect(sel.href)
    }
  }

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-bg/80 backdrop-blur-sm"
        onClick={props.onClose}
      >
        <div
          class="bg-surface border border-border-strong rounded-lg shadow-2xl w-[560px] max-h-[60vh] overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
            <span class="i-tabler-search text-fg-3" />
            <input
              type="text"
              placeholder="Search projects, tasks…"
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value)
                setActive(0)
              }}
              onKeyDown={onKeyDown}
              autofocus
              class="flex-1 bg-transparent border-none p-0 focus:!shadow-none focus:!border-none text-[14px]"
            />
            <kbd>esc</kbd>
          </div>
          <div class="flex-1 overflow-y-auto py-2">
            <Show when={filtered().length === 0}>
              <div class="px-4 py-8 text-center text-fg-3 text-sm">No matches.</div>
            </Show>
            <For each={grouped()}>
              {([group, items]) => (
                <div class="mb-2">
                  <div class="px-4 py-1 text-[10px] uppercase tracking-wider text-fg-3 font-semibold">
                    {group}
                  </div>
                  <For each={items}>
                    {(item) => {
                      const idx = filtered().indexOf(item)
                      return (
                        <button
                          onClick={() => props.onSelect(item.href)}
                          onMouseEnter={() => setActive(idx)}
                          class="w-full text-left flex items-center gap-2 px-4 py-1.5 text-[13px] font-mono"
                          classList={{
                            'bg-surface-hover text-fg': active() === idx,
                            'text-fg-2': active() !== idx,
                          }}
                        >
                          <span
                            class={
                              item.kind === 'project'
                                ? 'i-tabler-stack-2 text-fg-3'
                                : item.kind === 'task'
                                  ? 'i-tabler-list-details text-fg-3'
                                  : 'i-tabler-arrow-right text-fg-3'
                            }
                          />
                          <span class="truncate">{item.label}</span>
                        </button>
                      )
                    }}
                  </For>
                </div>
              )}
            </For>
          </div>
          <div class="px-4 py-2 border-t border-border text-[10px] text-fg-3 font-mono flex gap-3">
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> navigate
            </span>
            <span>
              <kbd>↵</kbd> select
            </span>
            <span>
              <kbd>esc</kbd> close
            </span>
          </div>
        </div>
      </div>
    </Show>
  )
}
