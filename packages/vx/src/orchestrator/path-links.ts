// A failed task's output with each file it names made a terminal link
// (OSC 8). A tool prints paths relative to where it ran, the task's
// project, so the terminal's own path detection, which resolves against
// the shell's directory, opens the wrong file or none in a monorepo. The
// visible text stays the task's bytes; only the link target is vx's.

import { statSync } from 'node:fs'
import path from 'node:path'

// `src/a.ts`, `./a.ts:12`, `/abs/a.ts:12:5`, tsc's `src/a.ts(12,5)`. Not
// after a word, dot, slash or `@`, so a URL's path or a scoped name's tail
// never starts a match. Groups: file, then line and column of either form.
const PATH =
  /(?<![\w./@+-])((?:\/|\.{1,2}\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))?/g

/** A file a task's output names; `file` absolute. */
export interface OutputLocation {
  file: string
  line?: number
  col?: number
}

/** Most locations one output reports: past it, the first ones are the cause. */
const LOCATIONS_CAP = 50

/** `text` with every path that names a file under `dir` (or an absolute one) linked. */
export function linkPaths(text: string, dir: string, isFile: (abs: string) => boolean): string {
  if (text.includes('\x1b]8;')) return text
  return text.replace(PATH, (match: string, file: string) => {
    const abs = path.resolve(dir, file)
    if (!isFile(abs)) return match
    return `\x1b]8;;file://${encodeURI(abs)}\x1b\\${match}\x1b]8;;\x1b\\`
  })
}

/**
 * The files `text` names that exist (resolved against `dir`), each with the
 * line and column it gave, unique, in order of first appearance.
 */
export function fileLocations(
  text: string,
  dir: string,
  isFile: (abs: string) => boolean,
): OutputLocation[] {
  const out: OutputLocation[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(PATH)) {
    const file = path.resolve(dir, m[1]!)
    const line = m[2] ?? m[4]
    const col = m[3] ?? m[5]
    const id = `${file}:${line}:${col}`
    if (seen.has(id) || !isFile(file)) continue
    seen.add(id)
    out.push({
      file,
      ...(line !== undefined ? { line: Number(line) } : {}),
      ...(col !== undefined ? { col: Number(col) } : {}),
    })
    if (out.length === LOCATIONS_CAP) break
  }
  return out
}

/** A file test that asks the file system once per path. */
export function fileMemo(): (abs: string) => boolean {
  const seen = new Map<string, boolean>()
  return (abs) => {
    let known = seen.get(abs)
    if (known === undefined) {
      try {
        known = statSync(abs).isFile()
      } catch {
        known = false
      }
      seen.set(abs, known)
    }
    return known
  }
}
