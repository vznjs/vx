// docs/modules holds one page per src/ module; a source file's account is
// the `## ` section of its module's page that docs/modules/README.md links
// the file to. Laws that hold one source file to its prose read that
// section, not the whole page, so a name two sections share cannot pass
// for the other's.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { headingSlugs } from './markdown-anchors.js'

const DOCS = path.resolve(import.meta.dir, '..', '..', 'docs', 'modules')

/** README rows: `src/<file>` → [page, slug] of the section that documents it. */
function index(): Array<[file: string, page: string, slug: string]> {
  const out: Array<[string, string, string]> = []
  let current: [string, string] | undefined
  for (const line of readFileSync(path.join(DOCS, 'README.md'), 'utf8').split('\n')) {
    if (!line.startsWith('| ')) continue
    const cells = line.split('|')
    const link = /\[`([a-z-]+\.md)`\]\(\.\/[a-z-]+\.md#([a-z0-9_-]+)\)/.exec(cells[1] ?? '')
    if (link !== null) current = [link[1]!, link[2]!]
    else if ((cells[1] ?? '').trim() !== '') continue
    if (current === undefined) continue
    for (const m of (cells[2] ?? '').matchAll(/`src\/([A-Za-z0-9_./{},-]+\.ts)`/g)) {
      const group = /^(.*)\{([^}]*)\}(.*)$/.exec(m[1]!)
      const files = group
        ? group[2]!.split(',').map((p) => group[1]! + p.trim() + group[3]!)
        : [m[1]!]
      for (const f of files) out.push([f, ...current])
    }
  }
  return out
}

/** Each `## ` section of a page, keyed by its rendered id; `within` maps every heading's id to its section's. */
function split(page: string): { bodies: Map<string, string>; within: Map<string, string> } {
  const text = readFileSync(path.join(DOCS, page), 'utf8')
  const bodies = new Map<string, string>()
  const within = new Map<string, string>()
  const lines = text.split('\n')
  const ids = [...headingSlugs(text)]
  let fenced = false
  let h = 0
  let start = -1
  let current = ''
  for (let i = 0; i <= lines.length; i++) {
    const end = i === lines.length
    const line = lines[i] ?? ''
    if (!end && /^\s*(```|~~~)/.test(line)) fenced = !fenced
    if (!end && (fenced || !/^#{1,6}\s+/.test(line))) continue
    const id = end ? '' : ids[h++]!
    if (!end && !/^##\s/.test(line)) {
      if (start !== -1) within.set(id, current)
      continue
    }
    if (start !== -1) bodies.set(current, lines.slice(start, i).join('\n'))
    start = i
    current = id
    within.set(id, id)
  }
  return { bodies, within }
}

export function sections(page: string): Map<string, string> {
  return split(page).bodies
}

/** The prose that documents `src/<source>` (e.g. `graph/scheduler.ts`). */
export function moduleSection(source: string): string {
  const row = index().find(([file]) => file === source)
  const at = row === undefined ? undefined : ([row[1], row[2]] as const)
  if (at === undefined) throw new Error(`docs/modules/README.md names no page for src/${source}`)
  const { bodies, within } = split(at[0])
  const body = bodies.get(within.get(at[1]) ?? '')
  if (body === undefined) throw new Error(`${at[0]} has no section #${at[1]}`)
  return body
}

/** `page#slug` → the source files the index links to that section. */
export function sourcesBySection(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const within = new Map<string, Map<string, string>>()
  for (const [file, page, slug] of index()) {
    if (!within.has(page)) within.set(page, split(page).within)
    const key = `${page}#${within.get(page)!.get(slug) ?? slug}`
    out.set(key, [...(out.get(key) ?? []), `src/${file}`])
  }
  return out
}
