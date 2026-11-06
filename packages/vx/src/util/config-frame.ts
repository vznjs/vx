// A config refusal pointed at its line: `vx.config.ts:7:9` (which a
// terminal opens on click) and the source around it. Read from the
// message the schema already writes (`<file>: tasks.<name>.<path> …`),
// so it works for a refusal made in the config worker as for one made
// here, and a message it cannot place prints as it always did.

import { readFileSync } from 'node:fs'
import path from 'node:path'

// `<file>: tasks.<path>[:] …`, `<file>: \`<setting>\` …`, `<file>: task name "<name>" …`,
// or a top-level `<file> has unknown field …`, from a project's vx.config
// or the workspace's .vx/workspace.ts.
const HEAD =
  /^(\/[^\n]*?\/(?:vx\.config|\.vx\/workspace)\.[cm]?[jt]s)(?:: (?:(tasks\.[^\s:]+)(:?)|`([^`\n]+)`|task name ("(?:[^"\\\n]|\\.)*")))? /

/**
 * The message with its file named at `line:col`, relative to `cwd`, and a
 * frame of the source under it; undefined when the message names no
 * config field or the field is not found in the file.
 */
export function configErrorFrame(message: string, cwd: string): string | undefined {
  const head = HEAD.exec(message)
  if (head === null) return positionFrame(message, cwd)
  const [, file, tasksPath, colon, setting, taskName] = head as unknown as [
    string,
    string,
    string?,
    string?,
    string?,
    string?,
  ]
  const rest = message.slice(head[0].length)
  // The field the refusal is about, past the path that leads to it:
  // `has unknown field "comand"`, or `tasks.build: \`cache\` is not allowed`.
  const named =
    colon === ':' ? /^`([^`]+)`/.exec(rest) : /^has (?:unknown )?field "([^"]+)"/.exec(rest)
  // `plugins[2].name`: an element of an array, framed at the element (a
  // plugin is a call, so no key inside it is searched).
  const element = setting === undefined ? null : /^([^[]+)\[(\d+)\]/.exec(setting)
  const fieldPath =
    taskName !== undefined
      ? ['tasks', JSON.parse(taskName)]
      : element !== null
        ? element[1]!.split('.')
        : (tasksPath ?? setting)?.split('.')
  const segments = [
    ...(fieldPath ?? []),
    ...(named === null || element !== null ? [] : [named[1]!]),
  ]
  if (segments.length === 0) return undefined
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const at = locate(source, segments, element === null ? undefined : Number(element[2]))
  if (at === undefined) return undefined
  return framed(file, source, at, message.slice(file.length), cwd)
}

// The loader's `Project config <file>:<line>:<col>: …`: a syntax error,
// placed by Bun, in the config itself.
const POSITION =
  /^(?:Project|Workspace) config (\/[^\n]*?\/(?:vx\.config|\.vx\/workspace)\.[cm]?[jt]s):(\d+):(\d+)(: [^]*)$/

// The loader's `Project config <file> threw: <message> (at <file>:<line>:<col>)`:
// the config's own throw, placed by its stack in the config itself.
const THREW =
  /^(?:Project|Workspace) config (\/[^\n]*?\/(?:vx\.config|\.vx\/workspace)\.[cm]?[jt]s) threw: ([^\n]*?) \(at (\/[^\n]*?):(\d+):(\d+)\)([^]*)$/

// The loader's `<kind> config <file>: cannot find '<pkg>' …`: placed at the
// specifier. And `<kind> config at <file> did not export a default object`:
// at the `export default` that exported something else, when there is one.
const UNPROVIDED =
  /^(?:Project|Workspace) config (\/[^\n]*?\/(?:vx\.config|\.vx\/workspace)\.[cm]?[jt]s): (cannot find '([^'\n]+)'[^]*)$/
const NOT_OBJECT =
  /^(?:Project|Workspace) config at (\/[^\n]*?\/(?:vx\.config|\.vx\/workspace)\.[cm]?[jt]s) (did not export a default object[^]*)$/

/** The file, the source offset `find` places in it, and what follows `<file>:<line>:<col>`. */
function sourceFrame(
  file: string,
  find: (source: string) => number,
  rest: string,
  cwd: string,
): string | undefined {
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const at = find(source)
  if (at < 0) return undefined
  const before = source.slice(0, at)
  const line = before.split('\n').length
  return framed(file, source, { line, col: at - before.lastIndexOf('\n') }, rest, cwd)
}

function positionFrame(message: string, cwd: string): string | undefined {
  const unprovided = UNPROVIDED.exec(message)
  if (unprovided !== null) {
    const [, file, said, pkg] = unprovided as unknown as [string, string, string, string]
    const spec = new RegExp(`(?<=\\b(?:from|import|import\\(|require\\()\\s*)(['"])${escapeRe(pkg)}\\1`)
    return sourceFrame(file, (src) => spec.exec(src)?.index ?? -1, `: ${said}`, cwd)
  }
  const notObject = NOT_OBJECT.exec(message)
  if (notObject !== null) {
    const [, file, said] = notObject as unknown as [string, string, string]
    return sourceFrame(
      file,
      (src) => /^export\s+default\b/m.exec(src)?.index ?? -1,
      `: ${said}`,
      cwd,
    )
  }
  const threw = THREW.exec(message)
  const pos =
    threw !== null && threw[3] === threw[1]
      ? [
          threw[0],
          threw[1],
          threw[4],
          threw[5],
          // A cause's own `(at …)` names the same file: relative there too.
          `: threw: ${threw[2]}${threw[6]!.replaceAll(threw[1]!, path.relative(cwd, threw[1]!))}`,
        ]
      : POSITION.exec(message)
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
  /** The element of the array the last segment holds; past its end, the key. */
  index?: number,
): { line: number; col: number } | undefined {
  let pos = 0
  let end = source.length
  let found = -1
  let i = 0
  while (i < segments.length) {
    let next = -1
    for (let j = segments.length; j > i && next < 0; j--) {
      const name = segments.slice(i, j).join('.')
      // An empty key is quoted, or every `:` matched; a control character
      // is in the source as its escape (`'\u001b'`).
      const spelled = JSON.stringify(name).slice(1, -1)
      const names = spelled === name ? escapeRe(name) : `${escapeRe(name)}|${escapeRe(spelled)}`
      const re = new RegExp(
        `(?<![\\w$.])(['"\`]${name === '' ? '' : '?'})(?:${names})\\1\\s*:`,
        'g',
      )
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
  if (index !== undefined && i === segments.length) {
    const el = elementStart(source, pos, index)
    if (el !== undefined) found = el
  }
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

/** Where element `index` of the array literal at `from` (past blanks) starts, if it has one. */
function elementStart(source: string, from: number, index: number): number | undefined {
  let i = from
  while (i < source.length && /\s/.test(source[i]!)) i++
  if (source[i] !== '[') return undefined
  let depth = 0
  let n = 0
  // Each element starts at the first code past `[` or a top-level `,`.
  let pending = true
  for (i++; i < source.length; i++) {
    const c = source[i]!
    if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i)
      if (i < 0) return undefined
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2)
      if (i < 0) return undefined
      i++
      continue
    }
    if (/\s/.test(c)) continue
    if (depth === 0 && (c === ']' || c === ')' || c === '}')) return undefined
    if (pending) {
      if (n === index) return i
      pending = false
    }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === '\\') i++
    } else if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') depth--
    else if (c === ',' && depth === 0) {
      n++
      pending = true
    }
  }
  return undefined
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
