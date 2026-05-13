// Left-sidebar task list. Sorted Turbo-style: running first
// (spinner icon), then planned (no icon), then finished (status
// glyph: ✓ / ⊙ / ⨯ / ⊝). The selected row is highlighted.

import { createMemo, For } from 'solid-js'
import { TextAttributes } from '@opentui/core'
import { useTheme } from '../context/theme.tsx'
import { useRunState, type TaskRow } from '../context/run-state.tsx'
import { useClock } from '../context/clock.tsx'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

interface RowProps {
  row: TaskRow
  selected: boolean
  spinnerFrame: string
}

function statusIcon(row: TaskRow, spinnerFrame: string): { glyph: string; fg?: string } {
  switch (row.status) {
    case 'running':
      return { glyph: spinnerFrame }
    case 'success':
      return { glyph: '✓', fg: '#22c55e' }
    case 'cache-hit':
    case 'cache-hit-remote':
      return { glyph: '⊙', fg: '#c084fc' }
    case 'failed':
      return { glyph: '⨯', fg: '#ef4444' }
    case 'skipped':
      return { glyph: '⊝', fg: '#6b7280' }
    case 'planned':
    default:
      return { glyph: ' ' }
  }
}

function TaskRowItem(props: RowProps) {
  const { theme } = useTheme()
  const icon = createMemo(() => statusIcon(props.row, props.spinnerFrame))
  return (
    <box
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.selected ? theme.backgroundElement : theme.background}
    >
      <text fg={icon().fg ?? theme.textMuted}>{icon().glyph}</text>
      <text fg={theme.text}> </text>
      <text fg={props.selected ? theme.text : theme.textMuted}>{props.row.id}</text>
    </box>
  )
}

export function TaskList(props: { width: number }) {
  const { theme } = useTheme()
  const { state } = useRunState()
  const clock = useClock()

  // Spinner frame keyed by the global clock tick (10 Hz). When the
  // tick signal updates, this memo invalidates and re-renders.
  const spinnerFrame = createMemo(() => {
    return SPINNER_FRAMES[clock.tick() % SPINNER_FRAMES.length]!
  })

  const ordered = createMemo<TaskRow[]>(() => {
    const rows: TaskRow[] = []
    for (const id of state.running) {
      const r = state.byId[id]
      if (r) rows.push(r)
    }
    for (const id of state.planned) {
      const r = state.byId[id]
      if (r) rows.push(r)
    }
    for (const id of state.finished) {
      const r = state.byId[id]
      if (r) rows.push(r)
    }
    return rows
  })

  const header = createMemo(() => {
    return state.totalTasks === 0
      ? 'Tasks (loading…)'
      : `Tasks (${state.running.length} running, ${state.finished.length}/${state.totalTasks})`
  })

  return (
    <box
      flexDirection="column"
      width={props.width}
      borderColor={theme.border}
      border={['right' as const]}
    >
      <box flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
          {header()}
        </text>
      </box>
      <For each={ordered()}>
        {(row) => (
          <TaskRowItem
            row={row}
            selected={row.id === state.selectedId}
            spinnerFrame={spinnerFrame()}
          />
        )}
      </For>
    </box>
  )
}
