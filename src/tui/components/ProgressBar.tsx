// Bottom progress bar — "N/M tasks complete · X% parallel".

import type React from 'react'
import type { State } from '../state/store.js'
import { selectParallelPct } from '../state/selectors.js'

interface Props {
  state: State
  width: number
}

export function ProgressBar({ state, width }: Props): React.ReactNode {
  let done = 0
  let failed = 0
  for (const row of state.tasks.values()) {
    if (
      row.status === 'success' ||
      row.status === 'cache-hit' ||
      row.status === 'cache-hit-remote' ||
      row.status === 'skipped'
    ) {
      done++
    } else if (row.status === 'failed') {
      failed++
    }
  }
  const total = state.totalNodes
  const completed = done + failed
  const pct = total === 0 ? 0 : Math.floor((completed / total) * 100)
  const barWidth = Math.max(0, width - 24)
  const filled = Math.floor((pct / 100) * barWidth)
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barWidth - filled))

  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor="#0f172a">
      <text content={bar} fg="#22c55e" />
      <text content=" " />
      <text content={`${completed}/${total}`} fg="#d1d5db" />
      <text content="  " />
      <text content={`${selectParallelPct(state)}% parallel`} fg="#9ca3af" />
    </box>
  )
}
