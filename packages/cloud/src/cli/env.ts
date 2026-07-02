// `vx-cloud connect` / `env ls|use|rm` / `disconnect` — the client-side
// connection verbs over the per-user environments file (docker-context-style).
// `connect` is the handshake: validate reachability + identity + token BEFORE
// persisting anything; `env ls` is the one-command picture (named servers +
// the synthetic auto-detected `(local)` row, with live reachability probes).

import { UserError } from '@vzn/vx'
import {
  ENVIRONMENTS_VERSION,
  environmentsPath,
  isValidEnvironmentName,
  readEnvironmentsFile,
  writeEnvironmentsFile,
  type EnvironmentEntry,
  type EnvironmentsFile,
} from '../environments.js'
import { pidAlive, readServeInfo } from '../serve-info.js'

const CONNECT_TIMEOUT_MS = 2000
const LS_PROBE_TIMEOUT_MS = 1000

/** Load the file for a CLI verb: absent → empty, malformed → hard UserError. */
function loadFile(): EnvironmentsFile {
  try {
    return readEnvironmentsFile() ?? { version: ENVIRONMENTS_VERSION, environments: {} }
  } catch (err) {
    throw new UserError(err instanceof Error ? err.message : String(err))
  }
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<Response | undefined> {
  // A clearable timer (not AbortSignal.timeout, whose internal timer is not
  // unref'd and would keep the CLI alive after the fetch already resolved).
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal, ...(headers ? { headers } : {}) })
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

interface ServerMeta {
  name?: string
  auth?: string
}

async function fetchMeta(base: string, timeoutMs: number): Promise<ServerMeta | undefined> {
  const res = await fetchWithTimeout(`${base}/v1/meta`, timeoutMs)
  if (res === undefined || !res.ok) return undefined
  try {
    const body = (await res.json()) as { name?: unknown; auth?: unknown }
    return {
      ...(typeof body.name === 'string' && body.name !== '' ? { name: body.name } : {}),
      ...(typeof body.auth === 'string' ? { auth: body.auth } : {}),
    }
  } catch {
    return undefined
  }
}

interface ConnectArgs {
  url?: string
  name?: string
  token?: string
  delegate?: boolean
  use: boolean
  force?: boolean
  error?: string
}

export function parseConnectArgs(args: readonly string[]): ConnectArgs {
  const out: ConnectArgs = { use: true }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--delegate') {
      out.delegate = true
      continue
    }
    if (a === '--no-use') {
      out.use = false
      continue
    }
    if (a === '--force') {
      out.force = true
      continue
    }
    const nv = a === '--name' ? args[++i] : a.startsWith('--name=') ? a.slice(7) : undefined
    if (nv !== undefined) {
      if (nv === '') return { ...out, error: 'invalid --name: empty' }
      out.name = nv
      continue
    }
    const tv = a === '--token' ? args[++i] : a.startsWith('--token=') ? a.slice(8) : undefined
    if (tv !== undefined) {
      if (tv === '') return { ...out, error: 'invalid --token: empty' }
      out.token = tv
      continue
    }
    if (a.startsWith('-')) return { ...out, error: `unknown flag: ${a}` }
    if (out.url !== undefined) return { ...out, error: `unexpected argument: ${a}` }
    out.url = a
  }
  return out
}

/**
 * Derive a default environment name: the server's self-reported name, else
 * the URL hostname — sanitized to the `[a-z0-9._-]+` key alphabet.
 */
function deriveName(metaName: string | undefined, url: URL): string {
  for (const candidate of [metaName, url.hostname]) {
    if (candidate === undefined) continue
    const sanitized = candidate.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
    if (sanitized !== '' && isValidEnvironmentName(sanitized)) return sanitized
  }
  return 'default'
}

export async function connectCmd(args: readonly string[]): Promise<number> {
  const parsed = parseConnectArgs(args)
  if (parsed.error !== undefined) throw new UserError(`connect: ${parsed.error}`)
  if (parsed.url === undefined) {
    throw new UserError('connect: <url> required (e.g. vx-cloud connect https://vx.corp.example)')
  }
  let url: URL
  try {
    url = new URL(parsed.url)
  } catch {
    throw new UserError(`connect: not a valid URL: ${parsed.url}`)
  }
  const base = parsed.url.replace(/\/+$/, '')

  // The handshake — nothing persists until every step passes.
  const health = await fetchWithTimeout(`${base}/health`, CONNECT_TIMEOUT_MS)
  if (health === undefined || !health.ok) {
    throw new UserError(`connect: cannot reach ${base}/health — is a vx-cloud serve running there?`)
  }
  const meta = await fetchMeta(base, CONNECT_TIMEOUT_MS)
  if (meta?.auth === 'token' && parsed.token === undefined) {
    throw new UserError(`connect: ${base} requires a token — pass one with --token <t>`)
  }
  if (parsed.token !== undefined) {
    const probe = await fetchWithTimeout(`${base}/v1/runs?limit=1`, CONNECT_TIMEOUT_MS, {
      authorization: `Bearer ${parsed.token}`,
    })
    if (probe === undefined || probe.status === 401) {
      throw new UserError(`connect: token rejected by ${base} (401)`)
    }
  }

  const name = parsed.name ?? deriveName(meta?.name, url)
  if (!isValidEnvironmentName(name)) {
    throw new UserError(`connect: invalid environment name "${name}" (use [a-z0-9._-]+)`)
  }

  const file = loadFile()
  const existing = file.environments[name]
  if (existing !== undefined && existing.url !== base && parsed.force !== true) {
    throw new UserError(
      `connect: environment "${name}" already points at ${existing.url} — pass --force to repoint it at ${base}`,
    )
  }
  const entry: EnvironmentEntry = {
    url: base,
    ...(parsed.token !== undefined ? { token: parsed.token } : {}),
    ...(parsed.delegate === true ? { delegate: true } : {}),
  }
  file.environments[name] = entry
  if (parsed.use) file.active = name
  writeEnvironmentsFile(file)

  const serverName = meta?.name !== undefined ? ` (${meta.name})` : ''
  process.stdout.write(
    `vx-cloud: connected ${name} → ${base}${serverName}${parsed.use ? ' [active]' : ''}\n`,
  )
  return 0
}

export async function envCmd(args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case undefined:
    case 'ls':
      return await envLs()
    case 'use':
      return envUse(rest[0])
    case 'rm':
      return envRm(rest[0])
    default:
      throw new UserError(`env: unknown subcommand: ${sub} (expected ls | use <name> | rm <name>)`)
  }
}

interface LsRow {
  active: boolean
  name: string
  url: string
  delegate: boolean
  probe: Promise<{ up: boolean; name?: string }>
}

async function probeServer(base: string): Promise<{ up: boolean; name?: string }> {
  const [health, meta] = await Promise.all([
    fetchWithTimeout(`${base}/health`, LS_PROBE_TIMEOUT_MS),
    fetchMeta(base, LS_PROBE_TIMEOUT_MS),
  ])
  if (health === undefined || !health.ok) return { up: false }
  return { up: true, ...(meta?.name !== undefined ? { name: meta.name } : {}) }
}

async function envLs(): Promise<number> {
  const file = loadFile()
  const override = process.env['VX_CLOUD_ENV']
  const effectiveActive =
    override !== undefined && override !== '' ? override : (file.active ?? undefined)

  const rows: LsRow[] = []
  // The auto-detected local serve is part of the picture: a synthetic first
  // row, shown only when its advertisement is alive.
  const info = readServeInfo()
  if (info !== undefined && pidAlive(info.pid)) {
    rows.push({
      active: false,
      name: '(local)',
      url: info.origin,
      delegate: false,
      probe: probeServer(info.origin),
    })
  }
  for (const [name, entry] of Object.entries(file.environments).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    rows.push({
      active: name === effectiveActive,
      name,
      url: entry.url,
      delegate: entry.delegate === true,
      probe: probeServer(entry.url),
    })
  }

  if (rows.length === 0) {
    process.stdout.write(
      'vx-cloud: no environments — add one with `vx-cloud connect <url>`\n' +
        `  (file: ${environmentsPath()})\n`,
    )
    return 0
  }

  const probes = await Promise.all(rows.map((r) => r.probe))
  const nameW = Math.max(4, ...rows.map((r) => r.name.length))
  const urlW = Math.max(3, ...rows.map((r) => r.url.length))
  const lines = [`  ${'NAME'.padEnd(nameW)}  ${'URL'.padEnd(urlW)}  DELEGATE  STATUS`]
  rows.forEach((row, i) => {
    const probe = probes[i]!
    const status = probe.up
      ? `ok${probe.name !== undefined ? ` (${probe.name})` : ''}`
      : 'unreachable'
    lines.push(
      `${row.active ? '*' : ' '} ${row.name.padEnd(nameW)}  ${row.url.padEnd(urlW)}  ` +
        `${(row.delegate ? 'yes' : '').padEnd(8)}  ${status}`,
    )
  })
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

function envUse(name: string | undefined): number {
  if (name === undefined || name === '') throw new UserError('env use: <name> required')
  const file = loadFile()
  if (file.environments[name] === undefined) {
    throw new UserError(`env use: no environment named "${name}" (see vx-cloud env ls)`)
  }
  file.active = name
  writeEnvironmentsFile(file)
  process.stdout.write(`vx-cloud: active environment is now ${name}\n`)
  return 0
}

function envRm(name: string | undefined): number {
  if (name === undefined || name === '') throw new UserError('env rm: <name> required')
  const file = loadFile()
  if (file.environments[name] === undefined) {
    throw new UserError(`env rm: no environment named "${name}"`)
  }
  delete file.environments[name]
  if (file.active === name) delete file.active
  writeEnvironmentsFile(file)
  process.stdout.write(`vx-cloud: removed ${name}\n`)
  return 0
}

export function disconnectCmd(args: readonly string[]): number {
  if (args.length > 0) throw new UserError(`disconnect: unexpected argument: ${args[0]}`)
  const file = loadFile()
  if (file.active === undefined) {
    process.stdout.write('vx-cloud: no active environment\n')
    return 0
  }
  const was = file.active
  delete file.active
  writeEnvironmentsFile(file)
  process.stdout.write(
    `vx-cloud: disconnected from ${was} (environments kept — reconnect with \`vx-cloud env use ${was}\`)\n`,
  )
  return 0
}
