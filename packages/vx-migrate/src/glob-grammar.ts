// The glob grammar Nx and Turbo share and vx's own differ in brackets and
// extglobs; both adapters translate through here (items 914, 1031).

const EXTGLOB = /([?@+*!])\(([^()]*)\)/g

/**
 * A minimatch-family glob (Nx's minimatch, Turbo's wax) in vx's grammar,
 * or null when it has no safe form. vx has no character classes (a bracket is a literal, for route
 * dirs, item 667) and no extglobs, so `src/**\/*.[jt]s` matched nothing
 * and Nx's own default `production` negation,
 * `?(*.)+(spec|test).[jt]s?(x)`, excluded nothing (item 914):
 * - `[jt]` is the brace set `{j,t}`, plus the literal `[jt]` itself in a
 *   positive glob (a superset of inputs is safe; the route dir may be
 *   meant); a range within digits or one case of letters (`[a-c]`,
 *   `[0-9]`) is its members;
 * - a negated class (`[!a]`) is `?` in a positive glob, a superset;
 * - `?(a|b)` is `{a,b,}` and `@(a|b)` is `{a,b}`;
 * - `+(a|b)` and `*(a|b)` narrow to one repetition, which only a
 *   NEGATION may do — it then excludes fewer files, never more;
 * - any other range, a negated class in a negation, `!(…)`, or nesting is
 *   null.
 */
export function minimatchToVx(glob: string, negated: boolean): string | null {
  if (!/[[(]/.test(glob)) return glob
  let out = glob.replace(EXTGLOB, (whole, kind: string, body: string) => {
    const alts = body.split('|')
    if (alts.some((a) => /[{},]/.test(a))) return '\0'
    if (kind === '?') return `{${alts.join(',')},}`
    if (kind === '@') return `{${alts.join(',')}}`
    if (!negated || kind === '!') return '\0'
    return kind === '+' ? `{${alts.join(',')}}` : `{${alts.join(',')},}`
  })
  if (out.includes('\0') || /[?@+*!]\(/.test(out)) return null
  out = out.replace(/\[([^\]]*)\]/g, (whole, body: string) => {
    if (body === '' || /[{},/]/.test(body)) return '\0'
    if (/^[!^]/.test(body)) return negated || body.length === 1 ? '\0' : '?'
    const chars = classMembers(body)
    if (chars === null) return '\0'
    return negated ? `{${chars.join(',')}}` : `{${whole},${chars.join(',')}}`
  })
  return out.includes('\0') ? null : out
}

const RANGES = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ']

/** A class body's characters, ranges spelled out; null for a range across kinds or backwards. */
function classMembers(body: string): string[] | null {
  const out = new Set<string>()
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    // A `-` first or last is itself, as in minimatch.
    if (body[i + 1] === '-' && i + 2 < body.length) {
      const end = body[i + 2]!
      const kind = RANGES.find((r) => r.includes(c))
      const from = kind?.indexOf(c) ?? -1
      const to = kind?.indexOf(end) ?? -1
      if (kind === undefined || to < from) return null
      for (const m of kind.slice(from, to + 1)) out.add(m)
      i += 2
    } else out.add(c)
  }
  return [...out]
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
  const wild = /[*?{}]/
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
