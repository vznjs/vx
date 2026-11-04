// A config refusal pointed at its line: `vx.config.ts:7:9` (which a
// terminal opens on click) and the source around it. Read from the
// message the schema already writes (`<file>: tasks.<name>.<path> …`),
// so it works for a refusal made in the config worker as for one made
// here, and a message it cannot place prints as it always did.

import { readFileSync } from 'node:fs'
import path from 'node:path'

// `<file>: tasks.<path>[:] …`, or a top-level `<file> has unknown field …`,
// from a project's vx.config or the workspace's .vx/workspace.ts.
const HEAD = /^(\/[^\n]*?\/(?:vx\.config|\.vx\/workspace)\.[cm]?[jt]s)(?:: (tasks\.[^\s:]+)(:?))? /

/**
 * The message with its file named at `line:col`, relative to `cwd`, and a
 * frame of the source under it; undefined when the message names no
 * config field or the field is not found in the file.
 */
export function configErrorFrame(message: string, cwd: string): string | undefined {
  const head = HEAD.exec(message)
  if (head === null) return positionFrame(message, cwd)
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
  return framed(file, source, at, message.slice(file.length), cwd)
}

// The loader's `Project config <file>:<line>:<col>: …`: a syntax error,
// placed by Bun, in the config itself.
const POSITION =
  /^(?:Project|Workspace) config (\/[^\n]*?\/(?:vx\.config|\.vx\/workspace)\.[cm]?[jt]s):(\d+):(\d+)(: [^]*)$/

function positionFrame(message: string, cwd: string): string | undefined {
  const pos = POSITION.exec(message)
  if (pos === null) return undefined
  const [, file, line, col, rest] = pos as unknown as [string, string, string, string, string]
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const at = { line: Number(line), col: Math.max(1, Number(col)) }
  if (at.line < 1 || at.line > source.split('\n').length) return undefined
  return framed(file, source, at, rest, cwd)
}

/** `<file>:<line>:<col><rest>` relative to `cwd`, over the source lines up to `at`. */
function framed(
  file: string,
  source: string,
  at: { line: number; col: number },
  rest: string,
  cwd: string,
): string {
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
  return `${shown}:${at.line}:${at.col}${rest}\n\n${frame.join('\n')}`
}

/**
 * Where the last of `segments` is declared as a key, each one searched
 * inside the object literal the one before holds. A task name holds dots
 * (`lint.oxfmt`), so the longest run of segments that names a key wins.
 * A last segment the object leaves out (`outputs is required`) is placed
 * at its parent: searched past it, the next task's `outputs` was framed.
 */
function locate(
  source: string,
  segments: readonly string[],
): { line: number; col: number } | undefined {
  let pos = 0
  let end = source.length
  let found = -1
  let i = 0
  while (i < segments.length) {
    let next = -1
    for (let j = segments.length; j > i && next < 0; j--) {
      const name = segments.slice(i, j).join('.')
      const re = new RegExp(`(?<![\\w$.])(['"\`]?)${escapeRe(name)}\\1\\s*:`, 'g')
      re.lastIndex = pos
      const m = re.exec(source)
      if (m === null || m.index >= end) continue
      found = m.index + m[1]!.length
      pos = m.index + m[0].length
      end = literalEnd(source, pos)
      next = j
    }
    if (next < 0) {
      if (found < 0 || i !== segments.length - 1) return undefined
      break
    }
    i = next
  }
  if (found < 0) return undefined
  const before = source.slice(0, found)
  const line = before.split('\n').length
  return { line, col: found - before.lastIndexOf('\n') }
}

/**
 * Where the object or array literal starting at `from` (past blanks) ends;
 * `from` itself when the value is no literal (`exec: 'x'`, `cache: shared`),
 * so no key is searched inside it.
 */
function literalEnd(source: string, from: number): number {
  let i = from
  while (i < source.length && /\s/.test(source[i]!)) i++
  if (source[i] !== '{' && source[i] !== '[') return from
  let depth = 0
  for (; i < source.length; i++) {
    const c = source[i]!
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === '\\') i++
    } else if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i)
      if (i < 0) return source.length
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2)
      if (i < 0) return source.length
      i++
    } else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return source.length
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A config refusal laid out for `ui.notice`: where, what, the allowed set, the fix, the frame. */
export interface ConfigRefusal {
  where: string
  problem: string
  allowed?: string
  fix?: string
  frame: string
}

/** `configErrorFrame`'s answer in parts, or undefined when it has none. */
export function configRefusal(message: string, cwd: string): ConfigRefusal | undefined {
  const framed = configErrorFrame(message, cwd)
  if (framed === undefined) return undefined
  const cut = framed.indexOf('\n\n')
  const line = framed.slice(0, cut)
  const frame = framed.slice(cut + 2)
  // A path may hold spaces (`packages/my app/`); the first `:line:col` ends it.
  const at = /^([^\n]+?:\d+:\d+):? (.*)$/s.exec(line)
  if (at === null) return { where: line, problem: '', frame }
  // After ` — `: the field meant, or how vx spells another runner's field.
  const said =
    /^(.*?)(?: \(allowed: ([^)]*)\))?(?: — (?:did you mean ([^?]+)\?|vx spells it (.+)))?$/s.exec(
      at[2]!,
    )!
  return {
    where: at[1]!,
    problem: said[1]!.replace(/^has /, ''),
    ...(said[2] !== undefined ? { allowed: said[2] } : {}),
    ...(said[3] !== undefined ? { fix: `use ${said[3]}` } : {}),
    ...(said[4] !== undefined ? { fix: `use ${said[4]}` } : {}),
    frame,
  }
}
