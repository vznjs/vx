// Whether two task globs (brace-free, extglob-free, as `asTrees` gives them)
// take one path in common: the intersection of two path languages, decided
// exactly. The overlap refusal built a few candidate paths and missed pairs a
// clean then broke (`*.js` beside `*b*`: one task's clean deleted the other's
// `b.js` under a green run).

/** One character position of a segment pattern. */
type Tok =
  | { readonly k: 'lit'; readonly c: string }
  | { readonly k: 'any' }
  | { readonly k: 'star' }
  | {
      readonly k: 'cls'
      readonly neg: boolean
      readonly has: (c: string) => boolean
      readonly named: string[]
    }

function parseSegment(seg: string): Tok[] {
  const out: Tok[] = []
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!
    if (c === '\\' && i + 1 < seg.length) out.push({ k: 'lit', c: seg[++i]! })
    else if (c === '?') out.push({ k: 'any' })
    else if (c === '*') {
      if (out.at(-1)?.k !== 'star') out.push({ k: 'star' })
    } else if (c === '[') {
      const cls = parseClass(seg, i)
      if (cls === undefined) out.push({ k: 'lit', c })
      else {
        out.push(cls.tok)
        i = cls.end
      }
    } else out.push({ k: 'lit', c })
  }
  return out
}

/** A class opening at `at`, and the index of its `]`; undefined when unclosed. */
function parseClass(seg: string, at: number): { tok: Tok; end: number } | undefined {
  let i = at + 1
  const neg = seg[i] === '!' || seg[i] === '^'
  if (neg) i++
  const singles: string[] = []
  const ranges: [string, string][] = []
  for (let first = true; i < seg.length; first = false) {
    let c = seg[i]!
    if (c === ']' && !first) {
      const has = (x: string): boolean =>
        singles.includes(x) || ranges.some(([lo, hi]) => x >= lo && x <= hi)
      // The characters a path could spell to land in or out of the class.
      const named = [...singles, ...ranges.flatMap(([lo, hi]) => [lo, hi])]
      return { tok: { k: 'cls', neg, has, named }, end: i }
    }
    if (c === '\\' && i + 1 < seg.length) c = seg[++i]!
    if (seg[i + 1] === '-' && i + 2 < seg.length && seg[i + 2] !== ']') {
      let hi = seg[i + 2]!
      let next = i + 3
      if (hi === '\\' && i + 3 < seg.length) {
        hi = seg[i + 3]!
        next = i + 4
      }
      ranges.push([c, hi])
      i = next
    } else {
      singles.push(c)
      i++
    }
  }
  return undefined
}

/** A character no pattern names: it stands for every unnamed one. */
const OTHER = '\u{10fffe}'

function accepts(t: Tok, c: string): boolean {
  switch (t.k) {
    case 'lit':
      return t.c === c
    case 'any':
    case 'star':
      return true
    case 'cls':
      return t.has(c) !== t.neg
  }
}

/** Whether one non-empty segment name matches both segment patterns. */
function segmentsMeet(a: readonly Tok[], b: readonly Tok[]): boolean {
  const alphabet = new Set<string>([OTHER])
  for (const t of [...a, ...b]) {
    if (t.k === 'lit') alphabet.add(t.c)
    else if (t.k === 'cls') for (const c of t.named) alphabet.add(c)
  }
  // States: positions in each, and whether a character was read (a segment
  // is never empty).
  const seen = new Set<string>()
  const stack: [number, number, boolean][] = [[0, 0, false]]
  while (stack.length > 0) {
    const [i, j, read] = stack.pop()!
    const key = `${i},${j},${read ? 1 : 0}`
    if (seen.has(key)) continue
    seen.add(key)
    if (i === a.length && j === b.length && read) return true
    // A star may match nothing.
    if (a[i]?.k === 'star') stack.push([i + 1, j, read])
    if (b[j]?.k === 'star') stack.push([i, j + 1, read])
    if (i === a.length || j === b.length) continue
    const ta = a[i]!
    const tb = b[j]!
    for (const c of alphabet) {
      if (!accepts(ta, c) || !accepts(tb, c)) continue
      stack.push([ta.k === 'star' ? i : i + 1, tb.k === 'star' ? j : j + 1, true])
    }
  }
  return false
}

const STAR: readonly Tok[] = [{ k: 'star' }]

/**
 * Whether a path both globs match exists. `**` is any number of segments, at
 * least one at the end (`dist/**` takes nothing named `dist` itself), as
 * `taskGlob` reads it.
 */
export function globsMeet(a: string, b: string): boolean {
  const sa = a.split('/')
  const sb = b.split('/')
  const pa = sa.map((s) => (s === '**' ? null : parseSegment(s)))
  const pb = sb.map((s) => (s === '**' ? null : parseSegment(s)))
  const seen = new Set<string>()
  const stack: [number, number][] = [[0, 0]]
  while (stack.length > 0) {
    const [i, j] = stack.pop()!
    const key = `${i},${j}`
    if (seen.has(key)) continue
    seen.add(key)
    if (i === sa.length && j === sb.length) return true
    if (i < sa.length - 1 && pa[i] === null) stack.push([i + 1, j])
    if (j < sb.length - 1 && pb[j] === null) stack.push([i, j + 1])
    if (i === sa.length || j === sb.length) continue
    const ta = pa[i]
    const tb = pb[j]
    if (!segmentsMeet(ta ?? STAR, tb ?? STAR)) continue
    // One segment read: a `**` may read more, or be done.
    for (const ni of ta === null ? [i, i + 1] : [i + 1])
      for (const nj of tb === null ? [j, j + 1] : [j + 1]) stack.push([ni, nj])
  }
  return false
}
