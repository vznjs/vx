// App shell — assembles the layout (TaskList + LogPane + StatusBar)
// and wires keyboard bindings. Layered Dialog (Help) sits on top via
// DialogProvider's render stack.

import { useKeyboard, useTerminalDimensions } from '@opentui/solid'
import { createEffect, on, onCleanup } from 'solid-js'
import { useTheme } from './context/theme.tsx'
import { useRunState } from './context/run-state.tsx'
import { usePtyStore } from './context/pty-store.tsx'
import { useDialog } from './ui/dialog.tsx'
import { TaskList } from './component/task-list.tsx'
import { LogPane } from './component/log-pane.tsx'
import { StatusBar } from './component/status-bar.tsx'
import { HelpDialog } from './overlay/help-dialog.tsx'

const TASK_LIST_WIDTH = 32
const RESIZE_DEBOUNCE_MS = 150

export function App() {
  const { theme } = useTheme()
  const dim = useTerminalDimensions()
  const run = useRunState()
  const pty = usePtyStore()
  const dialog = useDialog()

  // Debounce resize so we don't resize every pty on every dimension
  // update. opentui can fire several resize events in a burst.
  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  createEffect(
    on(
      () => `${dim().width}x${dim().height}`,
      () => {
        if (resizeTimer) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          pty.resizeAll(
            Math.max(20, dim().width - TASK_LIST_WIDTH - 2),
            Math.max(5, dim().height - 1),
          )
          resizeTimer = null
        }, RESIZE_DEBOUNCE_MS)
      },
    ),
  )

  useKeyboard((key) => {
    try {
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        run.requestExit()
        return
      }
      if (dialog.stack.length > 0) {
        if (key.name === 'escape' || key.name === 'return' || key.name === 'enter') {
          dialog.clear()
        }
        return
      }
      if (key.name === 'm') {
        dialog.show(<HelpDialog />)
        return
      }
      if (key.name === 'down' || key.name === 'j') {
        run.selectNext()
        return
      }
      if (key.name === 'up' || key.name === 'k') {
        run.selectPrev()
      }
    } catch (err) {
      // A bug in the handler must NOT crash the TUI. Surface to
      // stderr (visible after teardown) but stay alive.
      process.stderr.write(`[vx tui] key handler error: ${(err as Error).message}\n`)
    }
  })

  onCleanup(() => {
    if (resizeTimer) clearTimeout(resizeTimer)
    pty.disposeAll()
  })

  return (
    <box
      position="relative"
      flexDirection="column"
      width={dim().width}
      height={dim().height}
      backgroundColor={theme.background}
    >
      <box flexDirection="row" width={dim().width} height={dim().height - 1}>
        <TaskList width={TASK_LIST_WIDTH} />
        <LogPane width={dim().width - TASK_LIST_WIDTH} height={dim().height - 1} />
      </box>
      <StatusBar width={dim().width} />
    </box>
  )
}
