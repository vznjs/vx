// The glob grammar Nx and Turbo share and vx's own differ in extglobs;
// both adapters translate through here (items 914, 1031).

const EXTGLOB = /([?@+*!])\(([^()]*)\)/g

/**
 * A minimatch-family glob (Nx's minimatch, Turbo's wax) in vx's grammar,
 * or null when it has no safe form. Character classes pass through (vx
 * reads them the same way); vx has no extglobs, so Nx's own default
 * `production` negation, `?(*.)+(spec|test).[jt]s?(x)`, excluded nothing
 * (item 914):
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
 * A path from the file system as a task glob that names only itself: a dir
 * named `my{app}` read as a brace matched `myapp` instead, and `app/[id]` a
 * class. `*` and `?` stay, since the schema reads `\*` as a Windows
 * separator, and they match the name too (a superset).
 */
export function literalGlob(p: string): string {
  return p.replace(/^!|[{}[\]]/g, '\\$&')
}
