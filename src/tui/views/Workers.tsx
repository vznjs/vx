// Workers view — one row per slot showing what's currently running
// on it, plus a recent-busy heatmap (Phase 3 keeps it simple: live
// utilization only; the per-slot sample history lands later).

import type React from 'react'
import type { State } from '../state/store.js'
import { selectParallelPct } from '../state/selectors.js'

interface Props {
  state: State
  width: number
  height: number
}

export function Workers({ state, width, height }: Props): React.ReactNode {
  const rows = state.workerSlots.map((slot, i) => {
    const id = slot.taskId
    const busy = id !== null
    const taskRow = id ? state.tasks.get(id) : undefined
    return (
      <box key={`slot-${i}`} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text content={`[${String(i + 1).padStart(2, '0')}]`} fg="#9ca3af" />
        <text content="  " />
        <text content={busy ? '▶ busy' : '· idle'} fg={busy ? '#22c55e' : '#6b7280'} />
        <text content="  " />
        {taskRow ? <text content={taskRow.id} fg="#d1d5db" /> : <text content="—" fg="#4b5563" />}
      </box>
    )
  })

  void height
  return (
    <box
      flexDirection="column"
      width={width}
      border
      borderColor="#374151"
      title={`Workers — ${selectParallelPct(state)}% busy`}
    >
      {rows}
    </box>
  )
}
