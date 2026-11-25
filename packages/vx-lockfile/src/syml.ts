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
  // A key over 1024 characters, which Yarn writes `? key` with its `:` on
  // the next line (YAML 1.2's limit on an implicit key): read as a hand
  // edit, the whole file fell back to YAML and `0.10` read as 0.1 again.
  let explicit: string | undefined
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
    if (explicit !== undefined) {
      if (line[indent] !== ':') return undefined
      key = explicit
      explicit = undefined
      rest = indent + 1
    } else if (line[indent] === '?' && line[indent + 1] === ' ') {
      explicit = scalar(line.slice(indent + 2).trim())
      if (explicit === undefined) return undefined
      continue
    } else if (line[indent] === '"') {
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
    if (value === '{}') {
      map[key] = {}
      continue
    }
    const v = scalar(value)
    if (v === undefined) return undefined
    map[key] = v
  }
  // A `key:` with nothing under it at the end is a file cut short: as YAML
  // it reads null, which the caller refuses, where `{}` here read as an
  // entry with no dependencies.
  return explicit === undefined && open === undefined ? root : undefined
}

/** A whole scalar as Yarn's writer emits it, JSON-quoted or plain; undefined otherwise. */
function scalar(text: string): string | undefined {
  if (text[0] === '"') return json(text)
  return text === '' || PLAIN_START.includes(text[0]!) ? undefined : text
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
