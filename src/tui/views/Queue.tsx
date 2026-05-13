// Queue view — split panel: ready (waiting + deps OK; just lacking a
// slot) vs blocked (deps not finished). Plus a tiny throughput hint
// at the bottom.

import type React from 'react'
import type { State, TaskRow } from '../state/store.js'
import { selectReadyQueue, selectBlockedQueue } from '../state/selectors.js'

interface Props {
  state: State
  width: number
  height: number
}

function row(r: TaskRow): React.ReactNode {
  return (
    <text
      key={r.id}
      content={`  ${r.id}  (deps ${r.deps.length})`}
      fg={r.status === 'waiting' ? '#d1d5db' : '#6b7280'}
    />
  )
}

export function Queue({ state, width, height }: Props): React.ReactNode {
  void height
  const ready = selectReadyQueue(state)
  const blocked = selectBlockedQueue(state)
  const half = Math.floor((width - 1) / 2)
  return (
    <box flexDirection="row" width={width}>
      <box
        flexDirection="column"
        width={half}
        border
        borderColor="#374151"
        title={`Ready (${ready.length})`}
      >
        {ready.length === 0 ? <text content="  (queue empty)" fg="#6b7280" /> : ready.map(row)}
      </box>
      <box
        flexDirection="column"
        width={width - half}
        border
        borderColor="#374151"
        title={`Blocked (${blocked.length})`}
      >
        {blocked.length === 0 ? (
          <text content="  (nothing blocked)" fg="#6b7280" />
        ) : (
          blocked.map(row)
        )}
      </box>
    </box>
  )
}
