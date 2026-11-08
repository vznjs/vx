// When each command of the run ran, and each restore or deferred fetch, and where it
// may write, so `inputs.stability.strategy: 'mutable'` can tell a task's
// own identical rewrite from another task's write and restore (STATUS item
// 28), and `vx watch` a user's write from the run's own: a file
// whose bytes match the key after a write is the task's own only if no
// other command that may write it ran between the describe and that write.

import path from 'node:path'
import type { WriteReach } from './sandbox-request.js'

interface Window {
  id: string
  projectDir: string
  reach: WriteReach
  from: number
  to: number
}

export interface CommandWindows {
  /** A command, a hit's restore or a deferred fetch starts; the returned function marks its end. A server never calls it. */
  open(id: string, projectDir: string, reach: WriteReach): () => void
  /** Another command that may write `file` and ran at some point in [from, to]. */
  writerDuring(self: string, file: string, from: number, to: number): string | undefined
}

export function commandWindows(): CommandWindows {
  const windows: Window[] = []
  return {
    open(id, projectDir, reach) {
      if (reach === 'none') return () => {}
      const w: Window = { id, projectDir, reach, from: Date.now(), to: Infinity }
      windows.push(w)
      return () => {
        // `Date.now()` floors to the ms and a ctime does not: the command's
        // last write can be stamped up to a millisecond past it.
        w.to = Date.now() + 1
      }
    },
    writerDuring(self, file, from, to) {
      for (const w of windows) {
        if (w.id === self || w.from > to || w.to < from) continue
        if (w.reach === 'workspace' || file.startsWith(w.projectDir + path.sep)) return w.id
      }
      return undefined
    },
  }
}
