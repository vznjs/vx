// `Bun.Glob`'s `match()` for a runtime without Bun: the pattern compiled to
// one RegExp. Only `match`: the plan never scans (output scans happen on
// execution, which the playground does not do).
//
// The rules are Bun 1.4.2's AS MEASURED (`glob-probe.ts`, `glob-equiv.ts`),
// not a spec. Bun's matcher shares quirks with `glob-match` (Rust) but is
// not it: a TS port of glob-match 0.2.1 scored 6,058 differences on the
// fuzz where these rules score 154.
//   - `*` and `?` stop at `/` and match a leading dot;
//   - `**` is a globstar when it is exactly two stars — after `/**` runs
//     coalesce into it (`b**/**` is `b` + globstar) — preceded in the RAW
//     pattern by the start, `/`, `{` or a brace `,`, and followed by the
//     end or `/`. Decided before braces expand, so `{a,}**` is a star.
//     Any other run of stars is one star;
//   - `a/**/b` matches `a/b`; `a/**` matches `a/` but not `a`;
//   - braces nest and may hold `/`; an unclosed `{` closes at the end;
//   - `[...]` is a class, `[!..]` / `[^..]` negate and never match `/`;
//   - `\` escapes, a dangling one matches nothing; each leading `!` flips.
// NOT exact: it agrees on every realistic glob, and differs from Bun on
// 219 of 500,000 adversarial task-glob pairs over git paths — runs of `**`
// abutting braces or stars (`**/**/**x`), `**?`, and paths with an empty
// segment, where Bun's backtracking has special cases. Exact needs a port
// of Bun's own matcher; see docs/design/playground-spike-2026-09.md.

type Token =
  | { t: 'lit'; c: string }
  | { t: 'star' }
  | { t: 'globstar' }
  | { t: 'any' }
  | { t: 'class'; re: string }
  | { t: 'open' }
  | { t: 'comma' }
  | { t: 'close' }
  | { t: 'never' }

const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|/]/

function escapeChar(c: string): string {
  return REGEX_SPECIAL.test(c) ? `\\${c}` : c
}

function tokenize(p: string): Token[] {
  // Code points, not UTF-16 units: Bun's `?` consumes one code point (`é`).
  const chars = Array.from(p)
  const out: Token[] = []
  let depth = 0
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!
    if (c === '\\') {
      if (i + 1 >= chars.length) out.push({ t: 'never' })
      else out.push({ t: 'lit', c: chars[++i]! })
      continue
    }
    if (c === '*') {
      let j = i
      while (chars[j] === '*') j++
      if (j - i !== 2) {
        out.push({ t: 'star' })
        i = j - 1
        continue
      }
      let before = i === 0 ? undefined : chars[i - 1]
      while (chars[j] === '/' && chars[j + 1] === '*' && chars[j + 2] === '*') {
        j += 3
        before = '/'
      }
      const prev = out.at(-1)
      const boundedBefore =
        before === undefined || before === '/' || prev?.t === 'open' || prev?.t === 'comma'
      const next = chars[j]
      const boundedAfter = next === undefined || next === '/'
      out.push(boundedBefore && boundedAfter ? { t: 'globstar' } : { t: 'star' })
      i = j - 1
      continue
    }
    if (c === '?') {
      out.push({ t: 'any' })
      continue
    }
    if (c === '[') {
      const cls = compileClass(chars, i)
      if (cls !== null) {
        out.push({ t: 'class', re: cls.re })
        i = cls.end
        continue
      }
    }
    if (c === '{') {
      depth++
      out.push({ t: 'open' })
      continue
    }
    if (c === ',' && depth > 0) {
      out.push({ t: 'comma' })
      continue
    }
    if (c === '}' && depth > 0) {
      depth--
      out.push({ t: 'close' })
      continue
    }
    out.push({ t: 'lit', c })
  }
  for (; depth > 0; depth--) out.push({ t: 'close' })
  return out
}

/** Every brace-free token list the braces expand to. */
function expand(tokens: readonly Token[]): Token[][] {
  const open = tokens.findIndex((k) => k.t === 'open')
  if (open === -1) return [tokens as Token[]]
  let depth = 0
  let close = -1
  const cuts: number[] = []
  for (let i = open; i < tokens.length; i++) {
    const k = tokens[i]!
    if (k.t === 'open') depth++
    else if (k.t === 'close' && --depth === 0) {
      close = i
      break
    } else if (k.t === 'comma' && depth === 1) cuts.push(i)
  }
  const head = tokens.slice(0, open)
  const tail = tokens.slice(close + 1)
  const bounds = [open, ...cuts, close]
  const out: Token[][] = []
  for (let b = 0; b + 1 < bounds.length; b++) {
    out.push(...expand([...head, ...tokens.slice(bounds[b]! + 1, bounds[b + 1]), ...tail]))
  }
  return out
}

function compile(tokens: readonly Token[]): string | null {
  let re = ''
  for (let i = 0; i < tokens.length; i++) {
    const k = tokens[i]!
    switch (k.t) {
      case 'never':
        return null
      case 'lit':
        re += escapeChar(k.c)
        break
      case 'star':
        re += '[^/]*'
        break
      case 'any':
        re += '[^/]'
        break
      case 'class':
        re += k.re
        break
      case 'globstar': {
        const next = tokens[i + 1]
        if (next?.t === 'lit' && next.c === '/') {
          re += '(?:.*/)?'
          i++
        } else re += '.*'
        break
      }
      default:
        throw new Error(`unexpanded ${k.t}`)
    }
  }
  return re
}

// A `-` that was not escaped: a range operator between two members.
const RANGE = '\u0000range'

function compileClass(chars: readonly string[], open: number): { re: string; end: number } | null {
  let i = open + 1
  let negate = false
  if (chars[i] === '!' || chars[i] === '^') {
    negate = true
    i++
  }
  const members: string[] = []
  const first = i
  for (; i < chars.length; i++) {
    const c = chars[i]!
    if (c === ']' && i > first) return { re: classRegex(members, negate), end: i }
    if (c === '\\' && i + 1 < chars.length) members.push(chars[++i]!)
    else members.push(c === '-' ? RANGE : c)
  }
  return null
}

function classChar(c: string): string {
  return c === '\\' || c === ']' || c === '[' || c === '^' || c === '-' ? `\\${c}` : c
}

function classRegex(members: readonly string[], negate: boolean): string {
  let body = ''
  for (let k = 0; k < members.length; k++) {
    const lo = members[k] === RANGE ? '-' : members[k]!
    if (members[k + 1] === RANGE && k + 2 < members.length) {
      const hi = members[k + 2] === RANGE ? '-' : members[k + 2]!
      if (lo.codePointAt(0)! <= hi.codePointAt(0)!) body += `${classChar(lo)}-${classChar(hi)}`
      k += 2
      continue
    }
    body += classChar(lo)
  }
  if (negate) return `[^/${body}]`
  return body === '' ? '(?!)' : `[${body}]`
}

export class Glob {
  private readonly re: RegExp | null
  private readonly negated: boolean

  constructor(pattern: string) {
    let bangs = 0
    while (pattern[bangs] === '!') bangs++
    this.negated = bangs % 2 === 1
    const sources = expand(tokenize(pattern.slice(bangs)))
      .map(compile)
      .filter((s): s is string => s !== null)
    this.re = sources.length === 0 ? null : new RegExp(`^(?:${sources.join('|')})$`, 'u')
  }

  match(path: string): boolean {
    const hit = this.re !== null && this.re.test(path)
    return this.negated ? !hit : hit
  }

  scan(): never {
    throw new Error('Glob.scan is not available in the playground: the plan never walks a disk')
  }

  scanSync(): never {
    return this.scan()
  }
}
