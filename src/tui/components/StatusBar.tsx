// Single-line keymap hint strip at the very bottom of the screen.

import type React from 'react'

interface Props {
  width: number
  showHelp: boolean
}

export function StatusBar({ showHelp }: Props): React.ReactNode {
  const hint = showHelp
    ? 'j/k select · enter detail · / filter · ? toggle help · q quit'
    : 'j/k select · enter detail · / filter · ? help · q quit'
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor="#0f172a">
      <text content={hint} fg="#9ca3af" />
    </box>
  )
}
