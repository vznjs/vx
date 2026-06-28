import { createResource, createSignal, Show, type ParentComponent } from 'solid-js'
import { A, useLocation, useNavigate } from '@solidjs/router'
import { getOrigin, getOriginSignal, getVersion, setOriginAndPersist } from '../api.ts'
import { CommandPalette } from './CommandPalette.tsx'
import { StatusDot } from './ui.tsx'

interface NavItem {
  href: string
  label: string
  icon: string
}

const NAV: NavItem[] = [
  { href: '/run', label: 'Run', icon: 'i-tabler-player-play' },
  { href: '/', label: 'Overview', icon: 'i-tabler-layout-dashboard' },
  { href: '/projects', label: 'Projects', icon: 'i-tabler-stack-2' },
  { href: '/tasks', label: 'Tasks', icon: 'i-tabler-list-details' },
  { href: '/runs', label: 'Runs', icon: 'i-tabler-history' },
  { href: '/bottlenecks', label: 'Bottlenecks', icon: 'i-tabler-flame' },
  { href: '/trends', label: 'Trends', icon: 'i-tabler-chart-line' },
  { href: '/cache', label: 'Cache', icon: 'i-tabler-database' },
]

export const Shell: ParentComponent = (props) => {
  const origin = getOriginSignal()
  const navigate = useNavigate()
  const location = useLocation()
  const [version] = createResource(origin, async () => {
    try {
      return await getVersion()
    } catch {
      return null
    }
  })
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal(getOrigin())
  const [paletteOpen, setPaletteOpen] = createSignal(false)

  // Global Cmd/Ctrl-K for palette.
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
      }
      if (e.key === 'Escape') setPaletteOpen(false)
    })
  }

  function commit() {
    setOriginAndPersist(draft())
    setEditing(false)
  }

  return (
    <div class="min-h-full flex bg-bg">
      {/* Sidebar — detached floating card */}
      <aside class="w-56 shrink-0 m-3 rounded-2xl border border-border/70 bg-surface/60 backdrop-blur-xl shadow-elevated flex flex-col sticky top-3 self-start h-[calc(100vh-1.5rem)] overflow-hidden">
        <div class="h-14 px-4 flex items-center gap-2.5 border-b border-border/70">
          <div class="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-accent-2 flex items-center justify-center text-bg font-bold text-[13px] shadow-glow">
            vx
          </div>
          <span class="font-mono text-sm text-fg-1 font-semibold tracking-tight">vx insights</span>
        </div>
        <nav class="flex-1 p-2.5 flex flex-col gap-0.5">
          {NAV.map((item) => (
            <A
              href={item.href}
              end={item.href === '/'}
              class="group flex items-center gap-2.5 px-3 py-2 rounded-lg text-fg-2 hover:text-fg hover:bg-surface-hover/70 transition-all text-[13px] no-underline"
              activeClass="!text-accent !bg-accent/10 font-medium ring-1 ring-inset ring-accent/20"
            >
              <span class={`${item.icon} text-base shrink-0 opacity-80 group-hover:opacity-100`} aria-hidden="true" />
              <span>{item.label}</span>
            </A>
          ))}
        </nav>
        <div class="p-2.5 border-t border-border/70">
          <button
            onClick={() => setPaletteOpen(true)}
            class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-fg-3 hover:text-fg hover:bg-surface-hover/70 text-[12px] transition-all"
          >
            <span class="i-tabler-search text-base shrink-0" />
            <span>Search</span>
            <kbd class="ml-auto">⌘K</kbd>
          </button>
        </div>
      </aside>

      {/* Main */}
      <div class="flex-1 min-w-0 flex flex-col">
        {/* Topbar */}
        <header class="h-14 px-5 border-b border-border/70 bg-bg/60 backdrop-blur-xl flex items-center gap-3 sticky top-0 z-10">
          <Breadcrumb pathname={location.pathname} />
          <div class="flex-1" />
          <Show
            when={editing()}
            fallback={
              <button
                onClick={() => {
                  setDraft(getOrigin())
                  setEditing(true)
                }}
                class="flex items-center gap-2 text-[11px] font-mono px-2.5 py-1 rounded border border-border hover:border-border-strong hover:bg-surface-hover"
                title="Change connection (Cmd/Ctrl-click to edit)"
              >
                <StatusDot ok={version() !== null && version() !== undefined} />
                <span class="text-fg-2">{origin().replace(/^https?:\/\//, '')}</span>
              </button>
            }
          >
            <form
              onSubmit={(e) => {
                e.preventDefault()
                commit()
              }}
              class="flex items-center gap-1"
            >
              <input
                type="url"
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                placeholder="http://localhost:4321"
                class="text-[12px] font-mono w-60"
                autofocus
              />
              <button type="submit" class="text-[11px] px-2 py-1 rounded border border-accent text-accent hover:bg-accent hover:text-bg transition-colors">
                connect
              </button>
              <button type="button" onClick={() => setEditing(false)} class="text-[11px] px-2 py-1 rounded text-fg-3 hover:text-fg">
                cancel
              </button>
            </form>
          </Show>
        </header>

        <main class="flex-1 p-6 max-w-[1440px] w-full mx-auto">{props.children}</main>

        <footer class="px-4 py-2 border-t border-border text-[11px] text-fg-3 text-center">
          <Show
            when={version()}
            fallback={<>Not connected. Start <code>vx serve</code> in your workspace.</>}
          >
            {(v) => (
              <>
                vx {v().vx} · workspace <code class="font-mono">{v().workspace}</code>
              </>
            )}
          </Show>
        </footer>
      </div>

      <CommandPalette open={paletteOpen()} onClose={() => setPaletteOpen(false)} onSelect={(href) => { setPaletteOpen(false); navigate(href) }} />
    </div>
  )
}

function Breadcrumb(props: { pathname: string }) {
  const seg = () => {
    const parts = props.pathname.split('/').filter(Boolean)
    if (parts.length === 0) return ['Overview']
    return parts
  }
  return (
    <div class="flex items-center gap-1.5 text-[13px] font-medium text-fg-1">
      {seg().map((s, i) => (
        <>
          <Show when={i > 0}><span class="text-fg-3">/</span></Show>
          <span class={i === seg().length - 1 ? 'text-fg' : 'text-fg-2'}>
            {decodeURIComponent(s).replace(/^./, (c) => c.toUpperCase())}
          </span>
        </>
      ))}
    </div>
  )
}
