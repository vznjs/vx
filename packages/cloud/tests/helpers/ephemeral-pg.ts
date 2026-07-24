// Ephemeral Postgres for tests (docs/design/cloud-platform-2026-07.md §10):
// ONE cluster per test process, lazily booted — initdb into a scratch dir,
// unix-socket only (no port contention, no TCP auth), fsync off. Migrations
// apply ONCE into `template_vx`; each suite clones a fresh database from the
// template in milliseconds. Torn down on process exit.
//
// Root quirk (this dev env runs as uid 0): initdb/postgres refuse to run as
// root, so the cluster is owned by and runs as the `postgres` system user via
// `runuser`; trust auth on the socket means the test process connects fine.
// CI runners (non-root) take the direct path.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'

const PG_USER = 'vx'
const TEMPLATE_DB = 'template_vx'

export interface EphemeralPg {
  sockDir: string
  /** DATABASE_URL (libpq socket form) for `dbName` on this cluster. */
  urlFor(dbName: string): string
  /**
   * A fresh, isolated database: cloned from the migrated template by default,
   * or completely empty (`{ empty: true }`) for migration-runner tests.
   * Returns its DATABASE_URL.
   */
  createDatabase(opts?: { empty?: boolean }): Promise<string>
}

function resolvePgBinDir(): string {
  const probe = Bun.spawnSync({ cmd: ['pg_config', '--bindir'], stdout: 'pipe', stderr: 'pipe' })
  if (probe.exitCode === 0) {
    const dir = probe.stdout.toString().trim()
    if (dir !== '') return dir
  }
  for (const dir of ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/17/bin']) {
    if (Bun.spawnSync({ cmd: [path.join(dir, 'initdb'), '--version'] }).exitCode === 0) return dir
  }
  throw new Error(
    'ephemeral-pg: no Postgres server binaries found — install postgresql-16 (initdb/pg_ctl must be on PATH or under /usr/lib/postgresql)',
  )
}

/** Wrap a command to run as the `postgres` user when the test process is root. */
function asClusterOwner(cmd: string[]): string[] {
  return process.getuid?.() === 0 ? ['runuser', '-u', 'postgres', '--', ...cmd] : cmd
}

function runOrThrow(cmd: string[], what: string): void {
  const res = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' })
  if (res.exitCode !== 0) {
    throw new Error(
      `ephemeral-pg: ${what} failed:\n${res.stderr.toString()}${res.stdout.toString()}`,
    )
  }
}

async function boot(): Promise<EphemeralPg> {
  const bin = resolvePgBinDir()
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'vx-test-pg-'))
  const dataDir = path.join(scratch, 'data')
  const sockDir = path.join(scratch, 'sock')
  runOrThrow(['mkdir', '-p', sockDir], 'mkdir')
  if (process.getuid?.() === 0) {
    runOrThrow(['chown', '-R', 'postgres:postgres', scratch], 'chown')
    runOrThrow(['chmod', '755', scratch, sockDir], 'chmod')
  }
  runOrThrow(
    asClusterOwner([
      path.join(bin, 'initdb'),
      '-D',
      dataDir,
      '-U',
      PG_USER,
      '-A',
      'trust',
      '--no-sync',
    ]),
    'initdb',
  )
  runOrThrow(
    asClusterOwner([
      path.join(bin, 'pg_ctl'),
      '-D',
      dataDir,
      '-w',
      '-o',
      // max_connections=400 (default 100): the full cloud suite (37+ files in
      // ONE `bun test` process) shares this cluster, and pools accumulate at
      // their peak faster than they close — the default cap tips over into
      // `sorry, too many clients already`, which surfaced as an isolated-passing
      // flake (the db-indexes replica-race test holds an extra reserved
      // connection while ensureIndexes reserves its own, so it hit the ceiling
      // first). Headroom is ~free with fsync off; it removes the class.
      `-k ${sockDir} -c listen_addresses='' -c fsync=off -c full_page_writes=off -c max_connections=400`,
      '-l',
      path.join(scratch, 'pg.log'),
      'start',
    ]),
    'pg_ctl start',
  )
  const stop = (): void => {
    Bun.spawnSync({
      cmd: asClusterOwner([path.join(bin, 'pg_ctl'), '-D', dataDir, '-m', 'immediate', 'stop']),
      stdout: 'ignore',
      stderr: 'ignore',
    })
    rmSync(scratch, { recursive: true, force: true })
  }
  process.on('exit', stop)

  const urlFor = (dbName: string): string => `postgres://${PG_USER}@/${dbName}?host=${sockDir}`

  const admin = openDb(urlFor('postgres'))
  await admin.sql.unsafe(`CREATE DATABASE ${TEMPLATE_DB}`)
  const template = openDb(urlFor(TEMPLATE_DB))
  await runMigrations(template)
  // CREATE DATABASE … TEMPLATE requires zero connections to the template.
  await template.close()

  // Serialize clones: Postgres refuses to copy a template that another
  // CREATE DATABASE is concurrently reading.
  let chain: Promise<unknown> = Promise.resolve()
  let seq = 0
  const createDatabase = (opts?: { empty?: boolean }): Promise<string> => {
    const name = `t_${++seq}`
    const next = chain.then(async () => {
      await admin.sql.unsafe(
        opts?.empty ? `CREATE DATABASE ${name}` : `CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`,
      )
      return urlFor(name)
    })
    chain = next.catch(() => undefined)
    return next
  }

  return { sockDir, urlFor, createDatabase }
}

let cluster: Promise<EphemeralPg> | null = null

/** The per-process cluster, booted on first use. */
export function ephemeralPg(): Promise<EphemeralPg> {
  cluster ??= boot()
  return cluster
}
