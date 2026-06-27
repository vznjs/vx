import { render } from 'solid-js/web'
import { HashRouter, Route } from '@solidjs/router'
import 'virtual:uno.css'
import { Shell } from './components/Shell.tsx'
import { jsonPage } from './jr/page.tsx'
import { OVERVIEW } from './pages/overview.ts'
import { PROJECTS } from './pages/projects.ts'
import { PROJECT_DETAIL } from './pages/projectDetail.ts'
import { TASKS } from './pages/tasks.ts'
import { TASK_DETAIL } from './pages/taskDetail.ts'
import { CACHE } from './pages/cache.ts'
import { BOTTLENECKS } from './pages/bottlenecks.ts'
import { TRENDS } from './pages/trends.ts'
import { RUN_DETAIL } from './pages/runDetail.ts'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

render(
  () => (
    <HashRouter root={Shell}>
      <Route path="/" component={jsonPage(OVERVIEW)} />
      <Route path="/projects" component={jsonPage(PROJECTS)} />
      <Route path="/projects/:name" component={jsonPage(PROJECT_DETAIL)} />
      <Route path="/tasks" component={jsonPage(TASKS)} />
      <Route path="/tasks/:id" component={jsonPage(TASK_DETAIL)} />
      <Route path="/bottlenecks" component={jsonPage(BOTTLENECKS)} />
      <Route path="/trends" component={jsonPage(TRENDS)} />
      <Route path="/cache" component={jsonPage(CACHE)} />
      <Route path="/runs/:id" component={jsonPage(RUN_DETAIL)} />
    </HashRouter>
  ),
  root,
)
