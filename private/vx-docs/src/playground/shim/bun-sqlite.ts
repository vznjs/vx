// `bun:sqlite` for the playground bundle. `cache/cache.ts` imports it at the
// top level; the playground never opens a database (its cache layer is a
// set of keys, entry.ts), so constructing one is a bug in the plan path.

export class Database {
  constructor() {
    throw new Error('playground: bun:sqlite is not available (the plan should not open a database)')
  }
}

export type SQLQueryBindings = unknown
