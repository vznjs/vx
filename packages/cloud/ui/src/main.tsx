import { HashRouter, Navigate, Route } from '@solidjs/router'
import { Show, onMount } from 'solid-js'
import { render } from 'solid-js/web'
import 'virtual:uno.css'
import { Shell } from './components/Shell.tsx'
import { RunsView } from './components/RunsView.tsx'
import { AdminView } from './components/AdminView.tsx'
import { LoginGate } from './components/LoginGate.tsx'
import { bootstrapAuth, getAuthStateSignal } from './api.ts'
import { jsonPage } from './jr/page.tsx'
// Every page/view is a pure JSON file in `views/`, rendered through the catalog.
import OVERVIEW from './views/overview.json'
import PROJECTS from './views/projects.json'
import PROJECT_DETAIL from './views/projectDetail.json'
import TASKS from './views/tasks.json'
import TASK_DETAIL from './views/taskDetail.json'
import CACHE from './views/cache.json'
import CACHE_ENTRY from './views/cacheEntry.json'
import ARTIFACTS from './views/artifacts.json'
import INSIGHTS from './views/insights.json'
import RUN_DETAIL from './views/runDetail.json'
import COMPARE from './views/compare.json'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

function AppRoutes() {
  return (
    <HashRouter root={Shell}>
      {/* The unified Runs view is home (cloud-data-model-2026-07 §7.4); the
          old /run cockpit route redirects — its machinery lives on as the
          RunSession embedded in /runs. */}
      <Route path="/" component={() => <Navigate href="/runs" />} />
      <Route path="/run" component={() => <Navigate href="/runs" />} />
      {/* Trends + Bottlenecks merged into Insights (§4.2); old routes redirect. */}
      <Route path="/trends" component={() => <Navigate href="/insights" />} />
      <Route path="/bottlenecks" component={() => <Navigate href="/insights" />} />
      <Route path="/runs" component={RunsView} />
      <Route path="/overview" component={jsonPage(OVERVIEW)} />
      <Route path="/projects" component={jsonPage(PROJECTS)} />
      <Route path="/projects/:name" component={jsonPage(PROJECT_DETAIL)} />
      <Route path="/tasks" component={jsonPage(TASKS)} />
      <Route path="/tasks/:id" component={jsonPage(TASK_DETAIL)} />
      <Route path="/insights" component={jsonPage(INSIGHTS)} />
      <Route path="/cache" component={jsonPage(CACHE)} />
      <Route path="/cache/:hash" component={jsonPage(CACHE_ENTRY)} />
      <Route path="/artifacts" component={jsonPage(ARTIFACTS)} />
      <Route path="/runs/:id" component={jsonPage(RUN_DETAIL)} />
      <Route path="/compare/:id" component={jsonPage(COMPARE)} />
      <Route path="/admin" component={AdminView} />
    </HashRouter>
  )
}

/** Boot: resolve the session principal, then render the login gate or the app. */
function App() {
  const authState = getAuthStateSignal()
  onMount(() => {
    void bootstrapAuth()
  })
  return (
    <Show when={authState() !== 'loading'} fallback={<BootScreen />}>
      <Show when={authState() === 'authed'} fallback={<LoginGate />}>
        <AppRoutes />
      </Show>
    </Show>
  )
}

function BootScreen() {
  return (
    <div class="min-h-screen flex items-center justify-center bg-bg">
      <span class="i-tabler-loader-2 animate-spin text-2xl text-fg-3" aria-hidden="true" />
    </div>
  )
}

render(() => <App />, root)
