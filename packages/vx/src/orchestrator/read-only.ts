// What a plugin is handed to observe is read-only. A setup handler that set
// a failed outcome's status to `success` made the run pass and its
// dependants run; a sink that cleared a record's `failedAttempts` cleared
// the outcome's own, and the run's failure log crashed on it. A write
// throws, inside the plugin's own call, where core already reports a throw
// naming the plugin.

import type { RunEvent } from '../report/index.js'

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
 * of every task a hook heard (10,000 tasks: 45 ms). Only plain objects and
 * arrays are wrapped: a Map's methods need the Map itself, and a frozen
 * object is read-only already.
 */
export function readOnlyEvents(): (event: RunEvent) => RunEvent {
  const views = new WeakMap<object, object>()
  const handler: ProxyHandler<object> = {
    get: (target, key) => view(Reflect.get(target, key)),
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
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return value
    let seen = views.get(value)
    if (seen === undefined) views.set(value, (seen = new Proxy(value, handler)))
    return seen as T
  }
  return view
}
