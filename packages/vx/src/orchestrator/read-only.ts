// What a plugin is handed to observe is read-only. A setup handler that set
// a failed outcome's status to `success` made the run pass and its
// dependants run; a sink that cleared a record's `failedAttempts` cleared
// the outcome's own, and the run's failure log crashed on it. A write
// throws, inside the plugin's own call, where core already reports a throw
// naming the plugin.

/**
 * Freezes `value` and everything it holds, in place: for an object core
 * built for plugins and no longer writes (a telemetry record, the run
 * report, the project list). An object already frozen is taken as done, so
 * each is walked once.
 */
export function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  // A typed array with elements cannot be frozen; none is in a record.
  if (ArrayBuffer.isView(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) freezeDeep((value as Record<string, unknown>)[key])
  return value
}

/** The write a read-only view refuses: a TypeError, as a frozen object's is, saying why. */
function refused(key: string | symbol): TypeError {
  return new TypeError(
    `'${String(key)}' is read-only: vx hands a plugin what it observes, not what the run decides`,
  )
}

/**
 * The run's events as a plugin sees them: a read-only view of each, made at
 * the first read of each object and kept for the run, so every plugin reads
 * the same view and a node keeps one identity from its start to its end.
 * A view, not a copy: core still writes an outcome after its task ends
 * (`serverExit`), and a frozen deep copy of each node and outcome was ~5 us
 * of every task a hook heard (10,000 tasks: 45 ms).
 */
export function readOnlyEvents(): <T>(value: T) => T {
  return readOnlyViews()
}

/**
 * What a stage hands a plugin that core goes on using live: a task node in
 * `key`, `schedule` and `admit` (core writes its key parts, platform and
 * deps after, so it is not frozen), the project list in `discover` (core
 * names and grows it after each plugin). A key hook that moved a node's
 * `projectDir` ran it in another project; an admit hook that rewrote its
 * command ran it under the declared one's key. One view per object for the
 * process, so a plugin that keys on identity (nx() on the project list,
 * from `discover` to `project`) sees one object across stages.
 */
export const readOnly: <T>(value: T) => T = readOnlyViews()

/** `nodes` as a `schedule` hook reads it: each node a read-only view, the map itself unwritable. */
export function readOnlyNodes<V>(nodes: ReadonlyMap<string, V>): ReadonlyMap<string, V> {
  const out = new Map<string, V>()
  for (const [id, node] of nodes) out.set(id, readOnly(node))
  for (const key of ['set', 'delete', 'clear'] as const)
    Object.defineProperty(out, key, {
      value: () => {
        throw refused(key)
      },
    })
  return out
}

/**
 * Read-only views of plain objects and arrays, each made at its first read
 * and kept. Only plain objects and arrays are wrapped: a Map's methods need
 * the Map itself, and a frozen object is read-only already.
 */
function readOnlyViews(): <T>(value: T) => T {
  const views = new WeakMap<object, object>()
  const handler: ProxyHandler<object> = {
    // A frozen target's own values are its own: a proxy must answer them
    // unchanged, and they are read-only already.
    get: (target, key) => {
      const value: unknown = Reflect.get(target, key)
      return Object.isFrozen(target) ? value : view(value)
    },
    // Each refused whatever the plugin's mode: a frozen object's write is
    // silent outside strict code.
    set: (_target, key) => {
      throw refused(key)
    },
    defineProperty: (_target, key) => {
      throw refused(key)
    },
    deleteProperty: (_target, key) => {
      throw refused(key)
    },
    setPrototypeOf: () => {
      throw refused('prototype')
    },
    preventExtensions: () => {
      throw refused('extensions')
    },
  }
  function view<T>(value: T): T {
    if (typeof value !== 'object' || value === null) return value
    // Before the frozen check: the project list is viewed in `discover`
    // and frozen before `project`, and keeps its one view.
    const seen = views.get(value)
    if (seen !== undefined) return seen as T
    if (Object.isFrozen(value)) return value
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return value
    const made = new Proxy(value, handler)
    views.set(value, made)
    return made as T
  }
  return view
}
