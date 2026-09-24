// A project config is JSON data (item 701).
//
// The cache key folds `JSON.stringify` of a task's config, `vx lock`
// stores the same JSON, and a repeat load (`vx watch`) crosses back from
// its worker as JSON. A value JSON cannot carry faithfully was therefore
// refused by one path and dropped by another — `description: () => 'x'`
// failed `vx run`'s first load ("must be a string") and passed the
// worker's, which never saw it — or, where the validator does not type
// the value, it was silently outside the key on both. So every path
// refuses it, before schema validation, by this one rule: the first load
// on the live object (`validateProjectConfig`), the worker before its
// `JSON.stringify` (config-eval.ts), and the site's playground in its own
// Worker. The two workers embed `nonJsonPaths` by its source text, so
// the function must stay self-contained: no import, no module-scope name.
//
// An `undefined` PROPERTY is allowed: JSON drops it, the validator reads
// it as absent, and configs write it with conditional spreads. Inside an
// array it is refused, because JSON writes it as `null`.

/** A value JSON cannot carry, at the path the validator would name. */
export interface NonJsonValue {
  path: string
  /** What it is, as the message reads: `a function`, `NaN`, `an instance of Map`. */
  is: string
}

/** Every value in `value` that `JSON.stringify` would drop, rewrite or throw on. */
export function nonJsonPaths(value: unknown): NonJsonValue[] {
  const out: NonJsonValue[] = []
  // The key or index at each level, rendered only for a finding: the walk
  // runs on every first load, and a path string built per node cost three
  // times the schema check itself.
  const keys: Array<string | number> = []
  // The objects on the path to the one being walked: a cycle throws in
  // `JSON.stringify` and would recurse here forever. A DAG is data.
  const ancestors: object[] = []
  const found = (is: string): void => {
    let path = ''
    for (const k of keys) path += typeof k === 'number' ? `[${k}]` : path === '' ? k : `.${k}`
    out.push({ path: path === '' ? 'the default export' : path, is })
  }
  const walk = (v: unknown, inArray: boolean): void => {
    if (typeof v === 'function') found('a function')
    else if (typeof v === 'symbol') found('a symbol')
    else if (typeof v === 'bigint') found('a bigint')
    else if (typeof v === 'number' && !Number.isFinite(v)) found(String(v))
    else if (v === undefined && inArray) found('undefined in an array, which JSON writes as null')
    else if (typeof v === 'object' && v !== null) {
      if (ancestors.includes(v)) {
        found('a cyclic reference')
        return
      }
      if (Array.isArray(v)) {
        ancestors.push(v)
        // By index, not `forEach`: a hole is `undefined` to JSON too.
        for (let i = 0; i < v.length; i++) {
          keys.push(i)
          walk(v[i], true)
          keys.pop()
        }
        ancestors.pop()
        return
      }
      const proto: unknown = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) {
        const name = (proto as { constructor?: { name?: unknown } }).constructor?.name
        found(
          typeof name === 'string' && name !== ''
            ? `an instance of ${name}`
            : 'an object whose prototype is not Object.prototype',
        )
        return
      }
      ancestors.push(v)
      for (const key of Object.keys(v)) {
        keys.push(key)
        walk((v as Record<string, unknown>)[key], false)
        keys.pop()
      }
      ancestors.pop()
    }
  }
  walk(value, false)
  return out
}

/** The refusal every path gives, the CLI's and the playground's. */
export function nonJsonMessage(configPath: string, found: NonJsonValue): string {
  return `${configPath}: ${found.path} is ${found.is} — a config must be JSON data, because the cache key folds its JSON`
}
