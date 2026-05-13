// Log pane — shows the selected (or pinned) task's buffered stdout +
// stderr. We render a fixed window of trailing lines and let the
// design's full scroll story arrive later. Empty state nudges the
// user to select a task.

import type React from 'react'
import type { State } from '../state/store.js'

interface Props {
  state: State
  width: number
  height: number
}

export function LogPane({ state, width, height }: Props): React.ReactNode {
  const targetId = state.pinnedTaskId ?? state.selectedTaskId
  const row = targetId ? state.tasks.get(targetId) : undefined
  const title = row ? `Log: ${row.id}` : 'Log'
  const bodyLines: string[] = []

  if (row) {
    const tail = row.logLines.slice(-Math.max(1, height - 3))
    bodyLines.push(...tail)
    if (row.pendingLine.length > 0) bodyLines.push(row.pendingLine)
    if (bodyLines.length === 0) bodyLines.push('(no output yet)')
  } else {
    bodyLines.push('(select a task to inspect — j/k or ↑/↓)')
  }

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      border
      borderColor="#374151"
      title={title}
    >
      {bodyLines.map((line, i) => (
        <text key={`${i}-${line}`} content={line.length === 0 ? ' ' : line} fg="#d1d5db" />
      ))}
    </box>
  )
}
