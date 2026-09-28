// The declared shape of a module's exports, read from the source: each
// exported type with every type it names (followed through imports and
// re-exports), each exported function's signature, each exported class's
// public members, and each exported constant's runtime value. Comments and
// blank lines are dropped, so only a change a caller can see shows up.
// `tests/contract-package-api.test.ts` holds the façade to a record of it.

import { readFileSync } from 'node:fs'
import path from 'node:path'

/** `src` with comments removed and strings kept; newlines survive. */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  // Each open template literal's `${` depth, innermost last.
  const templates: number[] = []
  let braces = 0
  while (i < src.length) {
    const c = src[i]!
    const n = src[i + 1]
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      out += src.slice(i, stop).replace(/[^\n]/g, '')
      i = stop
      continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      out += src.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === '`' || (c === '}' && templates.at(-1) === braces)) {
      if (c === '}') templates.pop()
      let j = i + 1
      while (j < src.length && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) {
        j += src[j] === '\\' ? 2 : 1
      }
      if (src[j] === '$') {
        templates.push(braces)
        out += src.slice(i, j + 2)
        i = j + 2
      } else {
        out += src.slice(i, j + 1)
        i = j + 1
      }
      continue
    }
    if (c === '{') braces++
    if (c === '}') braces--
    out += c
    i++
  }
  return out
}

/** Bracket depth change over a comment-free line, strings skipped. */
function depthDelta(line: string): number {
  let d = 0
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1
      i = j
    } else if ('({['.includes(c)) d++
    else if (')}]'.includes(c)) d--
  }
  return d
}

interface Module {
  file: string
  lines: string[]
}

const modules = new Map<string, Module>()

function load(file: string): Module {
  let m = modules.get(file)
  if (m === undefined) {
    const lines = stripComments(readFileSync(file, 'utf8'))
      .split('\n')
      .map((l) => l.trimEnd())
    m = { file, lines }
    modules.set(file, m)
  }
  return m
}

/**
 * The statement starting at line `start`. A block that opens on its first
 * line ends at the brace back at its own indent (the formatter's layout, so
 * a regex literal in a class body cannot miscount it); anything else ends
 * where bracket depth returns to 0.
 */
function statement(lines: readonly string[], start: number): string[] {
  const first = lines[start]!
  if (first.endsWith('{')) {
    const close = /^\s*/.exec(first)![0] + '}'
    const end = lines.findIndex((l, i) => i > start && l.startsWith(close))
    return lines.slice(start, end + 1).filter((l) => l !== '')
  }
  const out: string[] = []
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!
    if (line === '') continue
    out.push(line)
    depth += depthDelta(line)
    const next = lines.slice(i + 1).find((l) => l !== '')
    if (depth <= 0 && (next === undefined || !/^[\s|&=?:.]/.test(next))) break
  }
  return out
}

interface Signature {
  lines: string[]
  /** Source lines it spans, from its first. */
  consumed: number
  /** Whether it ended at a body's `{`, which `lines` leaves out. */
  opensBody: boolean
}

/** A function's or member's signature: its lines up to the body's `{`. */
function signature(lines: readonly string[], start: number): Signature {
  const out: string[] = []
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!
    if (line === '') continue
    depth += depthDelta(line)
    const consumed = i - start + 1
    if (depth === 1 && line.endsWith('{')) {
      const cut = line.slice(0, -1).trimEnd()
      if (cut.trim() !== '') out.push(cut)
      return { lines: out, consumed, opensBody: true }
    }
    out.push(line)
    if (depth <= 0 && !/[,(]$/.test(line)) return { lines: out, consumed, opensBody: false }
  }
  return { lines: out, consumed: lines.length - start, opensBody: false }
}

/** A class's header and public members, each method cut at its body. */
function classSurface(lines: readonly string[], start: number): string[] {
  const body = statement(lines, start)
  const out = [body[0]!]
  const close = ' '.repeat(/^\s*/.exec(body[0]!)![0].length + 2) + '}'
  let i = 1
  while (i < body.length - 1) {
    const sig = signature(body, i)
    if (!/^\s*(private |protected |#)/.test(body[i]!)) {
      // A field's initializer is its implementation; its type is the surface.
      const field = /^(\s*(?:(?:readonly|static|public|declare) )*[\w$]+[?!]?(?::[^=]+)?) = /
      out.push(...sig.lines.map((l) => (sig.opensBody ? l : (field.exec(l)?.[1] ?? l))))
    }
    i += sig.consumed
    if (sig.opensBody) {
      while (i < body.length - 1 && body[i] !== close) i++
      i++
    }
  }
  out.push(body.at(-1)!)
  return out
}

type Kind = 'type' | 'function' | 'class' | 'const'

interface Declaration {
  name: string
  kind: Kind
  file: string
  text: string[]
  /** The declaration's line in its file, 0-based. */
  line: number
}

const DECL =
  /^(?:export )?(?:declare )?(?:(?:abstract )?(class)|(interface|type|enum)|(?:async )?(function)|(const|let)) ([A-Za-z_$][\w$]*)\b/

function declarationIn(m: Module, name: string): Declaration | undefined {
  for (const [i, line] of m.lines.entries()) {
    const d = DECL.exec(line)
    if (d === null || d[5] !== name) continue
    const kind: Kind = d[1] ? 'class' : d[2] ? 'type' : d[3] ? 'function' : 'const'
    const text =
      kind === 'class'
        ? classSurface(m.lines, i)
        : kind === 'function'
          ? signature(m.lines, i).lines
          : statement(m.lines, i)
    // An overloaded function declares each signature on its own line.
    if (kind === 'function') {
      for (let j = i + text.length; j < m.lines.length; j++) {
        const again = DECL.exec(m.lines[j]!)
        if (again?.[5] !== name) continue
        text.push(...signature(m.lines, j).lines)
      }
    }
    return { name, kind, file: m.file, text, line: i }
  }
  return undefined
}

function resolveSpecifier(from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined
  return path.resolve(path.dirname(from), spec.replace(/\.js$/, '.ts'))
}

/** The clauses `import {…} from` / `export {…} from` bind in `m`: local name → [original, module]. */
function bindings(m: Module): Map<string, [string, string]> {
  const out = new Map<string, [string, string]>()
  const text = m.lines.join('\n')
  for (const b of text.matchAll(/^(?:import|export) (?:type )?\{([^}]*)\} from '([^']+)'/gm)) {
    const target = resolveSpecifier(m.file, b[2]!)
    if (target === undefined) continue
    for (const raw of b[1]!.split(',')) {
      const spec = raw.trim().replace(/^type /, '')
      if (spec === '') continue
      const [orig, local = orig] = spec.split(/ as /).map((s) => s.trim())
      out.set(local!, [orig!, target])
    }
  }
  return out
}

function starExports(m: Module): string[] {
  const text = m.lines.join('\n')
  return [...text.matchAll(/^export \* from '([^']+)'/gm)].flatMap((s) => {
    const t = resolveSpecifier(m.file, s[1]!)
    return t === undefined ? [] : [t]
  })
}

/** Where `name`, as seen from `file`, is declared; undefined for a global or a package type. */
function resolve(file: string, name: string, seen = new Set<string>()): Declaration | undefined {
  const key = `${file}\0${name}`
  if (seen.has(key)) return undefined
  seen.add(key)
  const m = load(file)
  const own = declarationIn(m, name)
  if (own !== undefined) return own
  const bound = bindings(m).get(name)
  if (bound !== undefined) return resolve(bound[1], bound[0], seen)
  for (const t of starExports(m)) {
    const d = resolve(t, name, seen)
    if (d !== undefined) return d
  }
  return undefined
}

/**
 * The surface `entry` exports: every declaration it re-exports, and every
 * type those name, transitively. Keyed `kind name (file)`, sorted.
 */
export function surfaceOf(entry: string, root: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const queue: Array<[string, Declaration]> = []
  const exported = [...bindings(load(entry)).keys()].filter((local) =>
    new RegExp(`^export (?:type )?\\{[^}]*\\b${local}\\b[^}]*\\} from`, 'm').test(
      load(entry).lines.join('\n'),
    ),
  )
  for (const name of exported) {
    const d = resolve(entry, name)
    if (d === undefined) throw new Error(`${name}: exported from ${entry} but declared nowhere`)
    queue.push([name, d])
  }
  const done = new Set<string>()
  while (queue.length > 0) {
    const [, d] = queue.shift()!
    const id = `${d.file}\0${d.name}`
    if (done.has(id)) continue
    done.add(id)
    out.set(`${d.kind} ${d.name} (${path.relative(root, d.file)})`, d.text)
    // A function or const is held by its signature or value; the types it
    // names are held where they are declared, so follow them too — but not
    // into a function's body, which the signature already cut away.
    for (const [ident] of d.text.join('\n').matchAll(/\b[A-Z][\w$]*\b/g)) {
      if (ident === d.name) continue
      const ref = resolve(d.file, ident)
      if (ref !== undefined && (ref.kind === 'type' || ref.kind === 'class'))
        queue.push([ident, ref])
    }
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)))
}

/** The doc-comment block right above line `line` of `file`, as plain text; '' when none. */
function docAbove(file: string, line: number): string {
  const lines = readFileSync(file, 'utf8').split('\n')
  let end = line - 1
  while (end >= 0 && lines[end]!.trim() === '') end--
  if (end < 0 || !lines[end]!.trim().endsWith('*/')) return ''
  let start = end
  while (start >= 0 && !lines[start]!.trim().startsWith('/**')) start--
  if (start < 0) return ''
  return lines
    .slice(start, end + 1)
    .map((l) => l.trim().replace(/^\/\*\*\s?|\s?\*\/$|^\*\s?/g, ''))
    .join('\n')
    .trim()
}

/** One export `entry` names: where it is declared, its recorded text and its doc comment. */
export interface ExportEntry {
  name: string
  kind: Kind
  file: string
  text: string[]
  doc: string
}

/** Every name `entry` exports (not the types they name), sorted by name. */
export function exportsOf(entry: string, root: string): ExportEntry[] {
  const out: ExportEntry[] = []
  const m = load(entry)
  const text = m.lines.join('\n')
  for (const name of bindings(m).keys()) {
    if (!new RegExp(`^export (?:type )?\\{[^}]*\\b${name}\\b[^}]*\\} from`, 'm').test(text))
      continue
    const d = resolve(entry, name)
    if (d === undefined) throw new Error(`${name}: exported from ${entry} but declared nowhere`)
    out.push({
      name,
      kind: d.kind,
      file: path.relative(root, d.file),
      text: d.text,
      doc: docAbove(d.file, d.line),
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
