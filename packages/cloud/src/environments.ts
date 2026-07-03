// Durable per-user client config: the named-server environments list
// (docker-context-style). Written by the `vx-cloud connect` / `env` verbs,
// consulted lazily by the cloud() plugin's telemetry + backend ladders.
//
// Deliberately split from serve-info.json: that file is runtime STATE (lives
// in $XDG_RUNTIME_DIR, auto-cleared on logout, written by the SERVER); this
// one is durable user CONFIG (lives in $XDG_CONFIG_HOME, written by the CLI).
// Different lifecycles, different dirs.
//
// Light by design (only node:fs/os/path) so `plugin.ts` — imported via the
// lean `@vzn/vx-cloud/plugin` subpath — can read it without pulling the
// service layer.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const ENVIRONMENTS_VERSION = 1

export interface EnvironmentEntry {
  url: string
  /** Bearer token sent on ingest POSTs and the WS delegation upgrade. */
  token?: string
  /**
   * The UNTRUSTED (fork-PR) cache token for this environment. Presented in
   * place of `token` on a detected fork-PR run — reads the trusted scope,
   * writes only untrusted. Safe to commit.
   */
  prToken?: string
  /**
   * Whether the backend capability may route EXECUTION here (default false).
   * Opt-in because delegation runs against `request.cwd` on the server — only
   * correct when the server shares (or mirrors) the filesystem.
   */
  delegate?: boolean
}

export interface EnvironmentsFile {
  version: typeof ENVIRONMENTS_VERSION
  /**
   * Name of the current environment. One top-level pointer (not per-entry
   * flags) so two actives are structurally impossible. `VX_CLOUD_ENV`
   * overrides it per-shell without touching the file.
   */
  active?: string
  environments: Record<string, EnvironmentEntry>
}

export interface CloudEnvironment extends EnvironmentEntry {
  name: string
}

/** Environment names are docker-context-style: `[a-z0-9._-]+`. */
export function isValidEnvironmentName(name: string): boolean {
  return /^[a-z0-9._-]+$/.test(name)
}

/**
 * Path to the environments file. `VX_CLOUD_CONFIG` pins an exact path
 * (tests / exotic setups); otherwise `$XDG_CONFIG_HOME/vx-cloud/
 * environments.json`, else `~/.config/vx-cloud/environments.json`.
 */
export function environmentsPath(): string {
  const override = process.env['VX_CLOUD_CONFIG']
  if (override !== undefined && override !== '') return override
  const xdg = process.env['XDG_CONFIG_HOME']
  const base = xdg !== undefined && xdg !== '' ? xdg : path.join(os.homedir(), '.config')
  return path.join(base, 'vx-cloud', 'environments.json')
}

/**
 * Read + validate the environments file, uncached — the CLI path. Absent →
 * undefined; malformed JSON / unknown version / bad shape → throws with the
 * path (the user is present to fix it). The plugin path goes through
 * `activeEnvironment`, which never throws.
 */
export function readEnvironmentsFile(): EnvironmentsFile | undefined {
  const p = environmentsPath()
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`malformed JSON in ${p}`)
  }
  return validateFile(parsed, p)
}

function validateFile(parsed: unknown, p: string): EnvironmentsFile {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`environments file is not an object: ${p}`)
  }
  const file = parsed as { version?: unknown; active?: unknown; environments?: unknown }
  if (file.version !== ENVIRONMENTS_VERSION) {
    throw new Error(`unsupported environments file version ${String(file.version)} in ${p}`)
  }
  if (file.active !== undefined && typeof file.active !== 'string') {
    throw new Error(`invalid "active" in ${p}`)
  }
  if (typeof file.environments !== 'object' || file.environments === null) {
    throw new Error(`invalid "environments" in ${p}`)
  }
  const environments: Record<string, EnvironmentEntry> = {}
  for (const [name, value] of Object.entries(file.environments)) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`environment "${name}" is not an object in ${p}`)
    }
    const raw = value as {
      url?: unknown
      token?: unknown
      prToken?: unknown
      delegate?: unknown
    }
    if (typeof raw.url !== 'string' || raw.url === '') {
      throw new Error(`environment "${name}" has no url in ${p}`)
    }
    if (raw.token !== undefined && typeof raw.token !== 'string') {
      throw new Error(`environment "${name}" has a non-string token in ${p}`)
    }
    if (raw.prToken !== undefined && typeof raw.prToken !== 'string') {
      throw new Error(`environment "${name}" has a non-string prToken in ${p}`)
    }
    if (raw.delegate !== undefined && typeof raw.delegate !== 'boolean') {
      throw new Error(`environment "${name}" has a non-boolean delegate in ${p}`)
    }
    environments[name] = {
      url: raw.url,
      ...(raw.token !== undefined ? { token: raw.token } : {}),
      ...(raw.prToken !== undefined ? { prToken: raw.prToken } : {}),
      ...(raw.delegate !== undefined ? { delegate: raw.delegate } : {}),
    }
  }
  return {
    version: ENVIRONMENTS_VERSION,
    ...(file.active !== undefined ? { active: file.active } : {}),
    environments,
  }
}

// The parsed file is memoized per resolved path — the plugin's telemetry +
// backend consults share ONE fs read per process (the laziness guarantee).
// `VX_CLOUD_ENV` is read live on every call so the per-shell override needs
// no cache invalidation.
const fileMemo = new Map<string, EnvironmentsFile | undefined>()
const warnedPaths = new Set<string>()

/**
 * The active environment (memoized read) — the plugin path. `VX_CLOUD_ENV`
 * beats the file's `active` pointer. A bad/unknown-version/malformed file is
 * treated as absent (warn once): a corrupt config file must never fail a run.
 */
export function activeEnvironment(): CloudEnvironment | undefined {
  const p = environmentsPath()
  if (!fileMemo.has(p)) {
    let file: EnvironmentsFile | undefined
    try {
      file = readEnvironmentsFile()
    } catch (err) {
      if (!warnedPaths.has(p)) {
        warnedPaths.add(p)
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`vx-cloud: ignoring environments file: ${message}\n`)
      }
    }
    fileMemo.set(p, file)
  }
  const file = fileMemo.get(p)
  if (file === undefined) return undefined
  const override = process.env['VX_CLOUD_ENV']
  const name = override !== undefined && override !== '' ? override : file.active
  if (name === undefined || name === '') return undefined
  const entry = file.environments[name]
  if (entry === undefined) return undefined
  return { name, ...entry }
}

/**
 * Atomically persist the environments file. The file holds bearer tokens, so
 * owner-only modes are enforced on every write (0600 file / 0700 dir — the
 * kubeconfig posture).
 */
export function writeEnvironmentsFile(file: EnvironmentsFile): void {
  const p = environmentsPath()
  const dir = path.dirname(p)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // A VX_CLOUD_CONFIG override may point into a dir we don't own (e.g. the
    // system tmpdir) — the file mode below is the real guard.
  }
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, p)
  chmodSync(p, 0o600)
  fileMemo.set(p, file)
}
