// M 2026-11-23 18:46 UTC: "Every field from all config should be
// documented and explained". Every field the validator accepts
// (tests/contract/config-schema.json) has its own entry in docs/schema.md,
// the config reference the site imports: a heading that names it, or a
// table row that names it and says something about it. A heading's path is
// its ancestors' joined, so `#### \`timeout\`` under `### \`exec\`` is
// `exec.timeout`.
//
// NOT_YET is the day's to-do (docs redo, 2026-11-24): it may only shrink.
// A field listed here that gains an entry fails too, so the list stays true.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const DOC = readFileSync(path.join(import.meta.dir, '..', 'docs', 'schema.md'), 'utf8')
const RECORD = JSON.parse(
  readFileSync(path.join(import.meta.dir, 'contract', 'config-schema.json'), 'utf8'),
) as Record<'workspace' | 'project', { levels: Record<string, string[]> }>

const NOT_YET = new Set<string>([])

const join = (base: string, name: string): string =>
  !base || name.startsWith(`${base}.`) ? name : `${base}.${name}`

/** Every field path the reference gives an entry. */
function entries(doc: string): Set<string> {
  const found = new Set<string>()
  let stack: Array<[depth: number, path: string]> = []
  let fence = false
  for (const line of doc.split('\n')) {
    if (line.startsWith('```')) fence = !fence
    if (fence || line.startsWith('```')) continue
    const h = /^(#+) (.*)/.exec(line)
    if (h) {
      const depth = h[1]!.length
      const name = /`([\w.*]+)`/.exec(h[2]!)?.[1]
      stack = stack.filter(([d]) => d < depth)
      const base = stack.at(-1)?.[1] ?? ''
      const p = name === undefined ? base : join(base, name)
      stack.push([depth, p])
      found.add(p)
      continue
    }
    const row = /^\|\s*`([\w.]+)`[^|]*\|\s*[^|\s-]/.exec(line)
    if (row) {
      found.add(join(stack.at(-1)?.[1] ?? '', row[1]!))
      found.add(row[1]!)
    }
  }
  return found
}

function fields(): string[] {
  const out: string[] = []
  for (const [config, { levels }] of Object.entries(RECORD))
    for (const [level, names] of Object.entries(levels)) {
      const prefix = level.replace(/^tasks\.\*\.?/, '')
      for (const f of names) out.push(`${config}:${prefix ? `${prefix}.${f}` : f}`)
    }
  return out
}

const explained = (field: string, found: Set<string>): boolean => {
  const p = field.slice(field.indexOf(':') + 1)
  return [...found].some((x) => x === p || x.endsWith(`.${p}`))
}

it('gives every config field an entry in the config reference', () => {
  const found = entries(DOC)
  const missing = fields().filter((f) => !explained(f, found) && !NOT_YET.has(f))
  expect(missing).toEqual([])
})

it('lists in NOT_YET only fields still without an entry', () => {
  const found = entries(DOC)
  const done = [...NOT_YET].filter((f) => explained(f, found) || !fields().includes(f))
  expect(done).toEqual([])
})

// M 2026-11-24: every field also gives its type, its default and an
// example. A heading entry gives its type in a `ts` fence that declares
// it (its own, or its parent's interface), its default in its own text
// (`Default`, `(required)`, `Omitted`, `Left out`), and an example: a
// fence that is not only declarations, or a `Write | Means` table. A row
// gives them in a type column (`Type`, `Takes`, `Value`), a default column
// (`Default`, `Left out`) and an example: an `Example` cell, a literal in a
// `Takes` or `Value` cell, or code in a cell that describes the field.

const TYPE_COLUMNS = ['type', 'takes', 'value']
const DEFAULT_COLUMNS = ['default', 'left out']

/** A row's cells as a field entry: whether they give a type, a default and an example. */
function completeRow(header: readonly string[], cells: readonly string[]): boolean {
  const col = (names: readonly string[]): number =>
    header.findIndex((h) => names.includes(h.toLowerCase()))
  const type = col(TYPE_COLUMNS)
  const def = col(DEFAULT_COLUMNS)
  if (type === -1 || def === -1 || !cells[type] || !cells[def]) return false
  const example = col(['example'])
  if (example !== -1) return Boolean(cells[example])
  // A `Type` cell names a type, and a `Variable` or `Flag` cell another way
  // to set it, not a value; a `Takes` or `Value` cell shows one when it
  // quotes a literal (`'50%'`, `2`, `true`).
  const kinds = header.map((h) => h.toLowerCase())
  return cells.some((c, i) => {
    if (i === 0 || i === def || ['type', 'variable', 'flag'].includes(kinds[i]!)) return false
    if (i === type) return /[`'"]|\d|\btrue\b/.test(c)
    return /`[^`]+`/.test(c)
  })
}

const declares = (fence: string, leaf: string): boolean =>
  new RegExp(`^\\s*(?:readonly )?['"]?${leaf.replace(/[*]/g, '\\*')}['"]?\\??: `, 'm').test(fence)

/** A fence that shows a value, not only declarations and comments. */
const shows = (fence: string): boolean =>
  fence
    .split('\n')
    .map((l) => l.trim())
    .some(
      (l) =>
        l !== '' &&
        !/^(?:\/\/|\/\*\*?|\*)/.test(l) &&
        !/^(?:export )?(?:interface|type) /.test(l) &&
        !/^[{}]$/.test(l) &&
        !isDeclaration(l),
    )

/** `name?: string` declares; `name: '10s'` or `name: 2` shows a value. */
function isDeclaration(line: string): boolean {
  const m = /^(?:readonly )?['"\w<>.*]+(\?)?: (.*)$/.exec(line)
  if (m === null) return false
  if (m[1] === '?') return true
  const value = m[2]!.replace(/\s*\/\/.*$/, '').replace(/,$/, '')
  return value.includes(' | ') || !/^(?:-?\d|['"`[{]|true\b|false\b|\w+\()/.test(value)
}

interface Heading {
  readonly path: string
  readonly own: string
  readonly fences: string[]
}

/** Every field path the reference gives a type, a default and an example. */
function complete(doc: string): Set<string> {
  const headings: Heading[] = []
  const found = new Set<string>()
  let stack: Array<[depth: number, path: string]> = []
  let fence: string[] | undefined
  let header: string[] | undefined
  let current: { path: string; own: string[]; fences: string[] } | undefined
  const close = (): void => {
    if (current) headings.push({ ...current, own: current.own.join('\n') })
  }
  for (const line of doc.split('\n')) {
    if (line.startsWith('```')) {
      if (fence === undefined) fence = []
      else {
        current?.fences.push(fence.join('\n'))
        fence = undefined
      }
      continue
    }
    if (fence !== undefined) {
      fence.push(line)
      continue
    }
    const h = /^(#+) (.*)/.exec(line)
    if (h) {
      close()
      const depth = h[1]!.length
      const name = /`([\w.*]+)`/.exec(h[2]!)?.[1]
      stack = stack.filter(([d]) => d < depth)
      const base = stack.at(-1)?.[1] ?? ''
      const p = name === undefined ? base : join(base, name)
      stack.push([depth, p])
      current = { path: p, own: [h[2]!], fences: [] }
      continue
    }
    current?.own.push(line)
    const cells = line.startsWith('|')
      ? line
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim())
      : undefined
    if (cells === undefined) header = undefined
    else if (header === undefined) header = cells
    else {
      const row = /^`([\w.]+)`/.exec(cells[0] ?? '')
      if (row && completeRow(header, cells)) {
        found.add(join(stack.at(-1)?.[1] ?? '', row[1]!))
        found.add(row[1]!)
      }
    }
  }
  close()
  for (const e of headings) {
    const leaf = e.path.split('.').at(-1)!
    const parent = e.path.slice(0, Math.max(0, e.path.lastIndexOf('.')))
    // A parent's interface may sit under a heading of its own (`InputsConfig`).
    const typed = [
      e,
      ...headings.filter((x) => x.path === parent || e.path.startsWith(`${x.path}.`)),
    ].some((x) => x.fences.some((f) => declares(f, leaf)))
    const defaulted = /\bdefault\b|\(required\)|\bomitted\b|\bleft out\b/i.test(e.own)
    const shown = e.fences.some(shows) || /^\|\s*Write\s*\|/m.test(e.own)
    if (typed && defaulted && shown) found.add(e.path)
  }
  return found
}

it('reads a type, a default and an example from a heading or a row', () => {
  const doc = [
    '## `Task`',
    '```ts',
    'interface Task {',
    '  timeout?: string',
    '  name?: string',
    '}',
    '```',
    '### `timeout` (optional)',
    'Default: none.',
    '```ts',
    "timeout: '10s'",
    '```',
    '### `name` (optional)',
    'Default: the folder.',
    '```ts',
    'name?: string',
    '```',
    '### `env`',
    '| Field | Type | Default | What it does |',
    '| --- | --- | --- | --- |',
    "| `pass` | `string[]` | `[]` | Copied: `['A']`. |",
    '| `bare` | `string[]` | | Copied. |',
    '| `typed` | `string[]` | `[]` | Copied. |',
    '',
    '| Setting | Variable | Value | Default | What it does |',
    '| --- | --- | --- | --- | --- |',
    "| `dir` | `VX_DIR` | a path | `'.vx'` | Where. |",
    '| `jobs` | `VX_JOBS` | a number like 4 | `1` | How many. |',
  ].join('\n')
  const found = complete(doc)
  expect(found.has('Task.timeout')).toBe(true)
  expect(found.has('Task.name')).toBe(false)
  expect(found.has('Task.env.pass')).toBe(true)
  expect(found.has('Task.env.bare')).toBe(false)
  expect(found.has('Task.env.typed')).toBe(false)
  expect(found.has('Task.env.dir')).toBe(false)
  expect(found.has('Task.env.jobs')).toBe(true)
})

it('gives every config field a type, a default and an example', () => {
  const found = complete(DOC)
  const missing = fields().filter((f) => !explained(f, found))
  expect(missing).toEqual([])
})
