// Right-side pane. Reads the selected task's xterm-headless screen
// and renders the bottom-N lines (clipped to pane height).
//
// The pty-store's `rev` signal is throttled to ~30 Hz so we re-render
// at most that often regardless of how many bytes the task emitted.

import { createMemo, For, Show } from 'solid-js'
import { TextAttributes } from '@opentui/core'
import { useTheme } from '../context/theme.tsx'
import { useRunState } from '../context/run-state.tsx'
import { usePtyStore } from '../context/pty-store.tsx'

export function LogPane(props: { width: number; height: number }) {
  const { theme } = useTheme()
  const { state } = useRunState()
  const ptyStore = usePtyStore()

  const lines = createMemo<string[]>(() => {
    // Subscribe to the throttled rev tick.
    ptyStore.rev()
    const id = state.selectedId
    if (!id) return []
    const row = state.byId[id]
    if (!row) return []
    const pty = ptyStore.get(id)
    if (!pty) return []
    const all = pty.readLines()
    // Trim trailing blank lines so the viewport shows live output
    // near the top of the pane.
    let end = all.length
    while (end > 0 && all[end - 1]!.trim() === '') end--
    const trimmed = all.slice(0, end)
    const visibleRows = Math.max(1, props.height - 2)
    return trimmed.slice(Math.max(0, trimmed.length - visibleRows))
  })

  const title = createMemo(() => {
    const id = state.selectedId
    if (!id) return 'Log'
    const row = state.byId[id]
    if (!row) return 'Log'
    return ` ${row.id} > ${row.status} `
  })

  return (
    <box flexDirection="column" width={props.width} height={props.height}>
      <box flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
          {title()}
        </text>
      </box>
      <Show
        when={state.selectedId !== null && lines().length > 0}
        fallback={
          <text fg={theme.textMuted}>
            {state.selectedId
              ? '  (no output yet — task may not have started)'
              : '  (select a task on the left)'}
          </text>
        }
      >
        <For each={lines()}>
          {(line) => <text fg={theme.text}>{line.length === 0 ? ' ' : line}</text>}
        </For>
      </Show>
    </box>
  )
}
