import { render } from 'solid-js/web'
import { HashRouter, Route } from '@solidjs/router'
import 'virtual:uno.css'
import { Shell } from './components/Shell.tsx'
import { Overview } from './pages/Overview.tsx'
import { Tasks } from './pages/Tasks.tsx'
import { TaskDetail } from './pages/TaskDetail.tsx'
import { CachePage } from './pages/CachePage.tsx'
import { RunDetail } from './pages/RunDetail.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

render(
  () => (
    <HashRouter root={Shell}>
      <Route path="/" component={Overview} />
      <Route path="/tasks" component={Tasks} />
      <Route path="/tasks/:id" component={TaskDetail} />
      <Route path="/cache" component={CachePage} />
      <Route path="/runs/:id" component={RunDetail} />
    </HashRouter>
  ),
  root,
)
