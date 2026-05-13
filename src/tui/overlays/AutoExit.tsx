// Post-run auto-dismiss countdown popup. Mounted with absolute
// positioning so it overlays the underlying view; sized to a fixed
// box centered on the screen (Turbo / lazygit pattern).

import type React from 'react'

interface Props {
  autoExitAt: number
  screenWidth: number
  screenHeight: number
}

const POPUP_WIDTH = 44
const POPUP_HEIGHT = 7

export function AutoExit({ autoExitAt, screenWidth, screenHeight }: Props): React.ReactNode {
  const remaining = Math.max(0, autoExitAt - Date.now())
  const secs = Math.ceil(remaining / 1000)
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
      title="Run complete"
      backgroundColor="#111827"
    >
      <text content={`Closing in ${secs}s…`} fg="#f3f4f6" attributes={1} />
      <text content=" " fg="#111827" />
      <text content="Press any key to stay open." fg="#9ca3af" />
      <text content="q quits immediately." fg="#9ca3af" />
    </box>
  )
}
