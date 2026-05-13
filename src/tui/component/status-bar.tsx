// Bottom hint strip. Single padded line (defeats any cell-level
// ghosting). Mirrors Turbo's footer text.

import { createMemo } from 'solid-js'
import { useTheme } from '../context/theme.tsx'
import { useRunState } from '../context/run-state.tsx'

export function StatusBar(props: { width: number }) {
  const { theme } = useTheme()
  const { state } = useRunState()
  const text = createMemo(() => {
    if (state.done) return ' ✓ run complete · q quit · ↑/↓ select · m more binds'
    const running = state.running.length
    const total = state.totalTasks
    const done = state.finished.length
    return ` ${done}/${total} done · ${running} running · ↑/↓ select · m more binds · q quit`
  })
  return (
    <box flexDirection="row" width={props.width} backgroundColor={theme.backgroundElement}>
      <text fg={theme.textMuted}>{text().padEnd(props.width, ' ').slice(0, props.width)}</text>
    </box>
  )
}
