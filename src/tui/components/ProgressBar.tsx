// Bottom progress bar — single fixed-width line so OpenTUI's painter
// has nothing stale to leave behind (multi-element rows ghost text on
// shrink). Format: `<filled-bar>  <done>/<total>  <pct>% parallel`.

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
  const suffix = `  ${completed}/${total}  ${selectParallelPct(state)}% parallel`
  const barWidth = Math.max(1, width - suffix.length - 2)
  const filled = Math.floor((pct / 100) * barWidth)
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barWidth - filled))
  // Pad to full width to overwrite any prior content cells.
  const line = (' ' + bar + suffix).padEnd(width, ' ')
  return (
    <box flexDirection="row" width={width} backgroundColor="#0f172a">
      <text content={line} fg="#9ca3af" />
    </box>
  )
}
