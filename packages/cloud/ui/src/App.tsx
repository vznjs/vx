// The application frame: AppShell + SideNav (console/observability archetype),
// TopNav carrying the page context + connection controls, and the route table.
// Every page renders inside the shell's content region.

import { useEffect, useMemo, useState, type JSX } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AppShell } from '@astryxdesign/core/AppShell'
import { SideNav, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { Badge } from '@astryxdesign/core/Badge'
import { TopNav } from '@astryxdesign/core/TopNav'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { FormLayout } from '@astryxdesign/core/FormLayout'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Selector } from '@astryxdesign/core/Selector'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Text } from '@astryxdesign/core/Text'
import { HStack } from '@astryxdesign/core/Layout'
import { CommandPalette } from '@astryxdesign/core/CommandPalette'
import { createStaticSource } from '@astryxdesign/core/Typeahead'
import {
  BellAlertIcon,
  BoltIcon,
  CircleStackIcon,
  ClockIcon,
  FireIcon,
  ListBulletIcon,
  MoonIcon,
  PlayIcon,
  RectangleGroupIcon,
  RocketLaunchIcon,
  SunIcon,
} from '@heroicons/react/24/outline'
import {
  getMeta,
  getVersion,
  refreshCapabilities,
  refreshWorkspaces,
  setOriginAndPersist,
  setTokenAndPersist,
  setWorkspaceAndPersist,
  useCapabilities,
  useConnectionKey,
  useOrigin,
  useToken,
  useUnauthorized,
  useWorkspace,
  useWorkspaces,
  type ServerMeta,
  type ServerVersion,
} from './api.ts'
import { useQuery } from './hooks.ts'
import { useThemeMode } from './theme-mode.ts'
import { Activity } from './pages/Activity.tsx'
import { Attention, useAttentionCount } from './pages/Attention.tsx'
import { RunDetail } from './pages/RunDetail.tsx'
import { Compare } from './pages/Compare.tsx'
import { Projects } from './pages/Projects.tsx'
import { ProjectDetail } from './pages/ProjectDetail.tsx'
import { Tasks } from './pages/Tasks.tsx'
import { TaskDetail } from './pages/TaskDetail.tsx'
import { InsightsSpeed } from './pages/InsightsSpeed.tsx'
import { InsightsCache } from './pages/InsightsCache.tsx'
import { InsightsFlaky } from './pages/InsightsFlaky.tsx'
import { RunConsole } from './pages/RunConsole.tsx'

/** Brand wordmark: Space Grotesk + the violet→pink gradient, linking home. */
function Wordmark(): JSX.Element {
  return (
    <a href="#/" style={{ textDecoration: 'none', display: 'flex', alignItems: 'baseline' }}>
      <span
        style={{
          fontFamily: "'Space Grotesk', var(--font-family-body)",
          fontWeight: 700,
          fontSize: '20px',
          letterSpacing: '-0.02em',
          background: 'linear-gradient(120deg, var(--vx-brand-from), var(--vx-brand-to))',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
        }}
      >
        VX
      </span>
      <span
        style={{
          marginInlineStart: 'var(--spacing-2)',
          fontFamily: "'Space Grotesk', var(--font-family-body)",
          fontWeight: 500,
          fontSize: '14px',
          letterSpacing: '0.01em',
          color: 'var(--color-text-secondary)',
        }}
      >
        Cloud
      </span>
    </a>
  )
}

interface NavEntry {
  href: string
  label: string
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
}

/** Journey-first top entries (Linear pattern), then labeled entity sections. */
const NAV_TOP: NavEntry[] = [
  { href: '/', label: 'Activity', icon: ClockIcon },
  { href: '/attention', label: 'Needs attention', icon: BellAlertIcon },
  { href: '/run', label: 'Cockpit', icon: PlayIcon },
]
const NAV_INSIGHTS: NavEntry[] = [
  { href: '/insights/speed', label: 'Speed', icon: RocketLaunchIcon },
  { href: '/insights/cache', label: 'Cache', icon: CircleStackIcon },
  { href: '/insights/flaky', label: 'Flaky tasks', icon: FireIcon },
]
const NAV_WORKSPACE: NavEntry[] = [
  { href: '/projects', label: 'Projects', icon: RectangleGroupIcon },
  { href: '/tasks', label: 'Tasks', icon: ListBulletIcon },
]


/** Origin + token editor. Commits via api.ts persistence, which re-keys every query. */
function ConnectionDialog(props: { isOpen: boolean; onOpenChange: (open: boolean) => void }): JSX.Element {
  const origin = useOrigin()
  const token = useToken()
  const [draft, setDraft] = useState(origin)
  const [draftToken, setDraftToken] = useState(token)
  useEffect(() => {
    if (props.isOpen) {
      setDraft(origin)
      setDraftToken(token)
    }
  }, [props.isOpen, origin, token])
  return (
    <Dialog isOpen={props.isOpen} onOpenChange={props.onOpenChange} width={460} purpose="form">
      <DialogHeader title="Connection" subtitle="Point the dashboard at any vx serve." />
      <FormLayout>
        <TextInput
          label="Server origin"
          value={draft}
          onChange={setDraft}
          placeholder="http://localhost:4321"
        />
        <TextInput
          label="Token"
          value={draftToken}
          onChange={setDraftToken}
          placeholder="optional — required by token-gated serves"
          type="password"
        />
        <HStack gap={2}>
          <Button
            label="Connect"
            variant="primary"
            onClick={() => {
              setOriginAndPersist(draft)
              setTokenAndPersist(draftToken)
              props.onOpenChange(false)
            }}
          />
          <Button label="Cancel" onClick={() => props.onOpenChange(false)} />
        </HStack>
      </FormLayout>
    </Dialog>
  )
}

/**
 * Docker-context-style workspace switcher. Fed by /v1/workspaces; selection
 * persists and rides every /v1 read as `?ws=`. Hidden on a 0/1-workspace
 * serve so the solo-dev shell stays minimal.
 */
function WorkspaceSwitcher(): JSX.Element | null {
  const list = useWorkspaces()
  const selected = useWorkspace()
  if (list.length <= 1) return null
  const sorted = [...list].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  const current = selected !== '' && list.some((w) => w.id === selected) ? selected : (sorted[0]?.id ?? '')
  return (
    <Selector
      label="Workspace"
      isLabelHidden
      size="sm"
      value={current}
      options={sorted.map((w) => ({ value: w.id, label: w.name }))}
      onChange={(id) => setWorkspaceAndPersist(id)}
    />
  )
}

function ConnectionStatus(props: { onEdit: () => void }): JSX.Element {
  const origin = useOrigin()
  const connection = useConnectionKey()
  const version = useQuery<ServerVersion | null>(() => getVersion().catch(() => null), [connection])
  const meta = useQuery<ServerMeta | null>(() => getMeta().catch(() => null), [connection])
  const ok = version.data !== null && version.data !== undefined
  const name = meta.data?.name
  return (
    <Button
      size="sm"
      onClick={props.onEdit}
      label={`${name !== undefined && name !== '' ? `${name} · ` : ''}${origin.replace(/^https?:\/\//, '')}`}
      icon={<StatusDot variant={ok ? 'success' : 'error'} label={ok ? 'connected' : 'unreachable'} />}
    />
  )
}

function ModeToggle(): JSX.Element {
  const [mode, setMode] = useThemeMode()
  const dark = mode !== 'light'
  return (
    <IconButton
      label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      icon={dark ? <SunIcon /> : <MoonIcon />}
      size="sm"
      variant="secondary"
      onClick={() => setMode(dark ? 'light' : 'dark')}
    />
  )
}

export function App(): JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const connection = useConnectionKey()
  const unauthorized = useUnauthorized()
  const caps = useCapabilities()
  const attentionCount = useAttentionCount()
  const [editing, setEditing] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  /** Selected iff exact match or a sub-path; '/' only when exactly home. */
  const selected = (href: string): boolean =>
    href === '/'
      ? location.pathname === '/'
      : location.pathname === href || location.pathname.startsWith(`${href}/`)

  // Re-probe serve-level context whenever the connection changes.
  useEffect(() => {
    refreshWorkspaces()
    refreshCapabilities()
  }, [connection])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const paletteSource = useMemo(
    () =>
      createStaticSource(
        [...NAV_TOP, ...NAV_INSIGHTS, ...NAV_WORKSPACE].map((item) => ({
          id: item.href,
          label: item.label,
        })),
      ),
    [],
  )

  return (
    <AppShell
      height="fill"
      // wash, not the default elevated: elevated mounts its own opaque
      // "surface" backdrop behind the content region, and the 12px gaps
      // around our floating pane exposed it as a lighter band on the aurora.
      // The pane (brand.css #astryx-app-shell-main) IS our elevated surface.
      variant="wash"
      contentPadding={0}
      banner={
        unauthorized ? (
          <Banner
            status="error"
            title="401 — this server requires a token"
            endContent={<Button size="sm" label="Set token" onClick={() => setEditing(true)} />}
          />
        ) : undefined
      }
      topNav={
        <TopNav
          heading={<Wordmark />}
          endContent={
            <HStack gap={2} vAlign="center">
              <WorkspaceSwitcher />
              <ConnectionStatus onEdit={() => setEditing(true)} />
              <ModeToggle />
            </HStack>
          }
        />
      }
      sideNav={
        <SideNav collapsible>
          {NAV_TOP.filter((item) => item.href !== '/run' || caps.hasWorkspace || !caps.known).map(
            (item) => (
              <SideNavItem
                key={item.href}
                label={item.label}
                icon={item.icon}
                isSelected={selected(item.href)}
                onClick={() => navigate(item.href)}
                endContent={
                  item.href === '/attention' && attentionCount > 0 ? (
                    <Badge label={String(attentionCount)} variant="error" />
                  ) : undefined
                }
              />
            ),
          )}
          <SideNavSection title="Insights">
            {NAV_INSIGHTS.map((item) => (
              <SideNavItem
                key={item.href}
                label={item.label}
                icon={item.icon}
                isSelected={selected(item.href)}
                onClick={() => navigate(item.href)}
              />
            ))}
          </SideNavSection>
          <SideNavSection title="Workspace">
            {NAV_WORKSPACE.map((item) => (
              <SideNavItem
                key={item.href}
                label={item.label}
                icon={item.icon}
                isSelected={selected(item.href)}
                onClick={() => navigate(item.href)}
              />
            ))}
          </SideNavSection>
        </SideNav>
      }
    >
      <Routes>
        <Route path="/" element={<Activity />} />
        <Route path="/attention" element={<Attention />} />
        <Route path="/run" element={<RunConsole />} />
        <Route path="/runs/:id" element={<RunDetail />} />
        <Route path="/compare/:id" element={<Compare />} />
        <Route path="/insights/speed" element={<InsightsSpeed />} />
        <Route path="/insights/cache" element={<InsightsCache />} />
        <Route path="/insights/flaky" element={<InsightsFlaky />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:name" element={<ProjectDetail />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        {/* Legacy routes from the pre-v3 IA. */}
        <Route path="/runs" element={<Navigate to="/" replace />} />
        <Route path="/overview" element={<Navigate to="/" replace />} />
        <Route path="/bottlenecks" element={<Navigate to="/insights/speed" replace />} />
        <Route path="/trends" element={<Navigate to="/insights/speed" replace />} />
        <Route path="/cache" element={<Navigate to="/insights/cache" replace />} />
      </Routes>
      <ConnectionDialog isOpen={editing} onOpenChange={setEditing} />
      <CommandPalette
        isOpen={paletteOpen}
        onOpenChange={setPaletteOpen}
        searchSource={paletteSource}
        label="Go to page"
        onValueChange={(href) => {
          setPaletteOpen(false)
          navigate(href)
        }}
      />
    </AppShell>
  )
}
