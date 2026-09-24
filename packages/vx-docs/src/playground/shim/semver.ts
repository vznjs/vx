// `Bun.semver.satisfies` for a runtime without Bun. Core's package graph
// asks it whether a workspace package's version satisfies a manifest's
// range (packages/vx/src/workspace/package-graph.ts), and only for text its
// own range grammar admits: `Bun.semver` answers true for text that is no
// range at all, and core never passes it one. So this is node-semver's
// `satisfies` (non-loose, prereleases excluded) over that grammar, which is
// what Bun 1.4.2 implements for it. Parity with Bun is held by
// tests/playground-semver.test.ts in this package.

interface Version {
  readonly tuple: readonly [number, number, number]
  readonly pre: readonly (string | number)[]
}

/** A partial version: `x`, `X`, `*` and an absent part are wildcards (undefined). */
interface PartialVersion {
  readonly major: number | undefined
  readonly minor: number | undefined
  readonly patch: number | undefined
  readonly pre: readonly (string | number)[]
}

/** `[op, version]`, or null for "any version". */
type Comparator = readonly ['<' | '<=' | '>' | '>=' | '=', Version] | null

const VERSION = /^[vV=\s]*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const PARTIAL =
  /^[vV=\s]*([xX*]|\d+)(?:\.([xX*]|\d+)(?:\.([xX*]|\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?)?)?$/

function identifiers(pre: string | undefined): (string | number)[] {
  if (pre === undefined) return []
  return pre.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))
}

function parseVersion(text: string): Version | undefined {
  const m = VERSION.exec(text.trim())
  if (m === null) return undefined
  return { tuple: [Number(m[1]), Number(m[2]), Number(m[3])], pre: identifiers(m[4]) }
}

function parsePartial(text: string): PartialVersion {
  const m = PARTIAL.exec(text)
  if (m === null) throw new Error(`playground: not a version in a range: ${JSON.stringify(text)}`)
  const part = (s: string | undefined): number | undefined =>
    s === undefined || /^[xX*]$/.test(s) ? undefined : Number(s)
  return { major: part(m[1]), minor: part(m[2]), patch: part(m[3]), pre: identifiers(m[4]) }
}

function compareIds(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'number') return -1
  if (typeof b === 'number') return 1
  return a < b ? -1 : a > b ? 1 : 0
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = a.tuple[i]! - b.tuple[i]!
    if (d !== 0) return d
  }
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1
    if (b.pre[i] === undefined) return 1
    const d = compareIds(a.pre[i]!, b.pre[i]!)
    if (d !== 0) return d
  }
  return 0
}

const v = (
  major: number,
  minor: number,
  patch: number,
  pre: readonly (string | number)[] = [],
): Version => ({
  tuple: [major, minor, patch],
  pre,
})
/** The `-0` bound node-semver closes a range with: below every prerelease of it. */
const below = (major: number, minor: number, patch: number): Comparator => [
  '<',
  v(major, minor, patch, [0]),
]

// node-semver's replaceCaret / replaceTilde / replaceXRange / hyphenReplace,
// each producing the comparators it would.
function caret(p: PartialVersion): Comparator[] {
  const { major: M, minor: m, patch: pt, pre } = p
  if (M === undefined) return [null]
  if (m === undefined) return [['>=', v(M, 0, 0)], below(M + 1, 0, 0)]
  if (pt === undefined) {
    return M === 0
      ? [['>=', v(M, m, 0)], below(M, m + 1, 0)]
      : [['>=', v(M, m, 0)], below(M + 1, 0, 0)]
  }
  const from: Comparator = ['>=', v(M, m, pt, pre)]
  if (M !== 0) return [from, below(M + 1, 0, 0)]
  if (m !== 0) return [from, below(0, m + 1, 0)]
  return [from, below(0, 0, pt + 1)]
}

function tilde(p: PartialVersion): Comparator[] {
  const { major: M, minor: m, patch: pt, pre } = p
  if (M === undefined) return [null]
  if (m === undefined) return [['>=', v(M, 0, 0)], below(M + 1, 0, 0)]
  if (pt === undefined) return [['>=', v(M, m, 0)], below(M, m + 1, 0)]
  return [['>=', v(M, m, pt, pre)], below(M, m + 1, 0)]
}

function xRange(op: string, p: PartialVersion): Comparator[] {
  const { major: M, pre } = p
  let { minor: m, patch: pt } = p
  const anyX = M === undefined || m === undefined || pt === undefined
  if (op === '=' && anyX) op = ''
  if (M === undefined) return op === '>' || op === '<' ? [['<', v(0, 0, 0, [0])]] : [null]
  if (op !== '' && anyX) {
    let major = M
    const xm = m === undefined
    m ??= 0
    pt = 0
    if (op === '>') {
      op = '>='
      if (xm) {
        major += 1
        m = 0
      } else m += 1
    } else if (op === '<=') {
      op = '<'
      if (xm) major += 1
      else m += 1
    }
    return [[op as '<' | '>=', v(major, m, pt, op === '<' ? [0] : [])]]
  }
  if (m === undefined) return [['>=', v(M, 0, 0)], below(M + 1, 0, 0)]
  if (pt === undefined) return [['>=', v(M, m, 0)], below(M, m + 1, 0)]
  return [[(op === '' ? '=' : op) as '<' | '<=' | '>' | '>=' | '=', v(M, m, pt, pre)]]
}

function hyphen(fromText: string, toText: string): Comparator[] {
  const f = parsePartial(fromText)
  const t = parsePartial(toText)
  const out: Comparator[] = []
  if (f.major !== undefined) {
    out.push([
      '>=',
      v(
        f.major,
        f.minor ?? 0,
        f.minor === undefined ? 0 : (f.patch ?? 0),
        f.patch === undefined ? [] : f.pre,
      ),
    ])
  }
  if (t.major !== undefined) {
    if (t.minor === undefined) out.push(below(t.major + 1, 0, 0))
    else if (t.patch === undefined) out.push(below(t.major, t.minor + 1, 0))
    else out.push(['<=', v(t.major, t.minor, t.patch, t.pre)])
  }
  return out.length === 0 ? [null] : out
}

function comparators(set: string): Comparator[] {
  const trimmed = set.trim()
  const h = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed)
  if (h !== null) return hyphen(h[1]!, h[2]!)
  if (trimmed === '') return [null]
  const out: Comparator[] = []
  for (const token of trimmed.replace(/([<>=~^]+)\s+/g, '$1').split(/\s+/)) {
    const m = /^(~>?|\^|[<>]=?|=)?(.*)$/.exec(token)!
    const op = m[1] ?? ''
    const p = parsePartial(m[2]!)
    if (op === '^') out.push(...caret(p))
    else if (op.startsWith('~')) out.push(...tilde(p))
    else out.push(...xRange(op, p))
  }
  return out
}

function test(c: Comparator, version: Version): boolean {
  if (c === null) return true
  const d = compare(version, c[1])
  switch (c[0]) {
    case '<':
      return d < 0
    case '<=':
      return d <= 0
    case '>':
      return d > 0
    case '>=':
      return d >= 0
    case '=':
      return d === 0
  }
}

function testSet(set: Comparator[], version: Version): boolean {
  if (!set.every((c) => test(c, version))) return false
  if (version.pre.length === 0) return true
  // A prerelease satisfies a set only when one of its comparators names a
  // prerelease of the same major.minor.patch.
  return set.some(
    (c) => c !== null && c[1].pre.length > 0 && c[1].tuple.every((n, i) => n === version.tuple[i]),
  )
}

export function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version)
  if (parsed === undefined) return false
  return range.split('||').some((set) => testSet(comparators(set), parsed))
}
