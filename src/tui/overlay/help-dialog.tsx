// Help dialog — bound to `m` per the Turbo convention (and the
// StatusBar hint). Closes on enter / esc; clicking outside the
// popup also closes it (handled by Dialog's backdrop onMouseUp).

import { TextAttributes } from '@opentui/core'
import { For } from 'solid-js'
import { useTheme } from '../context/theme.tsx'
import { useDialog } from '../ui/dialog.tsx'

const BINDS: [string, string][] = [
  ['↑ / k', 'select previous task'],
  ['↓ / j', 'select next task'],
  ['m', 'toggle this help'],
  ['esc', 'close dialogs'],
  ['q', 'quit'],
  ['ctrl+c', 'quit'],
]

export function HelpDialog() {
  const { theme } = useTheme()
  const dialog = useDialog()
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Help
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc / enter
        </text>
      </box>
      <box flexDirection="column">
        <For each={BINDS}>
          {([key, desc]) => (
            <box flexDirection="row">
              <text fg={theme.success} attributes={TextAttributes.BOLD}>
                {key.padEnd(10)}
              </text>
              <text fg={theme.text}>{desc}</text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
