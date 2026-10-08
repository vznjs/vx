// Line-level pruning for the YAML-shaped lockfiles (pnpm-lock.yaml, yarn.lock
// berry and classic). Rewriting the parsed document would drop the package
// manager's own layout — its quoting, its blank lines, its key order — so a
// pruned file is the original with whole entries cut out, and a pruned
// lockfile diffs against the source as removals only.

/**
 * `lines` with every entry at `indent` spaces between `from` and `to` that
 * `keep` refuses cut out. An entry is its key line and every line after it
 * up to the next key line at that indent; the blank lines separating
 * entries are kept as they were between the survivors, and those after
 * the last entry stay after the last survivor.
 */
export function pruneEntries(
  lines: readonly string[],
  from: number,
  to: number,
  indent: number,
  keep: (keyLine: string) => boolean,
): string[] {
  const pad = ' '.repeat(indent)
  const isKey = (l: string): boolean => l.startsWith(pad) && /^[^\s#]/.test(l.slice(indent))
  const head: string[] = []
  let i = from
  while (i < to && !isKey(lines[i]!)) head.push(lines[i++]!)
  const entries: string[][] = []
  let separator: string[] | undefined
  while (i < to) {
    const entry = [lines[i++]!]
    while (i < to && !isKey(lines[i]!)) entry.push(lines[i++]!)
    entries.push(entry)
  }
  const blanks = (e: string[]): string[] => {
    let n = e.length
    while (n > 1 && e[n - 1]!.trim() === '') n--
    return e.splice(n)
  }
  const tail = entries.length === 0 ? [] : blanks(entries.at(-1)!)
  for (const e of entries.slice(0, -1)) {
    const gap = blanks(e)
    separator ??= gap
  }
  const kept = entries.filter((e) => keep(e[0]!))
  const out = [...head]
  for (const [n, e] of kept.entries()) {
    if (n > 0) out.push(...(separator ?? []))
    out.push(...e)
  }
  out.push(...tail)
  return out
}

/** The key a YAML mapping line opens: `  'a@1': {}` → `a@1`, `  .:` → `.`. */
export function yamlKey(line: string): string {
  const parsed: unknown = Bun.YAML.parse(line.trim())
  return parsed !== null && typeof parsed === 'object' ? (Object.keys(parsed)[0] ?? '') : ''
}

/**
 * `text` with each top-level section named in `sections` pruned to the
 * entries its predicate keeps; every other line as it was.
 */
export function pruneSections(
  text: string,
  sections: Readonly<Record<string, (key: string) => boolean>>,
): string {
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    out.push(line)
    i++
    const name = /^([A-Za-z]+):\s*$/.exec(line)?.[1]
    const keep = name === undefined ? undefined : sections[name]
    if (keep === undefined) continue
    let end = i
    while (end < lines.length && !/^\S/.test(lines[end]!)) end++
    out.push(...pruneEntries(lines, i, end, 2, (l) => keep(yamlKey(l))))
    i = end
  }
  return out.join('\n')
}
