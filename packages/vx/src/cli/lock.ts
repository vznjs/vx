// `vx lock` — freeze every resolved vx.config.* into vx-lock.json.
// `vx lock --check` — audit the lock against a fresh evaluation in the
// current environment. Design: docs/design/config-lock-2026-06.md.

import type { ProjectConfig } from '../config.js'
import { seeHelp } from './help.js'
import { relPosix, xxh3hex } from '../util/index.js'
import {
  findWorkspaceRoot,
  listProjects,
  loadProjectConfig,
  loadWorkspace,
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  readLockfile,
  writeLockfile,
  type Lockfile,
  type LockfileEntry,
  type ProjectMeta,
} from '../workspace/index.js'

export interface LockArgs {
  check: boolean
  error?: string
}

export function parseLockArgs(args: readonly string[]): LockArgs {
  const out: LockArgs = { check: false }
  for (const a of args) {
    if (a === '--check') out.check = true
    else return { check: false, error: `unknown argument: ${a}${seeHelp('lock')}` }
  }
  return out
}

type ConfiguredMeta = ProjectMeta & { configPath: string }

export async function lockCmd(args: readonly string[]): Promise<number> {
  const parsed = parseLockArgs(args)
  if (parsed.error) {
    process.stderr.write(`vx lock: ${parsed.error}\n`)
    return 1
  }
  const root = await findWorkspaceRoot(process.cwd())
  const workspace = await loadWorkspace(root)
  const metas = (await listProjects(workspace)).filter(
    (m): m is ConfiguredMeta => m.configPath !== null,
  )
  if (parsed.check) return await checkLock(root, metas)
  return await writeLock(root, metas)
}

/** Evaluate one config in the current env, returning its lock entry. */
async function evaluateEntry(root: string, meta: ConfiguredMeta): Promise<LockfileEntry> {
  const bytes = await Bun.file(meta.configPath).bytes()
  // `fresh: true` — locking must observe the current environment, not
  // a module-cache replay from earlier in this process.
  const config = await loadProjectConfig(meta.configPath, { fresh: true })
  return {
    configPath: relPosix(root, meta.configPath),
    configHash: xxh3hex(bytes),
    // JSON round-trip drops `undefined` fields so the stored object is
    // byte-identical to what a later read of the lock will produce —
    // the exact form `--check` compares against.
    config: JSON.parse(JSON.stringify(config)) as ProjectConfig,
  }
}

async function writeLock(root: string, metas: ConfiguredMeta[]): Promise<number> {
  const entries = await Promise.all(metas.map((m) => evaluateEntry(root, m)))
  const projects: Record<string, LockfileEntry> = {}
  // `listProjects` sorts by name — stable lockfile diffs for free.
  for (let i = 0; i < metas.length; i++) projects[metas[i]!.name] = entries[i]!
  const lock: Lockfile = { version: LOCKFILE_VERSION, projects }
  await writeLockfile(root, lock)
  const n = metas.length
  process.stdout.write(`vx: locked ${n} project config${n === 1 ? '' : 's'} → ${LOCKFILE_NAME}\n`)
  return 0
}

/**
 * Audit the lock. Two layers, strictly stronger than what runs do:
 *   1. The same hash check runs perform (file bytes vs lock hash).
 *   2. A full re-evaluation of every config in the CURRENT environment,
 *      deep-compared against the lock's stored resolved object. This
 *      catches eval-time env-var drift that file hashes cannot see —
 *      file bytes unchanged, resolved value changed.
 */
async function checkLock(root: string, metas: ConfiguredMeta[]): Promise<number> {
  const lock = await readLockfile(root)
  if (!lock) {
    process.stderr.write(
      `vx lock --check: no ${LOCKFILE_NAME} at ${root} — run \`vx lock\` first\n`,
    )
    return 1
  }
  const results = await Promise.all(
    metas.map(async (m): Promise<string | null> => {
      const rel = relPosix(root, m.configPath)
      const entry = lock.projects[m.name]
      if (!entry || entry.configPath !== rel) {
        return `"${m.name}" (${rel}) is not in the lock — run 'vx lock'`
      }
      const hash = xxh3hex(await Bun.file(m.configPath).bytes())
      if (hash !== entry.configHash) {
        return `config file changed since lock (${m.name}: ${rel}) — run 'vx lock'`
      }
      const fresh = JSON.parse(
        JSON.stringify(await loadProjectConfig(m.configPath, { fresh: true })),
      ) as ProjectConfig
      if (!Bun.deepEquals(fresh, entry.config, true)) {
        return (
          `lock differs from fresh evaluation in this environment (${m.name}) — ` +
          `env-dependent config? run 'vx lock' here or remove env reads from config`
        )
      }
      return null
    }),
  )
  const failures = results.filter((r): r is string => r !== null)
  const inWorkspace = new Set(metas.map((m) => m.name))
  for (const name of Object.keys(lock.projects)) {
    if (!inWorkspace.has(name)) {
      failures.push(
        `locked project "${name}" no longer has a config in the workspace — run 'vx lock'`,
      )
    }
  }
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`vx lock --check: ${f}\n`)
    return 1
  }
  const n = metas.length
  process.stdout.write(`vx: lock is up to date (${n} project${n === 1 ? '' : 's'})\n`)
  return 0
}
