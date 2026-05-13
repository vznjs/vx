// Help overlay — rendered above the active view when state.showHelp.
// One column, fixed layout. `?` toggles; Esc / `?` again closes.

import type React from 'react'

interface Props {
  width: number
  height: number
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
  ['esc', 'close overlay'],
  ['/', 'filter (per-view)'],
  ['?', 'toggle this help'],
  ['q / ^C', 'quit'],
]

export function Help({ width, height }: Props): React.ReactNode {
  void width
  void height
  return (
    <box
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
      <text content=" " />
      {HINTS.map(([key, label]) => (
        <box key={key} flexDirection="row">
          <text content={key.padEnd(10)} fg="#22c55e" attributes={1} />
          <text content={label} fg="#d1d5db" />
        </box>
      ))}
    </box>
  )
}
