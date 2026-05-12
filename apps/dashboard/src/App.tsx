import type { Component, JSX } from 'solid-js'
import { HashRouter, Route, A, useLocation, type RouteSectionProps } from '@solidjs/router'
import { Overview } from './pages/Overview.tsx'
import { Runs } from './pages/Runs.tsx'
import { RunDetail } from './pages/RunDetail.tsx'
import { Tasks } from './pages/Tasks.tsx'
import { Cache } from './pages/Cache.tsx'

const NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/overview', label: 'Overview' },
  { href: '/runs', label: 'Runs' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/cache', label: 'Cache' },
]

const Shell: Component<RouteSectionProps> = (props) => {
  const loc = useLocation()
  const isActive = (href: string) =>
    loc.pathname === href || (href === '/runs' && loc.pathname.startsWith('/runs/'))

  return (
    <div class="min-h-screen flex flex-col">
      <header class="border-b border-border bg-bg-elevated px-6 h-14 flex items-center gap-8">
        <A href="/overview" class="flex items-baseline gap-2 hover:no-underline">
          <span class="text-fg font-semibold text-lg tracking-tight">vzn</span>
          <span class="text-fg-subtle text-sm font-mono">dashboard</span>
        </A>
        <nav class="flex items-center gap-1 text-sm">
          {NAV.map((n) => (
            <NavLink href={n.href} active={isActive(n.href)}>
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main class="flex-1 px-6 py-8 max-w-7xl w-full">{props.children}</main>
      <footer class="border-t border-border-muted px-6 py-3 text-fg-subtle text-xs">
        <code class="font-mono">vzn dashboard</code> — read-only window onto{' '}
        <code class="font-mono">.vzn/cache/cache.db</code>
      </footer>
    </div>
  )
}

const NavLink: Component<{ href: string; active: boolean; children: JSX.Element }> = (props) => (
  <A
    href={props.href}
    class="px-3 py-1.5 rounded-md transition-colors"
    classList={{
      'text-fg bg-bg-muted': props.active,
      'text-fg-muted hover:text-fg hover:bg-bg-muted': !props.active,
    }}
  >
    {props.children}
  </A>
)

export const App: Component = () => (
  <HashRouter root={Shell}>
    <Route path="/" component={Overview} />
    <Route path="/overview" component={Overview} />
    <Route path="/runs" component={Runs} />
    <Route path="/runs/:id" component={RunDetail} />
    <Route path="/tasks" component={Tasks} />
    <Route path="/cache" component={Cache} />
    <Route path="*" component={NotFound} />
  </HashRouter>
)

const NotFound: Component = () => (
  <section>
    <h1 class="text-fg text-2xl font-semibold tracking-tight mb-2">Not found</h1>
    <p class="text-fg-muted">
      That page doesn't exist (yet). Try{' '}
      <A href="/overview" class="text-accent">
        Overview
      </A>
      .
    </p>
  </section>
)
