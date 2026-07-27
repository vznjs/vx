// Ephemeral Postgres for tests (docs/design/cloud-platform-2026-07.md §10):
// ONE cluster per test process, lazily booted — initdb into a scratch dir,
// unix-socket only (no port contention, no TCP auth), fsync off. Migrations
// apply ONCE into `template_vx`; each suite clones a fresh database from the
// template in milliseconds. The exit handler that tears it down does NOT run
// under `bun test` (measured), so the previous run's cluster is reaped at boot
// instead — see `reapAbandonedClusters`.
//
// Root quirk (this dev env runs as uid 0): initdb/postgres refuse to run as
// root, so the cluster is owned by and runs as the `postgres` system user via
// `runuser`; trust auth on the socket means the test process connects fine.
// CI runners (non-root) take the direct path.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'

const PG_USER = 'vx'
/** Records the test process that owns a scratch cluster (see reapAbandonedClusters). */
const OWNER_PID_FILE = 'owner.pid'
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

/** True while `pid` names a live process (signal 0 delivers nothing). */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Shut down and delete the clusters previous test processes abandoned.
 *
 * `boot` registers its teardown on `process.on('exit')`, and **`bun test` never
 * fires that** — measured: a clean run (1 pass, exit 0) leaves the postmaster
 * running and the scratch dir on disk. So EVERY `bun test` invocation leaked a
 * cluster, not just runs killed mid-flight as the decision log previously read.
 * At ~820 MB each, that is what fills the disk and resurfaces as
 * `PostgresError 53100`.
 *
 * `afterAll` does fire, but it is the wrong hook: the cluster is memoized per
 * PROCESS and Bun runs every test file in one, so a per-file `afterAll` would
 * stop the shared cluster after the first file and force an initdb per file.
 * Reaping at boot instead bounds the residue at one cluster — the running one.
 *
 * Liveness of the POSTMASTER cannot decide this: an abandoned one is still
 * running (that is the leak), and it daemonizes to PPID 1 immediately, so the
 * parent tells us nothing either. The owning test process is the signal — each
 * cluster records its PID, and a cluster is abandoned exactly when that process
 * is gone. A cluster whose owner still lives is left alone, so concurrent test
 * processes are safe.
 */
function reapAbandonedClusters(): void {
  let entries: string[]
  try {
    entries = readdirSync(os.tmpdir()).filter((n) => n.startsWith('vx-test-pg-'))
  } catch {
    return
  }
  for (const name of entries) {
    const dir = path.join(os.tmpdir(), name)
    try {
      const ownerFile = path.join(dir, OWNER_PID_FILE)
      // No owner file: either a cluster from before this mechanism, or one
      // caught mid-initdb. Both are safe to reap only if nothing is serving it.
      const owner = existsSync(ownerFile) ? Number.parseInt(readFileSync(ownerFile, 'utf8'), 10) : 0
      if (alive(owner)) continue
      const pidFile = path.join(dir, 'data', 'postmaster.pid')
      if (existsSync(pidFile)) {
        const pm = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
        if (alive(pm)) {
          // SIGQUIT is Postgres's immediate shutdown — no checkpoint, which is
          // right for a scratch cluster about to be deleted.
          process.kill(pm, 'SIGQUIT')
          // Then WAIT for it to go. Deleting out from under a still-exiting
          // postmaster loses the race: it keeps writing, rmSync throws, and the
          // dir survives to be reaped a run later. Measured on the first cut —
          // postmasters dropped 3 -> 1 while dirs went 3 -> 4, i.e. every kill
          // landed and every delete failed. Bounded, because a wedged
          // postmaster must not block the suite from starting; the next run
          // reaps it instead.
          for (let i = 0; i < 100 && alive(pm); i++) Bun.sleepSync(20)
        }
      }
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A cluster we cannot read or signal belongs to someone else; skip it.
    }
  }
}

async function boot(): Promise<EphemeralPg> {
  const bin = resolvePgBinDir()
  reapAbandonedClusters()
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'vx-test-pg-'))
  writeFileSync(path.join(scratch, OWNER_PID_FILE), String(process.pid))
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
