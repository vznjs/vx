// A config refusal pointed at its line: `vx.config.ts:7:9` (which a
// terminal opens on click) and the source around it. Read from the
// message the schema already writes (`<file>: tasks.<name>.<path> …`),
// so it works for a refusal made in the config worker as for one made
// here, and a message it cannot place prints as it always did.

import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

// `<file>: tasks.<path>[:] …`, `<file>: \`<setting>\` …`, `<file>: task name "<name>" …`,
// or a top-level `<file> has unknown field …`, from a project's vx.config
// or the workspace's .vx/workspace.ts.
const HEAD =
  /^(\/[^\n]*?\/(?:vx\.config|\.vx\/workspace)\.[cm]?[jt]s)(?:: (?:(tasks\.[^\s:]+)(:?)|`([^`\n]+)`|task name ("(?:[^"\\\n]|\\.)*")))? /

/**
 * A quoted name as the source spells it. A glob refusal quotes the glob
 * raw, so `"app/\\[id\\]"` is no JSON string: parsed alone, vx lock crashed
 * on it in place of the refusal.
 */
function unquote(quoted: string): string {
  try {
    return JSON.parse(quoted) as string
  } catch {
    return quoted.slice(1, -1)
  }
}

/**
 * The message with its file named at `line:col`, relative to `cwd`, and a
 * frame of the source under it; undefined when the message names no
 * config field or the field is not found in the file.
 */
export function configErrorFrame(message: string, cwd: string): string | undefined {
  const p = framedParts(message, cwd)
  return p === undefined ? undefined : `${p.line}\n\n${p.frame}`
}

/** A frame in parts: its `<file>:<line>:<col> …` line, the source under it, and the config it reached. */
interface Framed {
  line: string
  frame: string
  /** The config that read the field, when the field is set in a file it imports. */
  via?: string
}

function framedParts(message: string, cwd: string): Framed | undefined {
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
  // A refused key is quoted: `tasks.b.exec.env.define: "A=B" is not …`.
  const said =
    colon === ':'
      ? /^(?:`([^`]+)`|("(?:[^"\\\n]|\\.)*"))/.exec(rest)
      : /^has (?:unknown )?field "([^"]+)"/.exec(rest)
  const named = said === null ? null : [said[0], said[1] ?? unquote(said[2]!)]
  // `plugins[2].name`: an element of an array, framed at the element (a
  // plugin is a call, so no key inside it is searched).
  const element = setting === undefined ? null : /^([^[]+)\[(\d+)\]/.exec(setting)
  const fieldPath =
    taskName !== undefined
      ? ['tasks', unquote(taskName)]
      : element !== null
        ? element[1]!.split('.')
        : (tasksPath ?? setting)?.split('.')
  const segments = [
    ...(fieldPath ?? []),
    ...(named === null || element !== null ? [] : [named[1]!]),
  ]
  if (segments.length === 0) return undefined
  const source = readOr(file)
  if (source === undefined) return undefined
  const hit = place(
    file,
    source,
    segments,
    0,
    source.length,
    element === null ? undefined : Number(element[2]),
    0,
  )
  if (hit === undefined) return undefined
  const out = framed(hit.file, hit.source, hit.at, message.slice(file.length), cwd)
  return hit.file === file ? out : { ...out, via: shownPath(file, cwd) }
}

function readOr(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Where a field is set: in `file`, or in the file one of its values is imported from. */
interface Hit {
  file: string
  source: string
  at: { line: number; col: number }
  exact: boolean
}

/** Bindings followed from a config into what it imports: a preset of a preset, and no further. */
const FOLLOW_DEPTH = 4

/**
 * Where the last of `segments` is set in `source[start, stop)`. A value
 * the walk cannot see into (`test: testTask`, `...lib()`) is followed to
 * where that name is declared, here or in the file it is imported from:
 * a typo in a shared preset was framed at the config's `test: testTask`,
 * or not at all, and the file that held it never named.
 */
function place(
  file: string,
  source: string,
  segments: readonly string[],
  start: number,
  stop: number,
  index: number | undefined,
  depth: number,
  /** Where the followed name is declared: the place of a field it leaves out. */
  anchor?: number,
): Hit | undefined {
  const w = walk(source, segments, start, stop, index)
  if (w.i === segments.length) return hitAt(file, source, w.found, true)
  if (depth < FOLLOW_DEPTH) {
    // Where the object that lacks the key is written: the value the walk
    // stopped at, the followed declaration's, or the config's default export.
    const from =
      w.i > 0 ? w.pos : depth === 0 ? (/\bexport\s+default\s+/.exec(source)?.index ?? -1) : start
    const head = from < 0 ? null : /^(?:export\s+default\s+|[\s=(])*/.exec(source.slice(from))
    const at = from + (head?.[0].length ?? 0)
    const to = w.i > 0 ? w.end : /[{[]/.test(source[at] ?? '') ? literalEnd(source, at) : stop
    // A name holds the rest (`test: testTask`, `export default base()`); a
    // spread in the object that lacks the key may hold it whole.
    const value = from < 0 ? null : /^[A-Za-z_$][\w$]*/.exec(source.slice(at, at + 200))
    const names =
      value !== null
        ? [value[0]]
        : from < 0
          ? []
          : [...topLevel(source, at, to).matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!)
    for (const name of names) {
      const decl = declared(file, source, name)
      if (decl === undefined) continue
      const hit = place(
        decl.file,
        decl.source,
        segments.slice(w.i),
        decl.start,
        decl.stop,
        index,
        depth + 1,
        decl.at,
      )
      // A name, not a call: the object it holds is the one that lacks the key.
      const held = value !== null && !/^\s*\(/.test(source.slice(at + value[0].length))
      if (hit !== undefined && (hit.exact || held)) return hit
    }
  }
  // The last segment is a field the object leaves out: framed at its parent.
  if (w.i === segments.length - 1) {
    if (w.found >= 0) return hitAt(file, source, w.found, false)
    if (anchor !== undefined) return hitAt(file, source, anchor, false)
  }
  return undefined
}

function hitAt(file: string, source: string, found: number, exact: boolean): Hit {
  const before = source.slice(0, found)
  const line = before.split('\n').length
  return { file, source, at: { line, col: found - before.lastIndexOf('\n') }, exact }
}

/** `source[from, to]` with every nested literal blanked: what its own level says. */
function topLevel(source: string, from: number, to: number): string {
  let i = from
  if (source[i] === '{' || source[i] === '[') i++
  let out = ''
  for (; i < to; i++) {
    const c = source[i]!
    if (c === '{' || c === '[' || c === '(') {
      const end = literalEnd(source, i)
      i = end > i ? end : bracketEnd(source, i)
      out += ' '
    } else out += c
  }
  return out
}

/** Where the `(` at `from` closes. */
function bracketEnd(source: string, from: number): number {
  let depth = 0
  for (let i = from; i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')' && --depth === 0) return i
  }
  return source.length
}

/** Where `name` is declared: in `file`, or in the file it imports it from, past re-exports. */
function declared(
  file: string,
  source: string,
  name: string,
  hops = 0,
): { file: string; source: string; start: number; stop: number; at: number } | undefined {
  const local = new RegExp(
    `(?:\\b(?:const|let|var|class)\\s+|\\bfunction\\s*\\*?\\s*)${escapeRe(name)}\\b`,
  ).exec(source)
  if (local !== null) {
    const start = local.index + local[0].length
    // The value: the object a `const` holds, or the body a function returns
    // from, opened on the declaration's own statement: past it is the next.
    const line = /^[^\n]*(?:\n[ \t)}\]][^\n]*)*/.exec(source.slice(start))![0]
    const open = line.search(/[{[]/)
    const stop = open < 0 ? start : literalEnd(source, start + open)
    return { file, source, start, stop, at: start - name.length }
  }
  if (name === 'default') {
    const def = /\bexport\s+default\s+/.exec(source)
    if (def === null) return undefined
    const start = def.index + def[0].length
    return { file, source, start, stop: source.length, at: def.index }
  }
  if (hops > FOLLOW_DEPTH) return undefined
  for (const im of importsOf(source)) {
    if (im.local !== name && !(im.local === '*' && hops > 0)) continue
    const target = resolved(im.spec, file)
    const text = target === undefined ? undefined : readOr(target)
    if (text === undefined) continue
    const found = declared(target!, text, im.imported === '*' ? name : im.imported, hops + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/** One name an `import` / `export … from` statement binds: what it is called here and there. */
interface ImportedName {
  local: string
  imported: string
  spec: string
  /** Where the name is written in the statement. */
  at: number
}

const IMPORT = /\b(import|export)\s+(?:type\s+)?([\w$\s,{}*]*?)\s*from\s*(['"])([^'"\n]+)\3/g

function importsOf(source: string): ImportedName[] {
  const out: ImportedName[] = []
  for (const m of source.matchAll(IMPORT)) {
    const clause = m[2]!
    const base = m.index + m[0].indexOf(clause, m[1]!.length)
    const spec = m[4]!
    if (m[1] === 'export' && /^\*$/.test(clause.trim())) {
      out.push({ local: '*', imported: '*', spec, at: base })
      continue
    }
    const braces = clause.indexOf('{')
    const head = braces < 0 ? clause : clause.slice(0, braces)
    const def = /^\s*([A-Za-z_$][\w$]*)/.exec(head)
    if (def !== null && m[1] === 'import')
      out.push({ local: def[1]!, imported: 'default', spec, at: base + def.index })
    if (braces < 0) continue
    const list = clause.slice(braces + 1, clause.indexOf('}', braces))
    for (const n of list.matchAll(/(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?/g))
      out.push({
        local: n[2] ?? n[1]!,
        imported: n[1]!,
        spec,
        at: base + braces + 1 + n.index + n[0].indexOf(n[1]!),
      })
  }
  return out
}

/** The file `spec` names from `file`, unless it is an installed package: that is no file to edit. */
function resolved(spec: string, file: string): string | undefined {
  try {
    const target = realpathSync(Bun.resolveSync(spec, path.dirname(file)))
    return target.includes(`${path.sep}node_modules${path.sep}`) ? undefined : target
  } catch {
    return undefined
  }
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

// The loader's `<kind> config <file>: an import names an export its module
// lacks: Export named '<name>' not found in module '<module>'`: placed at
// the import that names it, in the config or a file it imports.
const MISSING_EXPORT =
  /^(?:Project|Workspace) config (\/[^\n]*?\/(?:vx\.config|\.vx\/workspace)\.[cm]?[jt]s): (an import names an export its module lacks: Export named '([^'\n]+)' not found in module '([^'\n]+)'[^]*)$/

/** The file, the source offset `find` places in it, and what follows `<file>:<line>:<col>`. */
function sourceFrame(
  file: string,
  find: (source: string) => number,
  rest: string,
  cwd: string,
): Framed | undefined {
  const source = readOr(file)
  if (source === undefined) return undefined
  const at = find(source)
  if (at < 0) return undefined
  return framed(file, source, hitAt(file, source, at, true).at, rest, cwd)
}

/** The import of `name` from `module`: in `config`, or in a file it imports. */
function importOf(
  config: string,
  name: string,
  module: string,
): { file: string; at: number } | undefined {
  const want = realpathOr(module)
  const seen = new Set<string>()
  let level = [config]
  for (let hops = 0; hops <= FOLLOW_DEPTH && level.length > 0; hops++) {
    const next: string[] = []
    for (const file of level) {
      if (seen.has(file)) continue
      seen.add(file)
      const source = readOr(file)
      if (source === undefined) continue
      for (const im of importsOf(source)) {
        const target = resolved(im.spec, file)
        if (target === undefined) continue
        if (im.imported === name && target === want) return { file, at: im.at }
        next.push(target)
      }
    }
    level = next
  }
  return undefined
}

function realpathOr(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

function positionFrame(message: string, cwd: string): Framed | undefined {
  const unprovided = UNPROVIDED.exec(message)
  if (unprovided !== null) {
    const [, file, said, pkg] = unprovided as unknown as [string, string, string, string]
    const spec = new RegExp(
      `(?<=\\b(?:from|import|import\\(|require\\()\\s*)(['"])${escapeRe(pkg)}\\1`,
    )
    return sourceFrame(file, (src) => spec.exec(src)?.index ?? -1, `: ${said}`, cwd)
  }
  const missing = MISSING_EXPORT.exec(message)
  if (missing !== null) {
    const [, file, said, name, module] = missing as unknown as [
      string,
      string,
      string,
      string,
      string,
    ]
    const where = importOf(file, name, module)
    if (where === undefined) return undefined
    const rest = `: ${said.replaceAll(module, shownPath(module, cwd))}`
    const out = sourceFrame(where.file, () => where.at, rest, cwd)
    return out === undefined || where.file === file ? out : { ...out, via: shownPath(file, cwd) }
  }
  const notObject = NOT_OBJECT.exec(message)
  if (notObject !== null) {
    const [, file, said] = notObject as unknown as [string, string, string]
    return sourceFrame(
      file,
      // No default: at the named export written instead, when there is one.
      (src) => (/^export\s+default\b/m.exec(src) ?? /^export\b/m.exec(src))?.index ?? -1,
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
  const source = readOr(file)
  if (source === undefined) return undefined
  const at = { line: Number(line), col: Math.max(1, Number(col)) }
  if (at.line < 1 || at.line > source.split('\n').length) return undefined
  return framed(file, source, at, rest, cwd)
}

/** `file` relative to `cwd`, unless that means climbing out. */
function shownPath(file: string, cwd: string): string {
  const rel = path.relative(cwd, file)
  return rel === '' || rel.startsWith('..') ? file : rel
}

/** `<file>:<line>:<col><rest>` relative to `cwd`, over the source lines up to `at`. */
function framed(
  file: string,
  source: string,
  at: { line: number; col: number },
  rest: string,
  cwd: string,
): Framed {
  const lines = source.split('\n')
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
  return { line: `${shownPath(file, cwd)}:${at.line}:${at.col}${rest}`, frame: frame.join('\n') }
}

/**
 * How far `segments` lead in `source[start, stop)`, each searched as a key
 * inside the object literal the one before holds. A task name holds dots
 * (`lint.oxfmt`), so the longest run of segments that names a key wins.
 * `i` segments were found, the last at `found`, its value at `pos` and its
 * literal ending at `end` (`pos` when the value is no literal). A last
 * segment the object leaves out (`outputs is required`) stops at its
 * parent: searched past it, the next task's `outputs` was framed.
 */
function walk(
  source: string,
  segments: readonly string[],
  start: number,
  stop: number,
  /** The element of the array the last segment holds; past its end, the key. */
  index?: number,
): { i: number; found: number; pos: number; end: number } {
  let pos = start
  let end = stop
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
    if (next < 0) break
    i = next
  }
  if (index !== undefined && i === segments.length) {
    const el = elementStart(source, pos, index)
    if (el !== undefined) found = el
  }
  return { i, found, pos, end }
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
  /** The config that read the field, when `where` is a file it imports. */
  via?: string
  /** Empty when the field is not found in the source. */
  frame: string
}

/**
 * `configErrorFrame`'s answer in parts; a config field it cannot place
 * keeps its file, relative, and its fix, with no frame. Undefined when the
 * message names no config.
 */
export function configRefusal(message: string, cwd: string): ConfigRefusal | undefined {
  const p = framedParts(message, cwd)
  let where: string
  let said: string
  if (p === undefined) {
    const head = HEAD.exec(message)
    // Only a refusal of a field: `<file> (after plugin 'p'): …` says its own.
    if (head === null || (head[2] ?? head[4] ?? head[5]) === undefined) return undefined
    where = shownPath(head[1]!, cwd)
    said = message.slice(head[1]!.length).replace(/^:? /, '')
  } else {
    // A path may hold spaces (`packages/my app/`); the first `:line:col` ends it.
    const at = /^([^\n]+?:\d+:\d+):? (.*)$/s.exec(p.line)
    if (at === null) return { where: p.line, problem: '', frame: p.frame }
    where = at[1]!
    said = at[2]!
  }
  // After ` — `: the field meant, how vx spells another runner's field, or what to remove.
  const parts =
    /^(.*?)(?: \(allowed: ([^)]*)\))?(?: — (?:did you mean ([^?]+)\?|vx spells it (.+)|(remove .+)))?$/s.exec(
      said,
    )!
  return {
    where,
    problem: parts[1]!.replace(/^has /, ''),
    ...(parts[2] !== undefined ? { allowed: parts[2] } : {}),
    ...(parts[3] !== undefined ? { fix: `use ${parts[3]}` } : {}),
    ...(parts[4] !== undefined ? { fix: `use ${parts[4]}` } : {}),
    ...(parts[5] !== undefined ? { fix: parts[5] } : {}),
    ...(p?.via !== undefined ? { via: p.via } : {}),
    frame: p?.frame ?? '',
  }
}
