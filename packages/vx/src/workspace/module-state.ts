// What a module's exports hold, to tell whether a config changed a module
// other configs import. Both functions are self-contained: the config
// worker embeds them by their source (config-eval.ts), as it does
// `nonJsonPaths`, and a minified build renames only what each one holds.

/** One entry per export: every value reachable from it, in walk order, compared by identity. */
export type ExportState = Map<PropertyKey, unknown[]>

/**
 * Every value each export of `ns` reaches through own properties and Map
 * and Set entries, without calling a getter. Functions and typed arrays
 * are compared by identity only. State a module keeps unexported, behind a
 * function, is not reached.
 */
export function exportState(ns: object): ExportState {
  const ownKeys = Reflect.ownKeys
  const describe = Object.getOwnPropertyDescriptor
  const protoOf = Object.getPrototypeOf
  const state: ExportState = new Map()
  for (const name of ownKeys(ns)) {
    const out: unknown[] = []
    const seen = new Set<object>()
    const walk = (v: unknown): void => {
      out.push(v)
      if (v === null || typeof v !== 'object' || seen.has(v) || ArrayBuffer.isView(v)) return
      seen.add(v)
      out.push(protoOf(v))
      if (v instanceof Map)
        for (const [k, x] of v) {
          out.push(k)
          walk(x)
        }
      else if (v instanceof Set) for (const x of v) walk(x)
      for (const k of ownKeys(v)) {
        const d = describe(v, k)!
        out.push(k, d.get, d.set, d.writable)
        if ('value' in d) walk(d.value)
      }
    }
    try {
      walk((ns as Record<PropertyKey, unknown>)[name])
    } catch {
      // A binding not yet initialized, or a Proxy's trap that throws.
      out.push('\0threw')
    }
    state.set(name, out)
  }
  return state
}

/** The exports whose state differs between `before` and `after`. */
export function changedExports(before: ExportState, after: ExportState): string[] {
  const out: string[] = []
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(name)
    const b = after.get(name)
    let same = a !== undefined && b !== undefined && a.length === b.length
    for (let i = 0; same && i < a!.length; i++) same = Object.is(a![i], b![i])
    if (!same) out.push(String(name))
  }
  return out
}
