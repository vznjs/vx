// Single top-level component for the Phase 2B minimum-viable TUI.
// Reads `state` from the store (wired via `useSyncExternalStore` in
// `tui.ts`) and dispatches via `dispatch`. Every component below this
// takes props, not the full store reference (the §10 extension-point
// contract).

import type React from 'react'
import { useTerminalDimensions, useKeyboard } from './tui-shim.ts'
import { Header } from './components/Header.tsx'
import { TaskList } from './components/TaskList.tsx'
import { LogPane } from './components/LogPane.tsx'
import { ProgressBar } from './components/ProgressBar.tsx'
import { StatusBar } from './components/StatusBar.tsx'
import type { Action, State } from './state/store.js'

interface Props {
  state: State
  dispatch: (action: Action) => void
  version: string
  onExit: () => void
}

export function App({ state, dispatch, version, onExit }: Props): React.ReactNode {
  const { width, height } = useTerminalDimensions()

  useKeyboard((key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      onExit()
      return
    }
    if (key.name === '?') {
      dispatch({ type: 'key', key: { kind: 'toggleHelp' } })
      return
    }
    if (key.name === 'escape') {
      dispatch({ type: 'key', key: { kind: 'closeOverlay' } })
      return
    }
    const ids = [...state.tasks.keys()]
    const currentIdx = state.selectedTaskId ? ids.indexOf(state.selectedTaskId) : -1
    if (key.name === 'down' || key.name === 'j') {
      const next = ids[Math.min(ids.length - 1, currentIdx + 1)]
      if (next) dispatch({ type: 'key', key: { kind: 'selectTask', taskId: next } })
      return
    }
    if (key.name === 'up' || key.name === 'k') {
      const next = ids[Math.max(0, currentIdx - 1)]
      if (next) dispatch({ type: 'key', key: { kind: 'selectTask', taskId: next } })
      return
    }
    if (key.name === 'return' || key.name === 'enter') {
      dispatch({ type: 'key', key: { kind: 'openTaskDetail' } })
    }
  })

  const headerHeight = 1
  const progressHeight = 1
  const statusHeight = 1
  const bodyHeight = Math.max(3, height - headerHeight - progressHeight - statusHeight)
  const listWidth = Math.max(20, Math.floor(width * 0.45))
  const logWidth = width - listWidth

  return (
    <box flexDirection="column" width={width} height={height}>
      <Header state={state} version={version} />
      <box flexDirection="row" width={width} height={bodyHeight}>
        <TaskList state={state} width={listWidth} height={bodyHeight} />
        <LogPane state={state} width={logWidth} height={bodyHeight} />
      </box>
      <ProgressBar state={state} width={width} />
      <StatusBar width={width} showHelp={state.showHelp} />
    </box>
  )
}
