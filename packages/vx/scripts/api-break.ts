// What a change to the package API record (`tests/contract/package-api.txt`)
// breaks. The record is one section per declaration the façade exports,
// `== <kind> <Name> (<file>)` and its lines. A section gone, or a line gone
// from one, is breaking: a removed export or member, or a changed signature
// (which reads as one line out and one in). A section or line added is not.
// Conservative on purpose: a new required member of an interface a plugin
// implements breaks that plugin and reads here as an addition, and a
// reformatted line reads as a break.

function sections(record: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  let lines: Set<string> | undefined
  for (const line of record.split('\n')) {
    if (line.startsWith('== ')) out.set(line.slice(3), (lines = new Set()))
    else if (line !== '') lines?.add(line)
  }
  return out
}

/** One line per break, `before` → `after`: `removed <section>` or `<section>: - <line>`. */
export function apiBreaks(before: string, after: string): string[] {
  const now = sections(after)
  const breaks: string[] = []
  for (const [id, lines] of sections(before)) {
    const kept = now.get(id)
    if (kept === undefined) {
      breaks.push(`removed ${id}`)
      continue
    }
    for (const line of lines) {
      if (kept.has(line)) continue
      // An empty body's first member: `X extends B {}` now reads `X extends B {`.
      if (line.endsWith(' {}') && kept.has(line.slice(0, -1)) && kept.has('}')) continue
      breaks.push(`${id}: - ${line.trim()}`)
    }
  }
  return breaks
}

/** Every `path=value` leaf of a JSON value; an array's items share `path[]`. */
function leaves(
  v: unknown,
  at = '',
  out: string[] = [],
  skip?: (key: string, at: string) => boolean,
): string[] {
  if (Array.isArray(v)) for (const x of v) leaves(x, `${at}[]`, out, skip)
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (skip?.(k, at) === true) continue
      leaves(x, at === '' ? k : `${at}.${k}`, out, skip)
    }
  } else out.push(`${at}=${JSON.stringify(v)}`)
  return out
}

const gone = (before: readonly string[], after: readonly string[]): string[] => {
  const now = new Set(after)
  return [...new Set(before)].filter((l) => !now.has(l)).map((l) => `- ${l}`)
}

/** vx's support for a Turbo or Nx key, best first: a step down is a break. */
/** A JSON Schema's prose, not its shape; under `properties` the same word is a field. */
const ANNOTATIONS = new Set(['title', 'description', '$comment', 'examples'])

const SUPPORT = ['supported', 'mapped', 'not-supported', 'not-applicable']

/**
 * What a change to the contract record named `record` (a path under
 * `tests/contract/`, or a package's own record) breaks, one line per break.
 * Each record's own reading: the API records by section, a pack list or a
 * record of leaves by what left it (a changed value leaves too), the
 * config schema by the fields and accepted values it lost (a reworded
 * refusal is no break), its rules by the combinations it lost, and the
 * Turbo/Nx table by a key whose status got worse.
 */
export function contractBreaks(record: string, before: string, after: string): string[] {
  const name = record.split('/').pop()!
  if (record.includes('package-api') || record.includes('plugin-api/')) {
    return apiBreaks(before, after)
  }
  if (name.endsWith('.txt')) {
    const lines = (t: string): string[] => t.split('\n').filter((l) => l !== '')
    return gone(lines(before), lines(after))
  }
  const parse = (t: string): unknown => (t === '' ? {} : JSON.parse(t))
  const [b, a] = [parse(before), parse(after)]
  if (name === 'turbo-nx-support.json') {
    type Row = { key: string; status: string }
    const now = new Map((a as Row[]).map((r) => [r.key, r.status]))
    return (b as Row[]).flatMap((r) => {
      const s = now.get(r.key)
      return s !== undefined && SUPPORT.indexOf(s) > SUPPORT.indexOf(r.status)
        ? [`${r.key}: ${r.status} → ${s}`]
        : []
    })
  }
  if (name === 'config-schema.json') {
    const message = (k: string): boolean => k.startsWith('$CONFIG')
    return gone(leaves(b, '', [], message), leaves(a, '', [], message))
  }
  if (record.startsWith('schemas/')) {
    // A `--format json` output's schema: a lost property, `required` entry,
    // type or enum value is a break; reworded prose is not.
    const prose = (k: string, at: string): boolean =>
      ANNOTATIONS.has(k) && !at.endsWith('properties')
    return gone(leaves(b, '', [], prose), leaves(a, '', [], prose))
  }
  if (name === 'config-schema-rules.json') {
    const keys = (v: unknown): string[] => leaves(v).map((l) => l.slice(0, l.indexOf('=')))
    return gone(keys(b), keys(a))
  }
  return gone(leaves(b), leaves(a))
}
