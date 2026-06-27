import { render } from 'solid-js/web'
import { HashRouter, Route } from '@solidjs/router'
import 'virtual:uno.css'
import { Shell } from './components/Shell.tsx'
import { Overview } from './pages/Overview.tsx'
import { Projects } from './pages/Projects.tsx'
import { ProjectDetail } from './pages/ProjectDetail.tsx'
import { Tasks } from './pages/Tasks.tsx'
import { TaskDetail } from './pages/TaskDetail.tsx'
import { CachePage } from './pages/CachePage.tsx'
import { Bottlenecks } from './pages/Bottlenecks.tsx'
import { Trends } from './pages/Trends.tsx'
import { RunDetail } from './pages/RunDetail.tsx'
import { SpecDemo } from './pages/SpecDemo.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

render(
  () => (
    <HashRouter root={Shell}>
      <Route path="/" component={Overview} />
      <Route path="/projects" component={Projects} />
      <Route path="/projects/:name" component={ProjectDetail} />
      <Route path="/tasks" component={Tasks} />
      <Route path="/tasks/:id" component={TaskDetail} />
      <Route path="/bottlenecks" component={Bottlenecks} />
      <Route path="/trends" component={Trends} />
      <Route path="/cache" component={CachePage} />
      <Route path="/runs/:id" component={RunDetail} />
      <Route path="/spec" component={SpecDemo} />
    </HashRouter>
  ),
  root,
)
