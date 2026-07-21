// The application frame: AppShell + SideNav (console/observability archetype),
// TopNav carrying the page context + connection controls, and the route table.
// Every page renders inside the shell's content region.

import { useEffect, useMemo, useState, type JSX } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AppShell } from '@astryxdesign/core/AppShell'
import { SideNav, SideNavItem } from '@astryxdesign/core/SideNav'
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
import { Spinner } from '@astryxdesign/core/Spinner'
import { Center } from '@astryxdesign/core/Center'
import {
  BoltIcon,
  ChartBarIcon,
  CircleStackIcon,
  ClockIcon,
  FireIcon,
  ListBulletIcon,
  MoonIcon,
  PlayIcon,
  RectangleGroupIcon,
  Squares2X2Icon,
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
import { Overview } from './pages/Overview.tsx'
import { Runs } from './pages/Runs.tsx'
import { RunDetail } from './pages/RunDetail.tsx'
import { Compare } from './pages/Compare.tsx'
import { Projects } from './pages/Projects.tsx'
import { ProjectDetail } from './pages/ProjectDetail.tsx'
import { Tasks } from './pages/Tasks.tsx'
import { TaskDetail } from './pages/TaskDetail.tsx'
import { Cache } from './pages/Cache.tsx'
import { Bottlenecks } from './pages/Bottlenecks.tsx'
import { Trends } from './pages/Trends.tsx'
import { RunConsole } from './pages/RunConsole.tsx'

/** Brand wordmark: Space Grotesk + the violet→pink gradient, linking home. */
function Wordmark(): JSX.Element {
  return (
    <a href="#/" style={{ textDecoration: 'none', display: 'block', padding: 'var(--spacing-3) var(--spacing-4)' }}>
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
        vx
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
        insights
      </span>
    </a>
  )
}

interface NavEntry {
  href: string
  label: string
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
}

const NAV: NavEntry[] = [
  { href: '/run', label: 'Run', icon: PlayIcon },
  { href: '/runs', label: 'Runs', icon: ClockIcon },
  { href: '/overview', label: 'Overview', icon: Squares2X2Icon },
  { href: '/projects', label: 'Projects', icon: RectangleGroupIcon },
  { href: '/tasks', label: 'Tasks', icon: ListBulletIcon },
  { href: '/bottlenecks', label: 'Bottlenecks', icon: FireIcon },
  { href: '/trends', label: 'Trends', icon: ChartBarIcon },
  { href: '/cache', label: 'Cache', icon: CircleStackIcon },
]

/**
 * Capability-aware landing: a serve with a colocated workspace opens on the
 * Run cockpit (the daily-dev entry point); a hosted analytics-only serve
 * opens on Runs. Redirects once the capability probe resolves.
 */
function Home(): JSX.Element {
  const caps = useCapabilities()
  if (!caps.known) {
    return (
      <Center>
        <Spinner label="Probing server capabilities" />
      </Center>
    )
  }
  return <Navigate to={caps.hasWorkspace ? '/run' : '/runs'} replace />
}

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

const TITLES: ReadonlyArray<[RegExp, string]> = [
  [/^\/run$/, 'Run'],
  [/^\/runs\/.+/, 'Run detail'],
  [/^\/runs/, 'Runs'],
  [/^\/compare\/.+/, 'Compare'],
  [/^\/overview/, 'Overview'],
  [/^\/projects\/.+/, 'Project'],
  [/^\/projects/, 'Projects'],
  [/^\/tasks\/.+/, 'Task'],
  [/^\/tasks/, 'Tasks'],
  [/^\/bottlenecks/, 'Bottlenecks'],
  [/^\/trends/, 'Trends'],
  [/^\/cache/, 'Cache'],
]

export function App(): JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const connection = useConnectionKey()
  const unauthorized = useUnauthorized()
  const [editing, setEditing] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

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
        NAV.map((item) => ({ id: item.href, label: item.label })),
      ),
    [],
  )

  const title = TITLES.find(([re]) => re.test(location.pathname))?.[1] ?? 'vx'

  return (
    <AppShell
      height="fill"
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
          heading={<Text weight="semibold">{title}</Text>}
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
        <SideNav
          header={<Wordmark />}
          collapsible
        >
          {NAV.map((item) => (
            <SideNavItem
              key={item.href}
              label={item.label}
              icon={item.icon}
              isSelected={
                item.href === '/runs'
                  ? /^\/runs/.test(location.pathname) || /^\/compare/.test(location.pathname)
                  : location.pathname === item.href ||
                    location.pathname.startsWith(`${item.href}/`)
              }
              onClick={() => navigate(item.href)}
            />
          ))}
        </SideNav>
      }
    >
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/run" element={<RunConsole />} />
        <Route path="/overview" element={<Overview />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:name" element={<ProjectDetail />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        <Route path="/runs" element={<Runs />} />
        <Route path="/runs/:id" element={<RunDetail />} />
        <Route path="/compare/:id" element={<Compare />} />
        <Route path="/bottlenecks" element={<Bottlenecks />} />
        <Route path="/trends" element={<Trends />} />
        <Route path="/cache" element={<Cache />} />
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
