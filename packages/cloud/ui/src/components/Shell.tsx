import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show, type ParentComponent } from 'solid-js'
import { A, useLocation, useNavigate } from '@solidjs/router'
import {
  getMeta,
  getOrigin,
  getOriginSignal,
  getToken,
  getTokenSignal,
  getUnauthorizedSignal,
  getVersion,
  getWorkspaceSignal,
  getWorkspacesSignal,
  refreshCapabilities,
  refreshWorkspaces,
  setOriginAndPersist,
  setTokenAndPersist,
  setWorkspaceAndPersist,
} from '../api.ts'
import { getLiveActiveSignal, getVisibleSignal } from '../live.ts'
import { formatCount, formatRelativeTime } from '../format.ts'
import { CommandPalette } from './CommandPalette.tsx'
import { StatusDot } from './ui.tsx'

interface NavItem {
  href: string
  label: string
  icon: string
}

// Entity order (cloud-data-model-2026-07 §4.2): the unified Runs view first,
// then the entities, then the cross-entity Insights analytics area.
const NAV: NavItem[] = [
  { href: '/runs', label: 'Runs', icon: 'i-tabler-player-play' },
  { href: '/overview', label: 'Workspace', icon: 'i-tabler-layout-dashboard' },
  { href: '/projects', label: 'Projects', icon: 'i-tabler-stack-2' },
  { href: '/tasks', label: 'Tasks', icon: 'i-tabler-list-details' },
  { href: '/cache', label: 'Cache', icon: 'i-tabler-database' },
  { href: '/artifacts', label: 'Artifacts', icon: 'i-tabler-package' },
  { href: '/insights', label: 'Insights', icon: 'i-tabler-chart-line' },
]

export const Shell: ParentComponent = (props) => {
  const origin = getOriginSignal()
  const token = getTokenSignal()
  const unauthorized = getUnauthorizedSignal()
  const navigate = useNavigate()
  const location = useLocation()
  // Keyed on origin + token so entering a token refetches immediately.
  const connection = () => `${origin()}|${token()}`
  const [version] = createResource(connection, async () => {
    try {
      return await getVersion()
    } catch {
      return null
    }
  })
  // Server identity for the environment badge — /v1/meta is auth-exempt, so
  // the badge names the server even before a token is entered.
  const [meta] = createResource(connection, async () => {
    try {
      return await getMeta()
    } catch {
      return null
    }
  })
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal(getOrigin())
  const [draftToken, setDraftToken] = createSignal(getToken())
  const [paletteOpen, setPaletteOpen] = createSignal(false)

  // (Re-)probe serve capabilities + workspace list whenever the connection
  // changes — the Shell is always mounted, so both signals stay fresh for
  // every view. Both refreshers read the origin/token/workspace signals, so
  // the effect tracks them (capabilities also re-probe on workspace switch:
  // the cache-entry probe reads workspace-scoped data).
  createEffect(() => {
    void connection()
    refreshCapabilities()
    refreshWorkspaces()
  })

  // Global Cmd/Ctrl-K for palette.
  onMount(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
      }
      if (e.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  function commit() {
    setOriginAndPersist(draft())
    setTokenAndPersist(draftToken())
    setEditing(false)
  }

  function openEditor() {
    setDraft(getOrigin())
    setDraftToken(getToken())
    setEditing(true)
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
          <LiveIndicator />
          <WorkspaceSwitcher />
          <Show when={unauthorized() && !editing()}>
            <button
              onClick={openEditor}
              class="flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded border border-danger/50 text-danger hover:bg-danger/10 transition-colors"
              title="This server requires a token"
            >
              <span class="i-tabler-lock text-[13px]" aria-hidden="true" />
              <span>401 — token required</span>
            </button>
          </Show>
          <Show
            when={editing()}
            fallback={
              <button
                onClick={openEditor}
                class="flex items-center gap-2 text-[11px] font-mono px-2.5 py-1 rounded border border-border hover:border-border-strong hover:bg-surface-hover"
                title={
                  meta()
                    ? `${meta()!.name} · ${origin()} · auth: ${meta()!.auth === 'token' ? 'token required' : 'open'} — click to change connection`
                    : 'Change connection'
                }
              >
                <StatusDot ok={version() !== null && version() !== undefined} />
                <Show when={meta()}>
                  {(m) => <span class="text-fg-1 font-medium">{m().name}</span>}
                </Show>
                <span class="text-fg-2">{origin().replace(/^https?:\/\//, '')}</span>
                <Show when={meta()?.auth === 'token'}>
                  <span class="i-tabler-lock text-fg-3 text-[12px]" aria-hidden="true" />
                </Show>
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
              <input
                type="password"
                value={draftToken()}
                onInput={(e) => setDraftToken(e.currentTarget.value)}
                placeholder="token (optional)"
                class="text-[12px] font-mono w-40"
                autocomplete="off"
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

/**
 * Live-refresh status pill. Shown only while a live-refreshing view is mounted
 * (the ref-count in live.ts): a pulsing green dot + "live" when the tab is
 * visible and auto-refresh is running, a static grey "paused" when the tab is
 * hidden (the interval is suspended to save work).
 */
function LiveIndicator() {
  const active = getLiveActiveSignal()
  const visible = getVisibleSignal()
  return (
    <Show when={active()}>
      <span
        class="inline-flex items-center gap-1.5 text-[11px] font-mono px-2 py-1 rounded border border-border"
        classList={{ 'text-success': visible(), 'text-fg-3': !visible() }}
        title={visible() ? 'Auto-refreshing — new runs and metrics appear live' : 'Paused — this tab is in the background'}
      >
        <span
          class="inline-block w-1.5 h-1.5 rounded-full"
          classList={{ 'bg-success animate-pulse': visible(), 'bg-fg-3': !visible() }}
        />
        {visible() ? 'live' : 'paused'}
      </span>
    </Show>
  )
}

/**
 * Docker-Desktop-style workspace context dropdown. Fed by /v1/workspaces;
 * selection persists via api.ts (`vx-ui:workspace`) and rides every /v1
 * analytics read as `?ws=` — the jr loader re-fetches on the switch. Hidden
 * on a 0/1-workspace serve so the solo-dev shell looks exactly like today.
 */
function WorkspaceSwitcher() {
  const list = getWorkspacesSignal()
  const selected = getWorkspaceSignal()
  const [open, setOpen] = createSignal(false)

  // Most-recently-active first — long-lived serves accumulate dead workspaces.
  const sorted = createMemo(() => [...list()].sort((a, b) => b.lastSeenAt - a.lastSeenAt))
  // No explicit selection → mirror the serve's un-scoped rule: a genuine
  // 'default' workspace when one exists, else the most-recently-seen.
  const currentId = () => {
    const sel = selected()
    if (sel !== '') return sel
    if (list().some((w) => w.id === 'default')) return 'default'
    return sorted()[0]?.id ?? 'default'
  }
  const currentName = () => list().find((w) => w.id === currentId())?.name ?? currentId()

  onMount(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  function pick(id: string) {
    setWorkspaceAndPersist(id)
    setOpen(false)
  }

  return (
    <Show when={list().length > 1}>
      <div class="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          class="flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded border border-border hover:border-border-strong hover:bg-surface-hover"
          title={`Workspace: ${currentName()} — click to switch`}
        >
          <span class="i-tabler-folders text-fg-3 text-[13px]" aria-hidden="true" />
          <span class="text-fg-1 font-medium max-w-40 truncate">{currentName()}</span>
          <span class="i-tabler-chevron-down text-fg-3 text-[12px]" aria-hidden="true" />
        </button>
        <Show when={open()}>
          {/* invisible backdrop: click-outside closes without swallowing the next click's target styling */}
          <div class="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div class="absolute right-0 top-full mt-1.5 z-50 w-72 bg-surface border border-border-strong rounded-lg shadow-2xl overflow-hidden">
            <div class="px-3 py-1.5 border-b border-border text-[10px] uppercase tracking-wider text-fg-3 font-semibold">
              Workspaces
            </div>
            <div class="max-h-80 overflow-y-auto py-1">
              <For each={sorted()}>
                {(w) => (
                  <button
                    onClick={() => pick(w.id)}
                    class="w-full text-left flex items-center gap-2 px-3 py-2 hover:bg-surface-hover transition-colors"
                  >
                    <span
                      class={`i-tabler-check text-[13px] shrink-0 ${w.id === currentId() ? 'text-accent' : 'opacity-0'}`}
                      aria-hidden="true"
                    />
                    <span class="min-w-0 flex-1">
                      <span
                        class={`block text-[12px] font-mono truncate ${w.id === currentId() ? 'text-fg' : 'text-fg-1'}`}
                      >
                        {w.name}
                      </span>
                      <span class="block text-[10px] text-fg-3">
                        {formatRelativeTime(w.lastSeenAt)}
                        {w.runCount !== undefined ? ` · ${formatCount(w.runCount)} runs` : ''}
                      </span>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  )
}

function Breadcrumb(props: { pathname: string }) {
  const seg = () => {
    const parts = props.pathname.split('/').filter(Boolean)
    if (parts.length === 0) return ['vx']
    return parts
  }
  return (
    <div class="flex items-center gap-1.5 text-[13px] font-medium text-fg-1">
      {seg().map((s, i) => (
        <>
          <Show when={i > 0}><span class="text-fg-3">/</span></Show>
          <span class={`${i === seg().length - 1 ? 'text-fg' : 'text-fg-2'} ${i > 0 ? 'font-mono text-[12px]' : ''}`}>
            {/* Only the first segment is a static route name — later segments
                are ids/UUIDs and must not be title-cased. The /overview route
                keeps its URL but reads as the Workspace entity page. */}
            {i === 0
              ? s === 'overview'
                ? 'Workspace'
                : decodeURIComponent(s).replace(/^./, (c) => c.toUpperCase())
              : decodeURIComponent(s)}
          </span>
        </>
      ))}
    </div>
  )
}
