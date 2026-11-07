// What a worker's servers use, charged to the tasks that make them work.
// A server is no task of the run's: its CPU was no one's, so history
// booked its dependants by their own trees and a server they kept at 100%
// went unbooked. Each look gives one sample per server: the cores its
// tree used and exactly which dependants ran then. The model is
// cores = base + the sum of each running dependant's own cost, fitted
// online (projected gradient: never below 0). Each sample's cores are
// split by it: each dependant is charged its own cost's part, added to its
// CPU, so history books it; the base is the server's own, booked once on
// each worker that runs it (`Need.servers`), and the planner still sees
// only tasks.

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
  /** Each server's base now, cores: what a worker reports, rounded to a hundredth. */
  bases(): Record<string, number>
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
      // A capped look says only "at least": it may raise the model, never
      // lower it. The base learns only from looks with no dependant, each
      // cost only from looks with: from looks always with one, both moved
      // alike and the base took half of what the dependant made it do.
      // Unlearned, the base is 0: a dependant is charged too much, never
      // too little.
      if (!(capped && error < 0)) {
        if (users.length === 0) m.base = Math.max(0, m.base + RATE * error)
        else {
          const step = (RATE * error) / users.length
          for (const u of users) m.cost.set(u, Math.max(0, cost(u) + step))
        }
      }
      if (users.length === 0 || !(cores > 0) || !(ms > 0)) return
      let total = m.base
      for (const u of users) total += cost(u)
      if (!(total > 0)) return
      for (const u of users) owed.set(u, (owed.get(u) ?? 0) + (cores * ms * cost(u)) / total)
    },
    take(task) {
      const ms = owed.get(task) ?? 0
      owed.delete(task)
      return ms
    },
    model(server) {
      return models.get(server)
    },
    bases() {
      const out: Record<string, number> = {}
      for (const [server, m] of models) out[server] = Math.round(m.base * 100) / 100
      return out
    },
  }
}
