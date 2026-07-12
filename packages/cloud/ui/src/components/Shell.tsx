import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type ParentComponent,
} from 'solid-js'
import { A, useLocation, useNavigate } from '@solidjs/router'
import {
  acceptInvite,
  getCurrentUserSignal,
  getMeta,
  getOrgSignal,
  getOrgsSignal,
  getOriginSignal,
  getWorkspaceSignal,
  getWorkspacesSignal,
  logout,
  refreshCapabilities,
  refreshOrgs,
  refreshWorkspaces,
  setOrgAndPersist,
  setWorkspaceAndPersist,
  type OrgSummary,
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
  const user = getCurrentUserSignal()
  const org = getOrgSignal()
  const navigate = useNavigate()
  const location = useLocation()
  // Keyed on origin + user + org so switching account/org refetches metadata.
  const connection = () => `${origin()}|${user()?.userId ?? ''}|${org()}`
  const [meta] = createResource(connection, async () => {
    try {
      return await getMeta()
    } catch {
      return null
    }
  })
  const [paletteOpen, setPaletteOpen] = createSignal(false)

  // Admin is visible to instance admins and anyone with admin/owner in some org.
  const canSeeAdmin = createMemo(() => {
    const u = user()
    if (u === null) return false
    if (u.instanceAdmin) return true
    return u.orgs.some((o) => o.role === 'admin' || o.role === 'owner')
  })

  // (Re-)probe serve capabilities + refresh the org/workspace lists whenever
  // the connection (origin/user/org) changes — the Shell is always mounted, so
  // these signals stay fresh for every view.
  createEffect(() => {
    void connection()
    refreshCapabilities()
    refreshOrgs()
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

  return (
    <div class="min-h-full flex bg-bg">
      {/* Sidebar — detached floating card */}
      <aside class="w-56 shrink-0 m-3 rounded-2xl border border-border/70 bg-surface/60 backdrop-blur-xl shadow-elevated flex flex-col sticky top-3 self-start h-[calc(100vh-1.5rem)] overflow-hidden">
        <div class="h-14 px-4 flex items-center gap-2.5 border-b border-border/70">
          <div class="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-accent-2 flex items-center justify-center text-bg font-bold text-[13px] shadow-glow">
            vx
          </div>
          <span class="font-mono text-sm text-fg-1 font-semibold tracking-tight">vx cloud</span>
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
          <Show when={canSeeAdmin()}>
            <A
              href="/admin"
              class="group flex items-center gap-2.5 px-3 py-2 rounded-lg text-fg-2 hover:text-fg hover:bg-surface-hover/70 transition-all text-[13px] no-underline mt-1"
              activeClass="!text-accent !bg-accent/10 font-medium ring-1 ring-inset ring-accent/20"
            >
              <span class="i-tabler-shield-lock text-base shrink-0 opacity-80 group-hover:opacity-100" aria-hidden="true" />
              <span>Admin</span>
            </A>
          </Show>
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
          <OrgSwitcher />
          <WorkspaceSwitcher />
          <ServerBadge name={meta()?.name} />
          <AccountMenu />
        </header>

        <main class="flex-1 p-6 max-w-[1440px] w-full mx-auto">{props.children}</main>

        <footer class="px-4 py-2 border-t border-border text-[11px] text-fg-3 text-center">
          <Show when={meta()} fallback={<>Connecting…</>}>
            {(m) => (
              <>
                vx {m().vx} · <code class="font-mono">{m().name}</code> · self-hosted platform
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
 * visible and auto-refresh is running, a static grey "paused" when hidden.
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

/** Server identity badge — the connected platform's name + a health dot. */
function ServerBadge(props: { name: string | undefined }) {
  const origin = getOriginSignal()
  return (
    <span
      class="hidden sm:flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded border border-border"
      title={`${props.name ?? 'platform'} · ${origin()}`}
    >
      <StatusDot ok={props.name !== undefined} />
      <span class="text-fg-1 font-medium max-w-32 truncate">{props.name ?? origin().replace(/^https?:\/\//, '')}</span>
    </span>
  )
}

/**
 * Org context dropdown, fed by GET /v1/admin/orgs. Selection persists via
 * api.ts (`vx-ui:org`) and rides every analytics read as `?org=` (the tenant
 * clamp). Also offers joining another org with an invite token.
 */
function OrgSwitcher() {
  const list = getOrgsSignal()
  const selected = getOrgSignal()
  const [open, setOpen] = createSignal(false)

  const current = (): OrgSummary | undefined => list().find((o) => o.id === selected()) ?? list()[0]
  const currentName = () => current()?.name ?? '—'

  onMount(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  function pick(id: string) {
    setOrgAndPersist(id)
    setOpen(false)
  }

  async function join() {
    setOpen(false)
    const token = window.prompt('Paste an invite token (vxi_…) to join an organization:')
    if (token === null || token.trim() === '') return
    const r = await acceptInvite(token.trim())
    if (!r.ok) window.alert(r.error ?? 'Could not join with that invite.')
  }

  return (
    <Show when={list().length > 0}>
      <div class="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          class="flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded border border-border hover:border-border-strong hover:bg-surface-hover"
          title={`Organization: ${currentName()} — click to switch`}
        >
          <span class="i-tabler-building text-fg-3 text-[13px]" aria-hidden="true" />
          <span class="text-fg-1 font-medium max-w-40 truncate">{currentName()}</span>
          <span class="i-tabler-chevron-down text-fg-3 text-[12px]" aria-hidden="true" />
        </button>
        <Show when={open()}>
          <div class="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div class="absolute right-0 top-full mt-1.5 z-50 w-64 bg-surface border border-border-strong rounded-lg shadow-2xl overflow-hidden">
            <div class="px-3 py-1.5 border-b border-border text-[10px] uppercase tracking-wider text-fg-3 font-semibold">
              Organizations
            </div>
            <div class="max-h-72 overflow-y-auto py-1">
              <For each={list()}>
                {(o) => (
                  <button
                    onClick={() => pick(o.id)}
                    class="w-full text-left flex items-center gap-2 px-3 py-2 hover:bg-surface-hover transition-colors"
                  >
                    <span class={`i-tabler-check text-[13px] shrink-0 ${o.id === (current()?.id ?? '') ? 'text-accent' : 'opacity-0'}`} aria-hidden="true" />
                    <span class="min-w-0 flex-1">
                      <span class="block text-[12px] font-mono truncate text-fg-1">{o.name}</span>
                      <span class="block text-[10px] text-fg-3">{o.slug} · {o.role}</span>
                    </span>
                  </button>
                )}
              </For>
            </div>
            <button
              onClick={() => void join()}
              class="w-full text-left flex items-center gap-2 px-3 py-2 border-t border-border text-[12px] text-fg-2 hover:bg-surface-hover hover:text-fg transition-colors"
            >
              <span class="i-tabler-plus text-[13px]" aria-hidden="true" />
              Join with an invite…
            </button>
          </div>
        </Show>
      </div>
    </Show>
  )
}

/** Account menu — the signed-in identity + sign-out. */
function AccountMenu() {
  const user = getCurrentUserSignal()
  const [open, setOpen] = createSignal(false)

  onMount(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  return (
    <div class="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        class="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border border-border hover:border-border-strong hover:bg-surface-hover"
        title="Account"
      >
        <span class="i-tabler-user-circle text-fg-2 text-base" aria-hidden="true" />
        <Show when={user()?.instanceAdmin}>
          <span class="i-tabler-star-filled text-warn text-[11px]" aria-hidden="true" title="instance admin" />
        </Show>
      </button>
      <Show when={open()}>
        <div class="fixed inset-0 z-40" onClick={() => setOpen(false)} />
        <div class="absolute right-0 top-full mt-1.5 z-50 w-56 bg-surface border border-border-strong rounded-lg shadow-2xl overflow-hidden">
          <div class="px-3 py-2 border-b border-border">
            <div class="text-[12px] text-fg-1 font-medium">Signed in</div>
            <Show when={user()?.instanceAdmin}>
              <div class="text-[10px] text-warn font-mono mt-0.5">instance admin</div>
            </Show>
            <div class="text-[10px] text-fg-3 font-mono truncate mt-0.5">{user()?.userId}</div>
          </div>
          <button
            onClick={() => void logout()}
            class="w-full text-left flex items-center gap-2 px-3 py-2 text-[12px] text-danger hover:bg-danger/10 transition-colors"
          >
            <span class="i-tabler-logout text-[13px]" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </Show>
    </div>
  )
}

/**
 * Workspace context dropdown. Fed by /v1/workspaces (org-scoped); selection
 * persists via api.ts (`vx-ui:workspace`) and rides every /v1 analytics read
 * as `?ws=`. Hidden on a 0/1-workspace org so the solo case looks clean.
 */
function WorkspaceSwitcher() {
  const list = getWorkspacesSignal()
  const selected = getWorkspaceSignal()
  const [open, setOpen] = createSignal(false)

  // Most-recently-active first — long-lived orgs accumulate dead workspaces.
  const sorted = createMemo(() => [...list()].sort((a, b) => b.lastSeenAt - a.lastSeenAt))
  const currentId = () => {
    const sel = selected()
    if (sel !== '') return sel
    return sorted()[0]?.id ?? ''
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
                      <span class={`block text-[12px] font-mono truncate ${w.id === currentId() ? 'text-fg' : 'text-fg-1'}`}>
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
