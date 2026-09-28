// The JSON Schema subset `packages/vx/schemas/*.json` is written in:
// `$ref` into `$defs`, `oneOf`, `type` (a name or a list), `enum`,
// `const`, `properties`, `required`, `additionalProperties`, `items`. A
// keyword outside it is an error, never ignored: a schema that says more
// than the checker reads would pass output it does not hold. No
// dependency: the subset is a hundred lines, a validator package is not.

type Schema = Record<string, unknown>

const KEYWORDS = new Set([
  '$schema',
  '$id',
  '$defs',
  '$ref',
  'title',
  'description',
  'oneOf',
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
])

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function typeMatches(name: string, v: unknown): boolean {
  if (name === 'integer') return Number.isInteger(v)
  return typeOf(v) === name
}

/**
 * The errors `value` has against `schema` (empty: it conforms). Every
 * property path a conforming object carried lands in `seen` as
 * `<def or root>.<prop>`, so a caller can ask which declared fields no
 * output ever held.
 */
export function validate(root: Schema, value: unknown, seen: Set<string> = new Set()): string[] {
  const errors: string[] = []
  walkValue(root, root, value, '$', '#', errors, seen)
  return errors
}

function walkValue(
  root: Schema,
  schema: Schema,
  v: unknown,
  at: string,
  owner: string,
  errors: string[],
  seen: Set<string>,
): void {
  const walk = (s: Schema, child: unknown, where: string, by: string): void =>
    walkValue(root, s, child, where, by, errors, seen)
  for (const k of Object.keys(schema)) {
    if (!KEYWORDS.has(k)) errors.push(`${at}: schema keyword ${k} is not in the subset`)
  }
  if (typeof schema['$ref'] === 'string') {
    const name = schema['$ref'].replace('#/$defs/', '')
    const target = (root['$defs'] as Record<string, Schema> | undefined)?.[name]
    if (target === undefined) errors.push(`${at}: unresolved ${schema['$ref']}`)
    else walk(target, v, at, name)
    return
  }
  if (Array.isArray(schema['oneOf'])) {
    const passing = (schema['oneOf'] as Schema[]).filter((s) => {
      const trialErrors: string[] = []
      const trialSeen = new Set<string>()
      walkValue(root, s, v, at, owner, trialErrors, trialSeen)
      if (trialErrors.length === 0) for (const p of trialSeen) seen.add(p)
      return trialErrors.length === 0
    })
    if (passing.length !== 1) errors.push(`${at}: matches ${passing.length} oneOf branches`)
  }
  const type = schema['type']
  if (type !== undefined) {
    const names = Array.isArray(type) ? (type as string[]) : [type as string]
    if (!names.some((n) => typeMatches(n, v))) {
      errors.push(`${at}: ${typeOf(v)} is not ${names.join(' | ')}`)
      return
    }
  }
  if (Array.isArray(schema['enum']) && !(schema['enum'] as unknown[]).includes(v)) {
    errors.push(`${at}: ${JSON.stringify(v)} is not one of ${JSON.stringify(schema['enum'])}`)
  }
  if ('const' in schema && schema['const'] !== v) {
    errors.push(`${at}: ${JSON.stringify(v)} is not ${JSON.stringify(schema['const'])}`)
  }
  if (typeOf(v) === 'object') {
    const obj = v as Record<string, unknown>
    const props = (schema['properties'] ?? {}) as Record<string, Schema>
    for (const r of (schema['required'] ?? []) as string[]) {
      if (!(r in obj)) errors.push(`${at}: missing ${r}`)
    }
    for (const [k, child] of Object.entries(obj)) {
      if (k in props) {
        seen.add(`${owner}.${k}`)
        walk(props[k]!, child, `${at}.${k}`, `${owner}.${k}`)
      } else if (schema['additionalProperties'] === false) {
        errors.push(`${at}: undeclared ${k}`)
      } else if (typeof schema['additionalProperties'] === 'object') {
        walk(schema['additionalProperties'] as Schema, child, `${at}.${k}`, `${owner}.*`)
      }
    }
  }
  if (Array.isArray(v) && schema['items'] !== undefined) {
    v.forEach((item, i) => walk(schema['items'] as Schema, item, `${at}[${i}]`, `${owner}[]`))
  }
}

/** Every `<owner>.<prop>` path `schema` declares, in the naming `validate` records. */
export function declaredPaths(root: Schema): Set<string> {
  const out = new Set<string>()
  const walk = (schema: Schema, owner: string): void => {
    for (const s of (schema['oneOf'] ?? []) as Schema[]) walk(s, owner)
    for (const [k, child] of Object.entries(
      (schema['properties'] ?? {}) as Record<string, Schema>,
    )) {
      out.add(`${owner}.${k}`)
      walk(child, `${owner}.${k}`)
    }
    if (typeof schema['additionalProperties'] === 'object') {
      walk(schema['additionalProperties'] as Schema, `${owner}.*`)
    }
    if (schema['items'] !== undefined) walk(schema['items'] as Schema, `${owner}[]`)
  }
  walk(root, '#')
  for (const [name, def] of Object.entries((root['$defs'] ?? {}) as Record<string, Schema>)) {
    walk(def, name)
  }
  return out
}
