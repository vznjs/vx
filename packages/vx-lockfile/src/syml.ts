// Berry's yarn.lock as Yarn reads it: every scalar is its source text.
// Yarn writes a plain scalar unquoted (`stream-source: 0.10`, `p: ~`), and
// a YAML parser reads it as a number or null: `0.10` became `0.1`, which
// keys a sibling range's entry (turborepo#6296). Yarn's own writer emits a
// fixed shape — `key:` opening a map indented under it, `key: value`,
// a key or value double-quoted as JSON, `#` comment lines — so this reads
// that shape and nothing more. Anything else (a list, a flow collection, a
// single-quoted or block scalar: a hand edit) returns undefined, and the
// caller reads the file as YAML.

type Doc = Record<string, unknown>

export function parseSyml(text: string): Doc | undefined {
  const root: Doc = {}
  const stack: { indent: number; map: Doc }[] = [{ indent: 0, map: root }]
  let open: Doc | undefined
  let at = 0
  while (at < text.length) {
    let end = text.indexOf('\n', at)
    if (end === -1) end = text.length
    let line = text.slice(at, end)
    at = end + 1
    if (line.endsWith('\r')) line = line.slice(0, -1)
    let indent = 0
    while (line.charCodeAt(indent) === 32) indent++
    if (indent === line.length || line[indent] === '#') continue
    if (line[indent] === '\t') return undefined
    if (open !== undefined) {
      if (indent > stack.at(-1)!.indent) stack.push({ indent, map: open })
      open = undefined
    }
    while (indent < stack.at(-1)!.indent) stack.pop()
    if (indent !== stack.at(-1)!.indent) return undefined
    const map = stack.at(-1)!.map
    let key: string
    let rest: number
    if (line[indent] === '"') {
      const close = closingQuote(line, indent)
      if (close === -1 || line[close + 1] !== ':') return undefined
      const k = json(line.slice(indent, close + 1))
      if (k === undefined) return undefined
      key = k
      rest = close + 2
    } else {
      const colon = line.indexOf(':', indent)
      if (colon === -1 || PLAIN_START.includes(line[indent]!)) return undefined
      key = line.slice(indent, colon).trimEnd()
      rest = colon + 1
    }
    const value = line.slice(rest).trim()
    if (value === '') {
      open = {}
      map[key] = open
      continue
    }
    if (line[rest] !== ' ') return undefined
    if (value[0] === '"') {
      const v = json(value)
      if (v === undefined) return undefined
      map[key] = v
    } else if (value === '{}') {
      map[key] = {}
    } else if (PLAIN_START.includes(value[0]!)) {
      return undefined
    } else {
      map[key] = value
    }
  }
  return root
}

/** A character no plain scalar of Yarn's writer starts with. */
const PLAIN_START = `-?:,[]{}#&*!|>'"%@\``

/** The index of the `"` closing the JSON string opened at `from`, or -1. */
function closingQuote(line: string, from: number): number {
  for (let i = from + 1; i < line.length; i++) {
    if (line[i] === '\\') i++
    else if (line[i] === '"') return i
  }
  return -1
}

function json(quoted: string): string | undefined {
  try {
    const v: unknown = JSON.parse(quoted)
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}
