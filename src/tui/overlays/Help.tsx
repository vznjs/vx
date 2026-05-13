// Help overlay — modal popup centered over the active view.
// Absolutely positioned with opaque backgroundColor so it actually
// covers the cells underneath.

import type React from 'react'

interface Props {
  screenWidth: number
  screenHeight: number
}

const HINTS: [string, string][] = [
  ['1', 'Overview'],
  ['2', 'Graph'],
  ['3', 'Workers'],
  ['4', 'Bottlenecks'],
  ['5', 'Queue'],
  ['j / ↓', 'next task'],
  ['k / ↑', 'previous task'],
  ['enter', 'open task detail'],
  ['esc', 'close overlay / clear filter'],
  ['/', 'filter (per-view)'],
  ['?', 'toggle this help'],
  ['q / ^C', 'quit'],
]

const POPUP_WIDTH = 56
const POPUP_HEIGHT = Math.min(28, HINTS.length + 6)

export function Help({ screenWidth, screenHeight }: Props): React.ReactNode {
  const left = Math.max(0, Math.floor((screenWidth - POPUP_WIDTH) / 2))
  const top = Math.max(0, Math.floor((screenHeight - POPUP_HEIGHT) / 2))
  return (
    <box
      position="absolute"
      left={left}
      top={top}
      width={POPUP_WIDTH}
      height={POPUP_HEIGHT}
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      border
      borderColor="#a78bfa"
      title="Help"
      backgroundColor="#111827"
    >
      <text content="Keymap" fg="#a78bfa" attributes={1} />
      <text content=" " fg="#111827" />
      {HINTS.map(([key, label]) => (
        <box key={key} flexDirection="row">
          <text content={key.padEnd(10)} fg="#22c55e" attributes={1} />
          <text content={label} fg="#d1d5db" />
        </box>
      ))}
    </box>
  )
}
