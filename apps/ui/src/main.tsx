import { render } from 'solid-js/web'
import { HashRouter, Route } from '@solidjs/router'
import 'virtual:uno.css'
import { Shell } from './components/Shell.tsx'
import { RunConsole } from './components/RunConsole.tsx'
import { jsonPage } from './jr/page.tsx'
// Every page/view is a pure JSON file in `views/`, rendered through the catalog.
import OVERVIEW from './views/overview.json'
import PROJECTS from './views/projects.json'
import PROJECT_DETAIL from './views/projectDetail.json'
import TASKS from './views/tasks.json'
import TASK_DETAIL from './views/taskDetail.json'
import CACHE from './views/cache.json'
import BOTTLENECKS from './views/bottlenecks.json'
import TRENDS from './views/trends.json'
import RUNS from './views/runs.json'
import RUN_DETAIL from './views/runDetail.json'
import COMPARE from './views/compare.json'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

render(
  () => (
    <HashRouter root={Shell}>
      <Route path="/run" component={RunConsole} />
      <Route path="/" component={jsonPage(OVERVIEW)} />
      <Route path="/projects" component={jsonPage(PROJECTS)} />
      <Route path="/projects/:name" component={jsonPage(PROJECT_DETAIL)} />
      <Route path="/tasks" component={jsonPage(TASKS)} />
      <Route path="/tasks/:id" component={jsonPage(TASK_DETAIL)} />
      <Route path="/runs" component={jsonPage(RUNS)} />
      <Route path="/bottlenecks" component={jsonPage(BOTTLENECKS)} />
      <Route path="/trends" component={jsonPage(TRENDS)} />
      <Route path="/cache" component={jsonPage(CACHE)} />
      <Route path="/runs/:id" component={jsonPage(RUN_DETAIL)} />
      <Route path="/compare/:id" component={jsonPage(COMPARE)} />
    </HashRouter>
  ),
  root,
)
