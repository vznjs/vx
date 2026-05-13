// Task-list panel. Each row is a status icon + project/task id +
// optional cache flag + duration. The selected row gets a highlight
// background; the renderer drives selection via keyboard handlers in
// App.tsx.

import type React from 'react'
import type { State, TaskRow } from '../state/store.js'
import { selectFilteredTasks } from '../state/selectors.js'

interface Props {
  state: State
  width: number
  height: number
}

function icon(row: TaskRow): { glyph: string; fg: string } {
  switch (row.status) {
    case 'waiting':
      return { glyph: '⏳', fg: '#9ca3af' }
    case 'running':
      return { glyph: '▶', fg: '#eab308' }
    case 'success':
      return { glyph: '✓', fg: '#22c55e' }
    case 'cache-hit':
      return { glyph: '⚡', fg: '#22c55e' }
    case 'cache-hit-remote':
      return { glyph: '☁', fg: '#06b6d4' }
    case 'failed':
      return { glyph: '✗', fg: '#ef4444' }
    case 'skipped':
      return { glyph: '⊝', fg: '#6b7280' }
    default:
      return { glyph: '?', fg: '#9ca3af' }
  }
}

function elapsedMs(state: State, row: TaskRow): number | null {
  if (row.status === 'running' && row.startNs !== undefined) {
    return Math.max(
      0,
      Math.floor(
        Number(process.hrtime.bigint() - BigInt(state.startedAtMs) * 1_000_000n - row.startNs) /
          1_000_000,
      ),
    )
  }
  if (row.endNs !== undefined && row.startNs !== undefined) {
    return Math.max(0, Math.floor(Number(row.endNs - row.startNs) / 1_000_000))
  }
  return null
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function TaskList({ state, width, height }: Props): React.ReactNode {
  const rows = selectFilteredTasks(state)
  const selectedId = state.selectedTaskId
  // Visible window — simple top-pinned scroll (the design's full
  // selection-following scroller lands later).
  const visibleRows = rows.slice(0, Math.max(0, height - 2))
  const filterTerm = state.filters[state.activeView] ?? ''
  const title = filterTerm.length > 0 ? `Tasks (filter: ${filterTerm})` : 'Tasks'

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      border
      borderColor="#374151"
      title={title}
    >
      {visibleRows.map((row) => {
        const { glyph, fg } = icon(row)
        const dur = elapsedMs(state, row)
        const selected = row.id === selectedId
        return selected ? (
          <box
            key={row.id}
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor="#1f2937"
          >
            <text content={glyph} fg={fg} />
            <text content=" " />
            <text content={row.id} fg="#f3f4f6" />
            <text content=" " />
            {dur !== null ? <text content={formatMs(dur)} fg="#6b7280" /> : null}
          </box>
        ) : (
          <box key={row.id} flexDirection="row" paddingLeft={1} paddingRight={1}>
            <text content={glyph} fg={fg} />
            <text content=" " />
            <text content={row.id} fg="#d1d5db" />
            <text content=" " />
            {dur !== null ? <text content={formatMs(dur)} fg="#6b7280" /> : null}
          </box>
        )
      })}
    </box>
  )
}
