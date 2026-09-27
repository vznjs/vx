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
 *   meant);
 * - `?(a|b)` is `{a,b,}` and `@(a|b)` is `{a,b}`;
 * - `+(a|b)` and `*(a|b)` narrow to one repetition, which only a
 *   NEGATION may do — it then excludes fewer files, never more;
 * - a range or negated class, `!(…)`, or nesting is null.
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
    if (body === '' || /^[!^]/.test(body) || body.includes('-') || /[{},/]/.test(body)) return '\0'
    const chars = [...new Set(body)]
    return negated ? `{${chars.join(',')}}` : `{${whole},${chars.join(',')}}`
  })
  return out.includes('\0') ? null : out
}
