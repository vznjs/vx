// The config-evaluation cache tables (`config_evals`, `config_closures`):
// what `workspace/config-cache.ts` reads and writes through the
// `ConfigEvalStore` contract, honouring the run's local read/write axes.
// Owns its statements over the store's handle; `Cache` delegates.

import type { Database, SQLQueryBindings } from 'bun:sqlite'

export class ConfigEvalTable {
  private readonly selectConfigEval: ReturnType<Database['prepare']>
  private readonly insertConfigEval: ReturnType<Database['prepare']>
  private readonly upsertConfigClosure: ReturnType<Database['prepare']>
  private readonly read: boolean
  private readonly write: boolean

  constructor(
    private readonly db: Database,
    policy: { read: boolean; write: boolean },
  ) {
    this.read = policy.read
    this.write = policy.write
    this.selectConfigEval = this.db.prepare('SELECT json FROM config_evals WHERE key = ?')
    this.insertConfigEval = this.db.prepare(
      'INSERT OR REPLACE INTO config_evals(key, json, created_at) VALUES (?, ?, ?)',
    )
    this.upsertConfigClosure = this.db.prepare(
      'INSERT INTO config_closures(config_path, files_json, created_at) VALUES (?, ?, ?) ON CONFLICT(config_path) DO UPDATE SET files_json = excluded.files_json, created_at = excluded.created_at',
    )
  }

  /** `ConfigEvalStore`: a cached config evaluation, honouring the local READ axis. */
  getConfigEval(key: string): string | null {
    if (!this.read) return null
    const row = this.selectConfigEval.get(key) as { json: string } | null
    return row?.json ?? null
  }

  /** `ConfigEvalStore`: each config's ordered closure, one `IN` query per 900 paths. */
  getConfigClosures(configPaths: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>()
    if (!this.read || configPaths.length === 0) return out
    for (let i = 0; i < configPaths.length; i += 900) {
      const chunk = configPaths.slice(i, i + 900)
      const rows = this.db
        .query(
          `SELECT config_path, files_json FROM config_closures WHERE config_path IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...(chunk as readonly SQLQueryBindings[])) as Array<{
        config_path: string
        files_json: string
      }>
      for (const r of rows) out.set(r.config_path, JSON.parse(r.files_json) as string[])
    }
    return out
  }

  /** `ConfigEvalStore`: remember a config's ordered closure, honouring the local WRITE axis. */
  putConfigClosure(configPath: string, files: readonly string[]): void {
    if (!this.write) return
    this.upsertConfigClosure.run(configPath, JSON.stringify(files), Date.now())
  }

  /** `ConfigEvalStore`: a round's closures in ONE transaction (each upsert was its own, item 615). */
  putConfigClosures(entries: ReadonlyArray<readonly [string, readonly string[]]>): void {
    if (!this.write || entries.length === 0) return
    const now = Date.now()
    this.db.transaction(() => {
      for (const [configPath, files] of entries)
        this.upsertConfigClosure.run(configPath, JSON.stringify(files), now)
    })()
  }

  /** `ConfigEvalStore`: the batched read — one `IN` query per 900 keys, honouring the local READ axis. */
  getConfigEvals(keys: readonly string[]): Map<string, string> {
    const out = new Map<string, string>()
    if (!this.read || keys.length === 0) return out
    for (let i = 0; i < keys.length; i += 900) {
      const chunk = keys.slice(i, i + 900)
      const rows = this.db
        .query(
          `SELECT key, json FROM config_evals WHERE key IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...(chunk as readonly SQLQueryBindings[])) as Array<{ key: string; json: string }>
      for (const r of rows) out.set(r.key, r.json)
    }
    return out
  }

  /** `ConfigEvalStore`: remember a validated evaluation, honouring the local WRITE axis. */
  putConfigEval(key: string, json: string): void {
    if (!this.write) return
    this.insertConfigEval.run(key, json, Date.now())
  }

  /** `ConfigEvalStore`: a round's evaluations in ONE transaction. */
  putConfigEvals(entries: ReadonlyArray<readonly [string, string]>): void {
    if (!this.write || entries.length === 0) return
    const now = Date.now()
    this.db.transaction(() => {
      for (const [key, json] of entries) this.insertConfigEval.run(key, json, now)
    })()
  }

  /** Retention: a config not loaded since `cutoff` was edited or its project left. */
  pruneOlderThan(cutoff: number): void {
    this.db.prepare('DELETE FROM config_evals WHERE created_at < ?').run(cutoff)
    this.db.prepare('DELETE FROM config_closures WHERE created_at < ?').run(cutoff)
  }
}
