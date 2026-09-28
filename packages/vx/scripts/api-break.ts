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
    for (const line of lines) if (!kept.has(line)) breaks.push(`${id}: - ${line.trim()}`)
  }
  return breaks
}
