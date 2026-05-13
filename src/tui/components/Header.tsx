// Top-of-screen status strip. Renders the run identity (version,
// run id, packages, tasks), live counts of pending / running /
// finished, parallel-% gauge, and remote-cache status. See
// docs/design/tui-design.md §11.10 for the gauge thresholds.

import type React from 'react'
import type { State } from '../state/store.js'
import { selectParallelPct } from '../state/selectors.js'

interface Props {
  state: State
  version: string
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

function parallelColor(pct: number, done: boolean): string {
  if (done) return '#808080'
  if (pct >= 80) return '#22c55e'
  if (pct >= 50) return '#eab308'
  return '#ef4444'
}

export function Header({ state, version }: Props): React.ReactNode {
  const counts = statusBuckets(state)
  const pct = selectParallelPct(state)
  const projects = new Set<string>()
  const tasks = new Set<string>()
  for (const row of state.tasks.values()) {
    projects.add(row.projectName)
    tasks.add(row.taskName)
  }
  const gaugeColor = parallelColor(pct, state.done)

  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor="#1f2937">
      <text content={`vx ${version}`} fg="#a78bfa" attributes={1} />
      <text content="  " />
      <text content={`run ${state.runId.slice(-8) || '--------'}`} fg="#9ca3af" />
      <text content="  " />
      <text content={`tasks ${[...tasks].sort().join(',')}  pkgs ${projects.size}`} fg="#d1d5db" />
      <text content="  " />
      <text content={`✓${counts.done}`} fg="#22c55e" />
      <text content="  " />
      <text content={`▶${counts.running}`} fg="#eab308" />
      <text content="  " />
      <text content={`⏳${counts.waiting}`} fg="#9ca3af" />
      {counts.failed > 0 ? (
        <>
          <text content="  " />
          <text content={`✗${counts.failed}`} fg="#ef4444" />
        </>
      ) : null}
      <text content="  " />
      <text content={`parallel ${pct}%`} fg={gaugeColor} attributes={1} />
      <text content="  " />
      <text
        content={
          state.remoteCacheEnabled
            ? `remote ↑${state.remote.puts} ↓${state.remote.gets}`
            : 'local cache only'
        }
        fg="#9ca3af"
      />
    </box>
  )
}
