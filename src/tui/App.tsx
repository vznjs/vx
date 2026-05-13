// Top-level component. Picks a view by `state.activeView`, layers
// Help / Task Detail overlays on top conditionally. Keyboard handler
// owns 1-5 view-switch, j/k selection, ?/esc overlays, q/Ctrl-C exit.

import type React from 'react'
import { useTerminalDimensions, useKeyboard } from './tui-shim.ts'
import { Header } from './components/Header.tsx'
import { TaskList } from './components/TaskList.tsx'
import { LogPane } from './components/LogPane.tsx'
import { ProgressBar } from './components/ProgressBar.tsx'
import { StatusBar } from './components/StatusBar.tsx'
import { StatsPanel } from './components/StatsPanel.tsx'
import { Graph } from './views/Graph.tsx'
import { Workers } from './views/Workers.tsx'
import { Queue } from './views/Queue.tsx'
import { Bottlenecks } from './views/Bottlenecks.tsx'
import { Help } from './overlays/Help.tsx'
import { TaskDetail } from './overlays/TaskDetail.tsx'
import { AutoExit } from './overlays/AutoExit.tsx'
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
    // Filter-editing mode owns the keys until Enter/Esc.
    if (state.filterEditing) {
      if (key.name === 'escape') {
        dispatch({ type: 'key', key: { kind: 'setFilter', value: '' } })
        dispatch({ type: 'key', key: { kind: 'endFilterEdit' } })
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        dispatch({ type: 'key', key: { kind: 'endFilterEdit' } })
        return
      }
      const current = state.filters[state.activeView] ?? ''
      if (key.name === 'backspace') {
        dispatch({ type: 'key', key: { kind: 'setFilter', value: current.slice(0, -1) } })
        return
      }
      // Treat printable single-character keys as typing input.
      const seq = (key as { sequence?: string }).sequence
      if (typeof seq === 'string' && seq.length === 1 && seq >= ' ' && seq !== '\x7f') {
        dispatch({ type: 'key', key: { kind: 'setFilter', value: current + seq } })
      }
      return
    }

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
    if (key.name === '/') {
      dispatch({ type: 'key', key: { kind: 'startFilterEdit' } })
      return
    }
    // Number row 1..5 switches views.
    for (const n of [1, 2, 3, 4, 5] as const) {
      if (key.name === String(n)) {
        dispatch({ type: 'key', key: { kind: 'viewChange', view: n } })
        return
      }
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
  // Rough elapsed-since-runStart in ms, used for live "slow vs history".
  const nowMs = Math.max(0, Date.now() - state.startedAtMs)

  let body: React.ReactNode
  switch (state.activeView) {
    case 2:
      body = <Graph state={state} width={width} height={bodyHeight} />
      break
    case 3:
      body = <Workers state={state} width={width} height={bodyHeight} />
      break
    case 4:
      body = <Bottlenecks state={state} width={width} height={bodyHeight} nowMs={nowMs} />
      break
    case 5:
      body = <Queue state={state} width={width} height={bodyHeight} />
      break
    case 1:
    default: {
      // Stats panel has a fixed footer height so TaskList takes the
      // remaining column space; otherwise yoga shrinks both
      // proportionally and TaskList collapses to a single visible row.
      const statsHeight = 6
      const taskListHeight = Math.max(3, bodyHeight - statsHeight)
      body = (
        <box flexDirection="row" width={width} height={bodyHeight}>
          <box flexDirection="column" width={listWidth} height={bodyHeight}>
            <TaskList state={state} width={listWidth} height={taskListHeight} />
            <StatsPanel state={state} width={listWidth} />
          </box>
          <LogPane state={state} width={logWidth} height={bodyHeight} />
        </box>
      )
    }
  }

  const overlay =
    state.autoExitAt !== undefined ? (
      <AutoExit autoExitAt={state.autoExitAt} screenWidth={width} screenHeight={height} />
    ) : state.taskDetailOpen ? (
      <TaskDetail state={state} screenWidth={width} screenHeight={height} />
    ) : state.showHelp ? (
      <Help screenWidth={width} screenHeight={height} />
    ) : null

  // Root is a relative-positioned box so children with `position=absolute`
  // anchor to it (their top/left are in screen coordinates).
  return (
    <box position="relative" flexDirection="column" width={width} height={height}>
      <Header state={state} version={version} width={width} />
      {state.totalNodes === 0 && !state.done ? (
        <box
          flexDirection="column"
          width={width}
          height={Math.max(3, bodyHeight)}
          paddingLeft={2}
          paddingTop={1}
        >
          <text content="Waiting for tasks…" fg="#9ca3af" />
          <text content="(orchestrator is loading the workspace)" fg="#6b7280" />
        </box>
      ) : (
        body
      )}
      <ProgressBar state={state} width={width} />
      <StatusBar
        width={width}
        activeView={state.activeView}
        showHelp={state.showHelp}
        filterEditing={state.filterEditing}
        filterValue={state.filters[state.activeView] ?? ''}
        selectedTaskId={state.selectedTaskId}
      />
      {overlay}
    </box>
  )
}
