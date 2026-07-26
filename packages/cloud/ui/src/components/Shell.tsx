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
  fetchNotifications,
  getConnectionKey,
  getCurrentUserSignal,
  getMeta,
  getNotificationsSeenAt,
  getOrgSignal,
  getOrgsSignal,
  getOriginSignal,
  getWorkspaceSignal,
  getWorkspacesSignal,
  logout,
  markNotificationsSeen,
  refreshCapabilities,
  refreshOrgs,
  refreshWorkspaces,
  setOrgAndPersist,
  setWorkspaceAndPersist,
  wasWorkspaceRemovedHere,
  type NotificationItem,
  type OrgSummary,
  type WorkspaceInfo,
} from '../api.ts'
import { getLiveActiveSignal, getVisibleSignal, useVisibilityRefresh } from '../live.ts'
import { pinnedProjects } from '../pins.ts'
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

/**
 * Most-recently-active first — long-lived orgs accumulate dead workspaces, and
 * this must match what the server picks when no `?ws=` is given, or the URL
 * would mirror a different workspace than the data came from.
 */
function sortedWorkspaces(list: readonly WorkspaceInfo[]): WorkspaceInfo[] {
  return [...list].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}

/**
 * A workspace id that arrived in a shared link but is not one this account can
 * see. Module scope so the banner survives the re-render the fallback causes.
 */
const [deniedWorkspace, setDeniedWorkspace] = createSignal('')

export const Shell: ParentComponent = (props) => {
  const origin = getOriginSignal()
  const user = getCurrentUserSignal()
  const org = getOrgSignal()
  const navigate = useNavigate()
  const location = useLocation()
  const workspaceSel = getWorkspaceSignal()
  const workspaceList = getWorkspacesSignal()
  const currentWorkspaceName = () => {
    const sel = workspaceSel()
    const id = sel !== '' ? sel : (sortedWorkspaces(workspaceList())[0]?.id ?? '')
    return workspaceList().find((w) => w.id === id)?.name ?? id
  }
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

  // ---- workspace context in the URL --------------------------------------
  // The selection is the SCOPE of every page, so a shared link must carry it —
  // stored only in localStorage, `/runs/:id` opened against the RECIPIENT's
  // workspace and silently showed them different data than the link meant.
  //
  // The signal stays the source of truth for FETCHING (scopedPathFor already
  // appends `?ws=`, getConnectionKey already includes it). The URL is a mirror
  // plus an INBOUND override, maintained by this one effect — threading the
  // param through every <A href>, navigate() and `_href` data string would be
  // invasive and would guarantee a missed link site.
  createEffect(() => {
    const list = getWorkspacesSignal()
    if (list().length === 0) return // nothing to validate against yet
    const params = new URLSearchParams(location.search)
    const fromUrl = params.get('ws') ?? ''
    const selected = workspaceSel()
    // What the data layer is ACTUALLY reading right now: an empty selection
    // means "let the server pick", and it picks most-recent.
    const effective = selected !== '' ? selected : (sortedWorkspaces(list())[0]?.id ?? '')

    if (fromUrl !== '') {
      // Equal to the effective scope ⇒ this is our own mirror bouncing back,
      // not an inbound override. Persisting it would silently pin the default
      // just because someone visited, turning "let the server pick" into a
      // choice the user never made.
      if (fromUrl === effective) return
      if (list().some((w) => w.id === fromUrl)) {
        setWorkspaceAndPersist(fromUrl) // a shared link wins over the local pref
      } else {
        // The link named a workspace this account cannot see. Falling back
        // silently would show data the link did not mean — the exact bug this
        // whole mechanism exists to prevent — so say so, and drop the param.
        // Unless WE deleted it a moment ago: the stale id is then our own, and
        // "ask whoever shared it for access" would be nonsense.
        if (!wasWorkspaceRemovedHere(fromUrl)) setDeniedWorkspace(fromUrl)
        params.delete('ws')
        const qs = params.toString()
        navigate(`${location.pathname}${qs === '' ? '' : `?${qs}`}`, { replace: true })
      }
      return
    }

    // No param but we do have a scope: mirror it back in, as a REPLACE so it
    // adds no history entry and Back still works. This is what covers every
    // internal link without any of them knowing about the workspace.
    if (effective === '') return
    params.set('ws', effective)
    navigate(`${location.pathname}?${params.toString()}`, { replace: true })
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
      <aside class="w-56 shrink-0 m-3 rounded-2xl border border-border/70 bg-surface/95 shadow-elevated flex flex-col sticky top-3 self-start h-[calc(100vh-1.5rem)] overflow-hidden">
        <div class="h-14 px-4 flex items-center gap-2.5 border-b border-border/70">
          <div class="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-accent-2 flex items-center justify-center text-bg font-bold text-[13px] shadow-glow">
            vx
          </div>
          <span class="font-mono text-sm text-fg-1 font-semibold tracking-tight">vx cloud</span>
        </div>
        <ContextPicker />
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
        <header class="h-14 px-5 border-b border-border/70 bg-bg/90 flex items-center gap-3 sticky top-0 z-10">
          <Breadcrumb pathname={location.pathname} />
          <div class="flex-1" />
          <LiveIndicator />
          <ServerBadge name={meta()?.name} />
          <NotificationBell />
          <AccountMenu />
        </header>

        <Show when={deniedWorkspace() !== ''}>
          <div class="px-5 py-2 border-b border-warn/30 bg-warn/10 flex items-center gap-2 text-[12px] text-fg-1">
            <span class="i-tabler-alert-triangle text-warn text-[14px] shrink-0" aria-hidden="true" />
            <span class="min-w-0 flex-1">
              That link points at a workspace this account can't see — showing{' '}
              <span class="font-mono">{currentWorkspaceName()}</span> instead. Ask whoever shared it
              for access to the right organization.
            </span>
            <button
              onClick={() => setDeniedWorkspace('')}
              class="text-fg-3 hover:text-fg text-[11px] shrink-0"
            >
              dismiss
            </button>
          </div>
        </Show>

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
 * The context this whole dashboard reads through, stacked at the top of the
 * sidebar: organization over workspace.
 *
 * EVERY analytics row on every page is `WHERE workspace_id = <the selection
 * below>`, so the workspace is not a preference — it is the scope of what you
 * are looking at, and it lives where the eye goes first. It used to be the
 * fourth of five identical chips in the top-right corner AND was hidden
 * outright on a 0/1-workspace org, so a reader had no way to tell which
 * workspace's data filled the page (and, with a second repo pushing, no hint
 * that another one existed).
 */
function ContextPicker() {
  return (
    <div class="px-2.5 py-2 border-b border-border/70 flex flex-col gap-1">
      <OrgRow />
      <WorkspaceRow />
    </div>
  )
}

/**
 * Org row, fed by GET /v1/admin/orgs. Selection persists via api.ts
 * (`vx-ui:org`) and rides every analytics read as `?org=` (the tenant clamp).
 * Also offers joining another org with an invite token.
 */
function OrgRow() {
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
          class="w-full flex items-center gap-2 px-2 py-1 rounded-md hover:bg-surface-hover/70 transition-colors text-left"
          title={`Organization: ${currentName()} — click to switch`}
        >
          <span class="i-tabler-building text-fg-3 text-[13px] shrink-0" aria-hidden="true" />
          <span class="min-w-0 flex-1 text-[11px] font-mono text-fg-2 truncate">
            {currentName()}
          </span>
          <span class="i-tabler-selector text-fg-3 text-[12px] shrink-0" aria-hidden="true" />
        </button>
        <Show when={open()}>
          <div class="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div class="absolute left-0 top-full mt-1 z-50 w-64 bg-surface border border-border-strong rounded-lg shadow-2xl overflow-hidden">
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

/** Two-letter initials from a display name (or email) for the avatar. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
}

/**
 * Account menu — the signed-in identity (avatar, name, email), links to
 * Settings and (when privileged) Admin, and sign-out.
 */
function AccountMenu() {
  const user = getCurrentUserSignal()
  const [open, setOpen] = createSignal(false)

  const canSeeAdmin = createMemo(() => {
    const u = user()
    if (u === null) return false
    return u.instanceAdmin || u.orgs.some((o) => o.role === 'admin' || o.role === 'owner')
  })
  const label = () => user()?.displayName ?? user()?.email ?? '—'

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
        class="flex items-center gap-1.5 pl-1 pr-1.5 py-1 rounded-full border border-border hover:border-border-strong hover:bg-surface-hover"
        title={`Account — ${label()}`}
      >
        <span class="w-6 h-6 rounded-full bg-gradient-to-br from-accent to-accent-2 text-bg font-semibold text-[10px] flex items-center justify-center shadow-glow">
          {initialsOf(label())}
        </span>
        <span class="i-tabler-chevron-down text-fg-3 text-[12px]" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div class="fixed inset-0 z-40" onClick={() => setOpen(false)} />
        <div class="absolute right-0 top-full mt-1.5 z-50 w-64 bg-surface border border-border-strong rounded-lg shadow-2xl overflow-hidden">
          <div class="px-3 py-3 border-b border-border flex items-center gap-2.5">
            <span class="w-9 h-9 rounded-full bg-gradient-to-br from-accent to-accent-2 text-bg font-semibold text-[13px] flex items-center justify-center shrink-0 shadow-glow">
              {initialsOf(label())}
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-[13px] text-fg-1 font-medium truncate">{label()}</span>
              <span class="block text-[11px] text-fg-3 truncate">{user()?.email}</span>
              <Show when={user()?.instanceAdmin}>
                <span class="inline-flex items-center gap-1 text-[10px] text-warn font-mono mt-0.5">
                  <span class="i-tabler-star-filled text-[10px]" aria-hidden="true" /> instance admin
                </span>
              </Show>
            </span>
          </div>
          <div class="py-1">
            <A
              href="/settings"
              onClick={() => setOpen(false)}
              class="w-full text-left flex items-center gap-2 px-3 py-2 text-[12px] text-fg-2 hover:bg-surface-hover hover:text-fg transition-colors no-underline"
            >
              <span class="i-tabler-settings text-[14px]" aria-hidden="true" />
              Settings
            </A>
            <Show when={canSeeAdmin()}>
              <A
                href="/admin"
                onClick={() => setOpen(false)}
                class="w-full text-left flex items-center gap-2 px-3 py-2 text-[12px] text-fg-2 hover:bg-surface-hover hover:text-fg transition-colors no-underline"
              >
                <span class="i-tabler-shield-lock text-[14px]" aria-hidden="true" />
                Admin
              </A>
            </Show>
          </div>
          <button
            onClick={() => void logout()}
            class="w-full text-left flex items-center gap-2 px-3 py-2 border-t border-border text-[12px] text-danger hover:bg-danger/10 transition-colors"
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
 * Notification bell — the workspace's recent broken builds (`/v1/notifications`,
 * visibility-aware 30s poll). The unread badge counts failures newer than the
 * last-seen watermark; opening the panel marks everything seen (the newest
 * failure's timestamp becomes the watermark, so future breaks still notify).
 */
/** True when a notification's failing projects intersect the dev's pins. */
function isMine(n: NotificationItem): boolean {
  const pins = pinnedProjects()
  return pins.length > 0 && (n.failingProjects ?? []).some((p) => pins.includes(p))
}

function NotificationBell() {
  const tick = useVisibilityRefresh(30_000)
  const [open, setOpen] = createSignal(false)
  const [items] = createResource(
    () => `${getConnectionKey()}|${tick()}`,
    async () => {
      try {
        return await fetchNotifications(20)
      } catch {
        return [] as NotificationItem[]
      }
    },
  )
  // Pinned-projects lens: runs that broke MY projects float to the top (the
  // feed stays newest-first within each half; a star marks the mine rows).
  const ordered = createMemo(() => {
    const list = items() ?? []
    return [...list.filter(isMine), ...list.filter((n) => !isMine(n))]
  })
  // A signal bumped when we mark-seen so the unread memo recomputes without a refetch.
  const [seenBump, setSeenBump] = createSignal(0)
  const unread = createMemo(() => {
    void seenBump()
    const since = getNotificationsSeenAt()
    return (items() ?? []).filter((n) => n.startedAt > since).length
  })

  function toggle() {
    const next = !open()
    setOpen(next)
    if (next) {
      // Mark seen at the newest failure's time (or now) so the badge clears.
      const list = items() ?? []
      const newest = list.length > 0 ? Math.max(...list.map((n) => n.startedAt)) : Date.now()
      markNotificationsSeen(Math.max(newest, getNotificationsSeenAt()))
      setSeenBump((n) => n + 1)
    }
  }

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
        onClick={toggle}
        class="relative flex items-center justify-center w-8 h-8 rounded-lg border border-border hover:border-border-strong hover:bg-surface-hover text-fg-2 hover:text-fg"
        title="Notifications"
        aria-label={`Notifications${unread() > 0 ? ` (${unread()} unread)` : ''}`}
      >
        <span class="i-tabler-bell text-base" aria-hidden="true" />
        <Show when={unread() > 0}>
          <span class="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-danger text-[9px] font-bold text-white flex items-center justify-center leading-none tabular-nums">
            {unread() > 9 ? '9+' : unread()}
          </span>
        </Show>
      </button>
      <Show when={open()}>
        <div class="fixed inset-0 z-40" onClick={() => setOpen(false)} />
        <div class="absolute right-0 top-full mt-1.5 z-50 w-80 bg-surface border border-border-strong rounded-lg shadow-2xl overflow-hidden">
          <div class="px-3 py-2 border-b border-border flex items-center gap-2">
            <span class="i-tabler-bell text-[13px] text-fg-3" aria-hidden="true" />
            <span class="text-[11px] uppercase tracking-wider text-fg-3 font-semibold">Notifications</span>
            <span class="flex-1" />
            <A href="/insights" onClick={() => setOpen(false)} class="text-[10px] text-accent hover:underline no-underline">
              Insights →
            </A>
          </div>
          <div class="max-h-96 overflow-y-auto">
            <Show
              when={(items() ?? []).length > 0}
              fallback={
                <div class="px-4 py-8 text-center text-[12px] text-fg-3">
                  <span class="i-tabler-circle-check text-success text-xl block mx-auto mb-1.5" aria-hidden="true" />
                  No recent failures — all green.
                </div>
              }
            >
              <For each={ordered()}>
                {(n) => (
                  <A
                    href={`/runs/${encodeURIComponent(n.runId)}`}
                    onClick={() => setOpen(false)}
                    class="flex items-start gap-2.5 px-3 py-2.5 border-b border-border/60 last:border-b-0 hover:bg-surface-hover transition-colors no-underline"
                  >
                    <span class="i-tabler-alert-triangle text-danger text-[15px] mt-0.5 shrink-0" aria-hidden="true" />
                    <span class="min-w-0 flex-1">
                      <span class="block text-[12px] text-fg-1">
                        <span class="font-semibold text-danger">{n.failedCount}</span> of {n.taskCount} task{n.taskCount === 1 ? '' : 's'} failed
                        <Show when={isMine(n)}>
                          <span class="i-tabler-star-filled text-warn text-[10px] ml-1.5 align-[-1px]" title="involves a pinned project" aria-label="involves a pinned project" />
                        </Show>
                      </span>
                      <span class="block text-[10px] text-fg-3 font-mono truncate mt-0.5">
                        {n.branch ?? '—'}
                        <Show when={n.commitSha}> · {n.commitSha!.slice(0, 8)}</Show>
                        {' · '}
                        {formatRelativeTime(n.startedAt)}
                      </span>
                    </span>
                    <span class="i-tabler-chevron-right text-fg-3 text-[13px] mt-0.5 shrink-0" aria-hidden="true" />
                  </A>
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

/**
 * Workspace row — the scope every page reads through. Fed by /v1/workspaces
 * (org-scoped); selection persists via api.ts (`vx-ui:workspace`) and rides
 * every /v1 analytics read as `?ws=`.
 *
 * ALWAYS rendered, including the 0- and 1-workspace cases. Hiding it on a
 * small org (what this used to do) left the reader with no way to tell which
 * workspace filled the page, and made a second repo's arrival invisible; an
 * org with none silently clamps to the nil workspace server-side, so every
 * page renders empty and only this row can say why.
 */
function WorkspaceRow() {
  const list = getWorkspacesSignal()
  const selected = getWorkspaceSignal()
  const navigate = useNavigate()
  const location = useLocation()
  const [open, setOpen] = createSignal(false)

  const sorted = createMemo(() => sortedWorkspaces(list()))
  // Empty selection means "let the server pick", and it picks most-recent —
  // so mirror that here rather than showing a blank while reading real data.
  const currentId = () => {
    const sel = selected()
    if (sel !== '') return sel
    return sorted()[0]?.id ?? ''
  }
  const current = () => list().find((w) => w.id === currentId())
  const empty = () => list().length === 0

  onMount(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  function pick(id: string) {
    setWorkspaceAndPersist(id)
    // Mirror the choice into the URL immediately so the address bar is
    // shareable the moment it is switched, not one navigation later.
    const params = new URLSearchParams(location.search)
    params.set('ws', id)
    navigate(`${location.pathname}?${params.toString()}`, { replace: true })
    setOpen(false)
  }

  // Workspaces are provisioned by CI pushes, so a long-lived tab's list goes
  // stale silently. Opening the switcher IS the intent to know what exists.
  function toggle() {
    const next = !open()
    if (next) refreshWorkspaces(true)
    setOpen(next)
  }

  return (
    <div class="relative">
      <button
        onClick={toggle}
        class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-hover/70 transition-colors text-left"
        title={
          empty()
            ? 'No workspace yet — one is created on the first CI push'
            : `Workspace: ${current()?.name ?? currentId()} — every page reads this scope. Click to switch.`
        }
      >
        <span class="i-tabler-folders text-accent text-[15px] shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1">
          <span
            class={`block text-[12px] font-mono font-medium truncate ${empty() ? 'text-fg-3 italic' : 'text-fg-1'}`}
          >
            {empty() ? 'No workspace yet' : (current()?.name ?? currentId())}
          </span>
          <Show when={list().length > 1}>
            <span class="block text-[10px] text-fg-3">{list().length} workspaces</span>
          </Show>
        </span>
        <span class="i-tabler-selector text-fg-3 text-[12px] shrink-0" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div class="fixed inset-0 z-40" onClick={() => setOpen(false)} />
        <div class="absolute left-0 top-full mt-1 z-50 w-72 bg-surface border border-border-strong rounded-lg shadow-2xl overflow-hidden">
          <div class="px-3 py-1.5 border-b border-border text-[10px] uppercase tracking-wider text-fg-3 font-semibold">
            Workspaces
          </div>
          <Show
            when={!empty()}
            fallback={
              <div class="px-3 py-3 text-[11px] text-fg-3 leading-relaxed">
                This organization has no workspace yet. One is provisioned
                automatically on the first CI push, or an admin can create one
                under Admin → Workspaces.
              </div>
            }
          >
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
          </Show>
        </div>
      </Show>
    </div>
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
