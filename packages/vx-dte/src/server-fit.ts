// What a worker's servers use, charged to the tasks that make them work.
// A server is no task of the run's: its CPU was no one's, so history
// booked its dependants by their own trees and a server they kept at 100%
// went unbooked. Each look gives one sample per server: the cores its
// tree used and exactly which dependants ran then. The model is
// cores = base + the sum of each running dependant's own cost, fitted
// online (projected gradient: never below 0), and each sample's cores are
// split by it: the base evenly, the rest by cost. A task's share is added
// to its CPU, so history books it, and the planner still sees only tasks.

/** The step of each update, as a share of the error: small enough not to swing on one noisy look. */
const RATE = 0.3

interface Model {
  base: number
  readonly cost: Map<string, number>
}

export interface ServerFit {
  /**
   * One look at `server`: `cores` its tree used over the last `ms` while
   * `users` ran. `capped`: the machine was full, so `cores` is only what
   * it got, a floor of what it asked for.
   */
  sample(server: string, users: readonly string[], cores: number, ms: number, capped: boolean): void
  /** The server CPU charged to `task` since it began, in core-ms; taking it clears it. */
  take(task: string): number
  /** `server`'s model now: its base and each dependant's cost, cores. */
  model(server: string): { base: number; cost: ReadonlyMap<string, number> } | undefined
}

export function serverFit(): ServerFit {
  const models = new Map<string, Model>()
  const owed = new Map<string, number>()
  return {
    sample(server, users, cores, ms, capped) {
      let m = models.get(server)
      if (m === undefined) models.set(server, (m = { base: 0, cost: new Map() }))
      const cost = (u: string): number => m.cost.get(u) ?? 0
      let predicted = m.base
      for (const u of users) predicted += cost(u)
      const error = cores - predicted
      // A capped look says only "at least": it may raise the model, never lower it.
      if (!(capped && error < 0)) {
        const step = (RATE * error) / (users.length + 1)
        m.base = Math.max(0, m.base + step)
        for (const u of users) m.cost.set(u, Math.max(0, cost(u) + step))
      }
      if (users.length === 0 || !(cores > 0) || !(ms > 0)) return
      const shares = users.map((u) => m.base / users.length + cost(u))
      const total = shares.reduce((a, b) => a + b, 0)
      users.forEach((u, i) => {
        const part = total > 0 ? shares[i]! / total : 1 / users.length
        owed.set(u, (owed.get(u) ?? 0) + cores * ms * part)
      })
    },
    take(task) {
      const ms = owed.get(task) ?? 0
      owed.delete(task)
      return ms
    },
    model(server) {
      return models.get(server)
    },
  }
}
