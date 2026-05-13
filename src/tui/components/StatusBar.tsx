// Bottom keymap hint. Three modes:
//   - filterEditing → shows "/" prompt + the in-progress filter,
//     plus Enter/Esc hints
//   - showHelp → "press ? to close"
//   - default → context-sensitive hints based on the active view

import type React from 'react'

interface Props {
  width: number
  activeView: 1 | 2 | 3 | 4 | 5
  showHelp: boolean
  filterEditing: boolean
  filterValue: string
  selectedTaskId: string | undefined
}

const VIEW_HINTS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'Overview',
  2: 'Graph',
  3: 'Workers',
  4: 'Bottlenecks',
  5: 'Queue',
}

export function StatusBar({
  showHelp,
  filterEditing,
  filterValue,
  activeView,
  selectedTaskId,
}: Props): React.ReactNode {
  if (filterEditing) {
    return (
      <box flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor="#0f172a">
        <text content="/" fg="#a78bfa" attributes={1} />
        <text content={filterValue} fg="#f3f4f6" />
        <text content=" " />
        <text content="(Enter to apply · Esc to cancel · Backspace to delete)" fg="#6b7280" />
      </box>
    )
  }
  if (showHelp) {
    return (
      <box flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor="#0f172a">
        <text content="? close help · esc close overlays · q quit" fg="#9ca3af" />
      </box>
    )
  }
  // Context hints per view.
  const left = `[${activeView}] ${VIEW_HINTS[activeView]}`
  let hint: string
  switch (activeView) {
    case 1:
      hint = selectedTaskId
        ? 'j/k select · enter detail · / filter · ? help · q quit'
        : 'j/k select · / filter · ? help · 1-5 switch · q quit'
      break
    case 2:
      hint = 't critical-path · / filter · ? help · 1-5 switch · q quit'
      break
    case 3:
      hint = '1-5 switch · / filter · ? help · q quit'
      break
    case 4:
      hint = '1-5 switch · ? help · q quit'
      break
    case 5:
      hint = '1-5 switch · / filter · ? help · q quit'
      break
  }
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor="#0f172a">
      <text content={left} fg="#a78bfa" attributes={1} />
      <text content="  " />
      <text content={hint} fg="#9ca3af" />
    </box>
  )
}
