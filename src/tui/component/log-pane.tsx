// Right-side pane. Reads the selected task's xterm-headless screen
// and renders the bottom-N lines (clipped to pane height). The
// vt100 parser inside xterm-headless does all the work of
// interpreting ANSI escapes, `\r` overwrites, cursor moves, etc.

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
    // Subscribe to pty writes via the rev signal so we re-render on
    // every new chunk.
    ptyStore.rev()
    const id = state.selectedId
    if (!id) return []
    const row = state.byId[id]
    if (!row) return []
    const pty = ptyStore.get(id)
    if (!pty) return []
    const all = pty.readLines()
    while (all.length > 0 && all[all.length - 1]!.trim() === '') all.pop()
    const visibleRows = Math.max(1, props.height - 2)
    return all.slice(Math.max(0, all.length - visibleRows))
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
