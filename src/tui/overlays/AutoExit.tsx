// Post-run auto-dismiss countdown popup. Rendered when state.done
// and state.autoExitAt is set. Any key dispatch clears autoExitAt in
// the reducer, so this overlay simply disappears the next paint.

import type React from 'react'

interface Props {
  autoExitAt: number
}

export function AutoExit({ autoExitAt }: Props): React.ReactNode {
  const remaining = Math.max(0, autoExitAt - Date.now())
  const secs = Math.ceil(remaining / 1000)
  return (
    <box
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
      <text content="" />
      <text content="Press any key to stay open." fg="#9ca3af" />
      <text content="q quits immediately." fg="#9ca3af" />
    </box>
  )
}
