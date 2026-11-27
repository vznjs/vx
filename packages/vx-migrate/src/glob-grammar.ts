// The glob grammar Nx and Turbo share and vx's own differ in extglobs; both
// adapters translate through here.

import { existsSync } from 'node:fs'
import path from 'node:path'

const EXTGLOB = /([?@+*!])\(([^()]*)\)/g

/**
 * A minimatch-family glob (Nx's minimatch, Turbo's wax) in vx's grammar,
 * or null when it has no safe form. Character classes pass through (vx
 * reads them the same way); vx has no extglobs, so Nx's own default
 * `production` negation, `?(*.)+(spec|test).[jt]s?(x)`, excluded nothing:
 * - `?(a|b)` is `{a,b,}` and `@(a|b)` is `{a,b}`;
 * - `+(a|b)` and `*(a|b)` narrow to one repetition, which only a
 *   NEGATION may do — it then excludes fewer files, never more;
 * - `!(…)` or nesting is null.
 */
export function minimatchToVx(glob: string, negated: boolean): string | null {
  if (!glob.includes('(')) return glob
  const out = glob.replace(EXTGLOB, (_whole, kind: string, body: string) => {
    const alts = body.split('|')
    if (alts.some((a) => /[{},]/.test(a))) return '\0'
    if (kind === '?') return `{${alts.join(',')},}`
    if (kind === '@') return `{${alts.join(',')}}`
    if (!negated || kind === '!') return '\0'
    return kind === '+' ? `{${alts.join(',')}}` : `{${alts.join(',')},}`
  })
  return out.includes('\0') || /[?@+*!]\(/.test(out) ? null : out
}

// A group no extglob kind opens and no backslash escapes.
const BARE_GROUP = /(?<![\\?@+*!])\(([^()]*)\)/g

/**
 * An Nx glob's bare groups in vx's grammar, or null when one has no safe
 * form. Nx's native glob reads `(a|b)` as `{a,b}` and `(a)` as `a`, so
 * `dist/*.(js|map)` is the two extensions there; vx and minimatch read the
 * parentheses as literal text, and the glob matched nothing. Turbo's
 * grammar has no such group, so this is the Nx adapter's alone.
 */
export function nxBareGroups(glob: string): string | null {
  if (!glob.includes('(')) return glob
  let unsafe = false
  const out = glob.replace(BARE_GROUP, (_whole, body: string) => {
    const alts = body.split('|')
    if (alts.some((a) => /[{},]/.test(a))) unsafe = true
    return alts.length === 1 ? alts[0]! : `{${alts.join(',')}}`
  })
  return unsafe ? null : out
}

/** A segment (or brace arm) holding `**` and other text: `**.ts`, `a**`. */
const glued = (seg: string): boolean => seg.includes('**') && /[^*]/.test(seg)

/** Does `glob` glue `**` to other text, which core refuses? */
export const hasGluedGlobstar = (glob: string): boolean =>
  glob
    .replace(/^!/, '')
    .split(/[/{},]/)
    .some(glued)

/**
 * A glued `**` as minimatch and Nx's matcher (globset, literal separator)
 * read it: `*`, one level.
 */
export function gluedGlobstarAsStar(glob: string): string {
  const neg = glob.startsWith('!') ? '!' : ''
  return (
    neg +
    glob
      .slice(neg.length)
      .replace(/[^/{},]+/g, (seg) => (glued(seg) ? seg.replace(/\*{2,}/g, '*') : seg))
  )
}

/**
 * `list` without a literal that one of its `!` entries takes back, and
 * without a repeat. Turbo, Nx and vx all subtract an exclusion wherever it
 * sits, so such a file was never an input there either; vx refuses it at
 * load, which would stop an unchanged repo's run, so the adapters drop it.
 * A repeat adds nothing in any order: TanStack Query's `test:eslint` named
 * `eslint.config.js` twice (`sharedGlobals` and its own), and the written
 * config listed it twice.
 */
export function withoutTakenBack<T>(entries: readonly T[]): T[] {
  const list = [...new Set(entries)]
  const wild = /[*?{}[\]\\]/
  const negative = list.flatMap((e) =>
    typeof e === 'string' && e.startsWith('!') ? [e.slice(1)] : [],
  )
  if (negative.length === 0) return list
  const globs = negative
    .flatMap((n) => (wild.test(n) ? [n] : [n, `${n.replace(/\/+$/, '')}/**`]))
    .map((g) => new Bun.Glob(g.replace(/^\.\//, '')))
  return list.filter((e) => {
    if (typeof e !== 'string' || e.startsWith('!') || wild.test(e)) return true
    const lit = e.replace(/^\.\//, '').replace(/\/+$/, '')
    return !globs.some((g) => g.match(lit))
  })
}

/**
 * Could a path match both globs? False only when, before either reaches a
 * wildcard, a segment of one differs from the other's; a literal also
 * matches its directory's files, as a `!` entry takes them back.
 */
function mayOverlap(a: string, b: string): boolean {
  const wild = /[*?{}[\]\\]/
  const sa = a.replace(/^\.\//, '').split('/')
  const sb = b.replace(/^\.\//, '').split('/')
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    if (wild.test(sa[i]!) || wild.test(sb[i]!)) return true
    if (sa[i] !== sb[i]) return false
  }
  return true
}

/**
 * A negation takes back what a positive glob under either base matched
 * (vite-plus 1.8.0, turbo 2.11.13), and core refuses a list of them alone:
 * one with no positive glob under its base moves to the other, a workspace
 * one as the part that matches under the package (dropped when none does).
 * In place; `pkgDir` is `''` for the root.
 */
export function negationsAcrossBases(files: unknown[], ws: unknown[], pkgDir: string): void {
  const positive = (l: unknown[]): boolean =>
    l.some((g) => typeof g !== 'string' || !g.startsWith('!'))
  if (!positive(ws))
    for (const g of ws.splice(0) as string[]) {
      const own = pkgDir === '' ? g.slice(1) : underPackage(g.slice(1), pkgDir)
      if (own !== null) files.push(`!${own}`)
    }
  if (!positive(files) && positive(ws))
    ws.push(
      ...(files.splice(0) as string[]).map(
        (g) => `!${pkgDir === '' ? '' : `${pkgDir}/`}${g.slice(1)}`,
      ),
    )
}

// The part of workspace glob `glob` that matches under `pkgDir`, package
// relative (`**/*.md` stays `**/*.md`, `packages/*/dist/**` under
// `packages/a` is `dist/**`), or null when it matches nothing there.
function underPackage(glob: string, pkgDir: string): string | null {
  const segs = glob.split('/')
  for (const dir of pkgDir.split('/')) {
    const seg = segs[0]
    if (seg === '**') return segs.join('/')
    if (seg === undefined || segs.length === 1 || !new Bun.Glob(seg).match(dir)) return null
    segs.shift()
  }
  return segs.join('/')
}

/**
 * Two lists core reads as one, each with its own `!` entries: Turbo
 * subtracts a task's exclusions from the task's own inputs only, and a
 * `globalDependencies` exclusion from the global hash only. One list in
 * vx subtracts every `!` from every entry, so each list loses an exclusion
 * that may reach a positive entry of the other: it keys more files (a
 * missed hit), where kept it keyed fewer (a stale one).
 */
export function apartTakeBacks<T>(a: readonly T[], b: readonly T[]): [T[], T[]] {
  const positives = (l: readonly T[]) =>
    l.flatMap((e) => (typeof e === 'string' && !e.startsWith('!') ? [e] : []))
  const keep = (l: readonly T[], other: readonly string[]) =>
    l.filter(
      (e) =>
        typeof e !== 'string' ||
        !e.startsWith('!') ||
        !other.some((p) => mayOverlap(e.slice(1), p)),
    )
  return [keep(a, positives(b)), keep(b, positives(a))]
}

/**
 * A path from the file system as a task glob that names only itself: a dir
 * named `my{app}` read as a brace matched `myapp` instead, and `app/[id]` a
 * class. `*` and `?` stay, since the schema reads `\*` as a Windows
 * separator, and they match the name too (a superset).
 */
export function literalGlob(p: string): string {
  return p.replace(/^!|[{}[\]]/g, '\\$&')
}

/**
 * `glob` with each bracketed segment escaped where, read literally, it
 * names a path under `base`: Turbo reads an existing `app/[locale]` that
 * way (vercel/turborepo#14850), and core refuses the class spelling of
 * one. Only a literal prefix is followed, as core's check follows it.
 */
export function existingBracketsLiteral(glob: string, base: string): string {
  if (!glob.includes('[')) return glob
  const neg = glob.startsWith('!') ? '!' : ''
  const segments = glob.slice(neg.length).split('/')
  const at: string[] = []
  for (const [i, s] of segments.entries()) {
    if (/(?<!\\)[*?{]/.test(s)) break
    const plain = s.replace(/\\(.)/g, '$1')
    if (/(?<!\\)\[/.test(s)) {
      if (!existsSync(path.join(base, ...at, plain))) break
      segments[i] = plain.replace(/[[\]]/g, '\\$&')
    }
    at.push(plain)
  }
  return neg + segments.join('/')
}
