// What a module below the terminal has to say mid-run (a sandbox grant it
// cannot mount, an observer that threw, a config still evaluating), as a
// fact. `ui` owns the streams and draws each one; nothing here writes.

import type { Tone } from './styled.js'

/**
 * `line`: one line that opens with its own tag (`[vx] sandbox: …`), said
 * as `ui.say` says it. `notice`: a sentence vx says, laid out as a notice.
 */
export interface Notice {
  readonly kind: 'line' | 'notice'
  readonly tone: Tone
  readonly text: string
}

type Drawer = (n: Notice) => void

let drawer: Drawer | undefined
// Said before a drawer is set: kept, never dropped, and drawn when one is.
let held: Notice[] = []

export function notify(n: Notice): void {
  if (drawer === undefined) held.push(n)
  else drawer(n)
}

/** Set by `ui` when it loads: from then on every notice is drawn by `draw`. */
export function onNotice(draw: Drawer): void {
  drawer = draw
  const said = held
  held = []
  for (const n of said) draw(n)
}
