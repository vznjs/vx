// Single padded line. Three modes (filterEditing, showHelp, default);
// each composes a single string then pads to full width so the
// painter never leaves stale cells on mode transitions.

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

function viewHint(activeView: 1 | 2 | 3 | 4 | 5, selectedTaskId: string | undefined): string {
  switch (activeView) {
    case 1:
      return selectedTaskId
        ? 'j/k select · enter detail · / filter · ? help · q quit'
        : 'j/k select · / filter · ? help · 1-5 switch · q quit'
    case 2:
      return '/ filter · ? help · 1-5 switch · q quit'
    case 3:
      return '1-5 switch · / filter · ? help · q quit'
    case 4:
      return '1-5 switch · ? help · q quit'
    case 5:
      return '1-5 switch · / filter · ? help · q quit'
  }
}

export function StatusBar({
  width,
  activeView,
  showHelp,
  filterEditing,
  filterValue,
  selectedTaskId,
}: Props): React.ReactNode {
  let raw: string
  if (filterEditing) {
    raw = ` / ${filterValue}    (Enter to apply · Esc to cancel · Backspace to delete)`
  } else if (showHelp) {
    raw = ` ? close help · esc close overlays · q quit`
  } else {
    raw = ` [${activeView}] ${VIEW_HINTS[activeView]}  ${viewHint(activeView, selectedTaskId)}`
  }
  const line = raw.length > width ? raw.slice(0, width) : raw.padEnd(width, ' ')
  return (
    <box width={width} backgroundColor="#0f172a">
      <text content={line} fg="#9ca3af" />
    </box>
  )
}
