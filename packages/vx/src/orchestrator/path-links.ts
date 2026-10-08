// A failed task's output with each file it names made a terminal link
// (OSC 8). A tool prints paths relative to where it ran, the task's
// project, so the terminal's own path detection, which resolves against
// the shell's directory, opens the wrong file or none in a monorepo. The
// visible text stays the task's bytes; only the link target is vx's.

import { statSync } from 'node:fs'
import path from 'node:path'

// `src/a.ts`, `./a.ts:12`, `/abs/a.ts:12:5`, tsc's `src/a.ts(12,5)`. Not
// after a word, dot, slash or `@`, so a URL's path or a scoped name's tail
// never starts a match.
const PATH =
  /(?<![\w./@+-])((?:\/|\.{1,2}\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,9})(?::\d+(?::\d+)?|\(\d+,\d+\))?/g

/** `text` with every path that names a file under `dir` (or an absolute one) linked. */
export function linkPaths(text: string, dir: string, isFile: (abs: string) => boolean): string {
  if (text.includes('\x1b]8;')) return text
  return text.replace(PATH, (match: string, file: string) => {
    const abs = path.resolve(dir, file)
    if (!isFile(abs)) return match
    return `\x1b]8;;file://${encodeURI(abs)}\x1b\\${match}\x1b]8;;\x1b\\`
  })
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
