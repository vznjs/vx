// A config refusal pointed at its line: `vx.config.ts:7:9` (which a
// terminal opens on click) and the source around it. Read from the
// message the schema already writes (`<file>: tasks.<name>.<path> …`),
// so it works for a refusal made in the config worker as for one made
// here, and a message it cannot place prints as it always did.

import { readFileSync } from 'node:fs'
import path from 'node:path'

// `<file>: tasks.<path>[:] …`, or a top-level `<file> has unknown field …`.
const HEAD = /^(\/[^\n]*?\/vx\.config\.[cm]?[jt]s)(?:: (tasks\.[^\s:]+)(:?))? /

/**
 * The message with its file named at `line:col`, relative to `cwd`, and a
 * frame of the source under it; undefined when the message names no
 * config field or the field is not found in the file.
 */
export function configErrorFrame(message: string, cwd: string): string | undefined {
  const head = HEAD.exec(message)
  if (head === null) return undefined
  const [, file, fieldPath, colon] = head as unknown as [string, string, string?, string?]
  const rest = message.slice(head[0].length)
  // The field the refusal is about, past the path that leads to it:
  // `has unknown field "comand"`, or `tasks.build: \`cache\` is not allowed`.
  const named =
    colon === ':' ? /^`([^`]+)`/.exec(rest) : /^has (?:unknown )?field "([^"]+)"/.exec(rest)
  const segments = [...(fieldPath?.split('.') ?? []), ...(named === null ? [] : [named[1]!])]
  if (segments.length === 0) return undefined
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const at = locate(source, segments)
  if (at === undefined) return undefined
  const lines = source.split('\n')
  // Relative to where the user stands, unless that means climbing out.
  const rel = path.relative(cwd, file)
  const shown = rel === '' || rel.startsWith('..') ? file : rel
  const first = Math.max(1, at.line - 2)
  const width = String(at.line).length
  const frame: string[] = []
  for (let n = first; n <= at.line; n++) {
    const mark = n === at.line ? '>' : ' '
    frame.push(`${mark} ${String(n).padStart(width)} | ${lines[n - 1]!.replace(/\t/g, '  ')}`)
  }
  const lead = lines[at.line - 1]!.slice(0, at.col - 1)
    .replace(/\t/g, '  ')
    .replace(/\S/g, ' ')
  frame.push(`  ${' '.repeat(width)} | ${lead}^`)
  return `${shown}:${at.line}:${at.col}${message.slice(file.length)}\n\n${frame.join('\n')}`
}

/**
 * Where the last of `segments` is declared as a key, each one searched
 * after the one before. A task name holds dots (`lint.oxfmt`), so the
 * longest run of segments that names a key wins.
 */
function locate(
  source: string,
  segments: readonly string[],
): { line: number; col: number } | undefined {
  let pos = 0
  let found = -1
  let i = 0
  while (i < segments.length) {
    let next = -1
    for (let j = segments.length; j > i && next < 0; j--) {
      const name = segments.slice(i, j).join('.')
      const re = new RegExp(`(?<![\\w$.])(['"\`]?)${escapeRe(name)}\\1\\s*:`, 'g')
      re.lastIndex = pos
      const m = re.exec(source)
      if (m === null) continue
      found = m.index + m[1]!.length
      pos = m.index + m[0].length
      next = j
    }
    if (next < 0) return undefined
    i = next
  }
  if (found < 0) return undefined
  const before = source.slice(0, found)
  const line = before.split('\n').length
  return { line, col: found - before.lastIndexOf('\n') }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
