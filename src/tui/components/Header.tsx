// Top-of-screen status strip. Rendered as a single padded line so the
// painter has nothing stale to leave behind on shrink (multi-element
// rows ghost characters in OpenTUI's incremental painter).

import type React from 'react'
import type { State } from '../state/store.js'
import { selectParallelPct } from '../state/selectors.js'

interface Props {
  state: State
  version: string
  width: number
}

function statusBuckets(state: State): {
  waiting: number
  running: number
  done: number
  failed: number
} {
  let waiting = 0
  let running = 0
  let done = 0
  let failed = 0
  for (const row of state.tasks.values()) {
    if (row.status === 'waiting') waiting++
    else if (row.status === 'running') running++
    else if (row.status === 'failed') failed++
    else done++
  }
  return { waiting, running, done, failed }
}

export function Header({ state, version, width }: Props): React.ReactNode {
  const counts = statusBuckets(state)
  const pct = selectParallelPct(state)
  const projects = new Set<string>()
  const tasks = new Set<string>()
  for (const row of state.tasks.values()) {
    projects.add(row.projectName)
    tasks.add(row.taskName)
  }
  const idStr = state.runId.slice(-8) || '…'
  const left = `vx ${version}`
  const runChip = `run ${idStr}`
  const scopeChip =
    tasks.size === 0 ? 'loading…' : `tasks ${[...tasks].sort().join(',')}  pkgs ${projects.size}`
  const counter = `✓${counts.done}  ▶${counts.running}  ⏳${counts.waiting}${counts.failed > 0 ? `  ✗${counts.failed}` : ''}`
  const parallel = `parallel ${pct}%`
  const remote = state.remoteCacheEnabled
    ? `remote ↑${state.remote.puts} ↓${state.remote.gets}`
    : 'local cache only'
  const raw = ` ${left}  ${runChip}  ${scopeChip}  ${counter}  ${parallel}  ${remote}`
  const line = raw.length > width ? raw.slice(0, width) : raw.padEnd(width, ' ')
  return (
    <box width={width} backgroundColor="#1f2937">
      <text content={line} fg="#d1d5db" />
    </box>
  )
}
