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
