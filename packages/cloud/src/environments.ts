// Durable per-user client config: the named-server environments list
// (docker-context-style). Written by the `vx-cloud connect` / `env` verbs,
// consulted lazily by the cloud() plugin's telemetry + backend ladders.
// This file is the ONE client↔serve wiring — there is no serve
// advertisement / auto-detect layer beside it.
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
   * Ambient distribution to a POOL of agents rendezvoused by this serve.
   * `true` (from `--distribute`) enables it; a number is an advisory expected
   * agent count (drives the zero-agent timeout warning). Unlike `delegate`,
   * distribution FAILS SAFE: a `vx run` degrades to a normal local run when the
   * serve is unreachable or the pool has no remote agents, so leaving it on
   * never blocks a solo run. See docs/design/universal-agents-2026-07.md.
   */
  distribute?: number | boolean
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
      distribute?: unknown
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
    // Run delegation was REMOVED (platform §12 P3): the platform has no
    // checkout to execute against. A persisted `delegate` flag is rejected with
    // a hint pointing at distribution (the replacement).
    if (raw.delegate !== undefined) {
      throw new Error(
        `environment "${name}" has a "delegate" field in ${p} — run delegation was removed; ` +
          'reconnect with `vx-cloud connect <url> --distribute` and delete the delegate line',
      )
    }
    // `distribute` is additive-optional: an older binary reading a newer file
    // ignores an unknown field, and a newer binary treats absence as off — so
    // it never forces an ENVIRONMENTS_VERSION bump. A number must be a
    // POSITIVE integer: this file is user-editable, and a hand-written 0/NaN
    // would otherwise read as "ambient ON with a nonsense expectation" (the
    // ambient rung checks `!== undefined && !== false`, not truthiness).
    if (
      raw.distribute !== undefined &&
      typeof raw.distribute !== 'boolean' &&
      !(
        typeof raw.distribute === 'number' &&
        Number.isInteger(raw.distribute) &&
        raw.distribute >= 1
      )
    ) {
      throw new Error(
        `environment "${name}" has an invalid distribute in ${p} (expected true/false or a positive integer)`,
      )
    }
    environments[name] = {
      url: raw.url,
      ...(raw.token !== undefined ? { token: raw.token } : {}),
      ...(raw.prToken !== undefined ? { prToken: raw.prToken } : {}),
      ...(raw.distribute !== undefined ? { distribute: raw.distribute } : {}),
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
