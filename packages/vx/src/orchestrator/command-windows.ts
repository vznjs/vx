// When each command of the run ran, and each restore or deferred fetch, and where it
// may write, so `inputs.stability.strategy: 'mutable'` can tell a task's
// own identical rewrite from another task's write and restore, and `vx
// watch` a user's write from the run's own: a file whose bytes match the key after a write is the task's own only if no
// other command that may write it ran between the describe and that write.

import path from 'node:path'
import type { WriteReach } from '../sandbox/index.js'

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
  /**
   * Whether any command, restore or fetch whose reach covers `dir` (one in
   * `dir` or a directory above it, or one reaching the workspace) was
   * running at some point after `from` and at or before `to`. A write in
   * contract to a file under `dir` in that span needs one.
   */
  reachedSince(dir: string, from: number, to: number): boolean
  /** Told of each window as it opens, before its command may write. */
  onOpen(listener: (projectDir: string, reach: WriteReach) => void): void
}

export function commandWindows(): CommandWindows {
  const windows: Window[] = []
  // By directory, so `reachedSince` asks a project's few windows, not the run's.
  const byDir = new Map<string, Window[]>()
  const wide: Window[] = []
  const listeners: ((projectDir: string, reach: WriteReach) => void)[] = []
  const ancestors = new Map<string, readonly string[]>()
  const chainOf = (dir: string): readonly string[] => {
    let chain = ancestors.get(dir)
    if (chain === undefined) {
      const dirs: string[] = []
      for (let d = dir; ;) {
        dirs.push(d)
        const up = path.dirname(d)
        if (up === d) break
        d = up
      }
      chain = dirs
      ancestors.set(dir, chain)
    }
    return chain
  }
  const overlaps = (list: readonly Window[] | undefined, from: number, to: number): boolean => {
    if (list === undefined) return false
    for (const w of list) if (w.to > from && w.from <= to) return true
    return false
  }
  return {
    open(id, projectDir, reach) {
      if (reach === 'none') return () => {}
      for (const l of listeners) l(projectDir, reach)
      const w: Window = { id, projectDir, reach, from: Date.now(), to: Infinity }
      windows.push(w)
      if (reach === 'workspace') wide.push(w)
      else {
        const list = byDir.get(projectDir)
        if (list === undefined) byDir.set(projectDir, [w])
        else list.push(w)
      }
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
    reachedSince(dir, from, to) {
      if (overlaps(wide, from, to)) return true
      for (const d of chainOf(dir)) if (overlaps(byDir.get(d), from, to)) return true
      return false
    },
    onOpen(listener) {
      listeners.push(listener)
    },
  }
}
