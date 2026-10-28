import { existsSync } from 'node:fs'
import path from 'node:path'
import { UserError } from '../util/index.js'
import type { ProjectEntry } from './workspace.js'

/**
 * Each unescaped `[`…`]` class in a segment, or null when the segment holds
 * none or another wildcard (`*`, `?`, `{`) a literal reading cannot settle.
 */
function classes(segment: string): [number, number][] | null {
  const found: [number, number][] = []
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!
    if (c === '\\') i++
    else if (c === '*' || c === '?' || c === '{') return null
    else if (c === '[') {
      const end = segment.indexOf(']', i + 2)
      if (end === -1) return null
      found.push([i, end])
      i = end
    }
  }
  return found.length > 0 ? found : null
}

const unescape = (s: string): string => s.replace(/\\(.)/g, '$1')
const literalSegment = (s: string): boolean => !/(?<!\\)[*?{[]/.test(s)

/**
 * The glob with its first class segment escaped, when that segment taken
 * literally names a path under `base`; else null. Only a literal prefix is
 * followed: `**\/[id]` would need a walk, and this runs at `vx lock`.
 */
function literalBracketFix(glob: string, base: string): string | null {
  const neg = glob.startsWith('!') ? '!' : ''
  const segments = glob.slice(neg.length).split('/')
  const prefix: string[] = []
  for (const [i, s] of segments.entries()) {
    if (literalSegment(s)) {
      prefix.push(unescape(s))
      continue
    }
    const spans = classes(s)
    if (spans === null) return null
    if (!existsSync(path.join(base, ...prefix, unescape(s)))) return null
    let fixed = s
    for (const [open, close] of spans.toReversed())
      fixed = `${fixed.slice(0, open)}\\[${fixed.slice(open + 1, close)}\\]${fixed.slice(close + 1)}`
    return neg + [...segments.slice(0, i), fixed, ...segments.slice(i + 1)].join('/')
  }
  return null
}

/**
 * A bare `app/[id]/**` is the class matching `app/i` and `app/d`, never the
 * route directory `app/[id]` (schema.md). Beside another glob it matched
 * nothing with no warning, so an edit under the route replayed a stale hit
 * (vercel/turborepo#14850 reads an existing bracketed path literally). vx
 * keeps one reading and refuses the glob when that path exists. Checked by
 * `vx lock` only: a run trusts the lock.
 */
export function checkBracketLiterals(root: string, projects: Iterable<ProjectEntry>): void {
  for (const p of projects) {
    for (const [task, t] of Object.entries(p.config.tasks ?? {})) {
      const lists: [string, readonly string[] | undefined, string][] = [
        ['inputs.files', t.inputs?.files, p.dir],
        ['inputs.workspaceFiles', t.inputs?.workspaceFiles, root],
        ['cache.outputs.files', t.cache?.outputs?.files, p.dir],
        ['cache.outputs.workspaceFiles', t.cache?.outputs?.workspaceFiles, root],
      ]
      for (const [field, globs, base] of lists) {
        for (const glob of globs ?? []) {
          if (!glob.includes('[')) continue
          const fixed = literalBracketFix(glob, base)
          if (fixed === null) continue
          throw new UserError(
            `${p.name}#${task} ${field}: "${glob}" reads its brackets as a character class, ` +
              `so it never matches the path of that name, which exists: write "${fixed}"`,
          )
        }
      }
    }
  }
}
