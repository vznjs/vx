// `vx-cloud connect` / `env ls|use|rm` / `disconnect` — the client-side
// connection verbs over the per-user environments file (docker-context-style).
// `connect` is the handshake: validate reachability + identity + token BEFORE
// persisting anything; `env ls` is the one-command picture (named servers
// with live reachability probes). Connecting is the ONLY client↔serve wiring
// — a local serve is connected the same way (`vx-cloud connect
// http://localhost:4321`), never auto-detected.

import { parseDecimalInt, UserError } from '@vzn/vx'
import {
  ENVIRONMENTS_VERSION,
  environmentsPath,
  isValidEnvironmentName,
  readEnvironmentsFile,
  writeEnvironmentsFile,
  type EnvironmentEntry,
  type EnvironmentsFile,
} from '../environments.js'

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
  distribute?: number | boolean
  use: boolean
  force?: boolean
  anonymous?: boolean
  error?: string
}

export function parseConnectArgs(args: readonly string[]): ConnectArgs {
  const out: ConnectArgs = { use: true }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--anonymous') {
      out.anonymous = true
      continue
    }
    if (a === '--distribute') {
      out.distribute = true
      continue
    }
    if (a.startsWith('--distribute=')) {
      const v = a.slice('--distribute='.length)
      const n = parseDecimalInt(v)
      if (n === null || n < 1) {
        return { ...out, error: `invalid --distribute: ${v} (expected a positive integer)` }
      }
      out.distribute = n
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
    // Match on the flag NAME first. Reading the value into the same `undefined`
    // that means "not this flag" conflated the two: a TRAILING `--name` (value
    // omitted) consumed a non-existent argv slot, fell through, and reported
    // `unknown flag: --name` — false, since `--name` is very much known, and
    // silent about the real mistake. The `=` spelling of the same mistake
    // already said `invalid --name: empty`, so one omitted value got two
    // different diagnoses depending on how it was typed, one of them wrong.
    if (a === '--name' || a.startsWith('--name=')) {
      const nv = a === '--name' ? args[++i] : a.slice('--name='.length)
      if (nv === undefined || nv === '') return { ...out, error: 'invalid --name: empty' }
      out.name = nv
      continue
    }
    if (a === '--token' || a.startsWith('--token=')) {
      const tv = a === '--token' ? args[++i] : a.slice('--token='.length)
      if (tv === undefined || tv === '') return { ...out, error: 'invalid --token: empty' }
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
  // The platform's machine surfaces (ingest, remote cache, agents) all need a
  // `vxc_` API token; its telemetry/cache clients are never-fail by design, so
  // a tokenless connect would LOOK healthy while every push 401s silently —
  // "connected, but the dashboard stays empty and the cache never hits", with
  // no error anywhere. Refuse it up front unless explicitly opted into.
  if (meta?.auth === 'account' && parsed.token === undefined && parsed.anonymous !== true) {
    throw new UserError(
      `connect: ${base} is an account platform — machine pushes (run history, remote cache) need an API token.\n` +
        `Mint one under Admin → Tokens on ${base} and re-run with --token vxc_…\n` +
        `(--anonymous connects without one; ingest and cache will be off.)`,
    )
  }
  if (meta?.auth === 'account' && parsed.token === undefined && parsed.anonymous === true) {
    process.stderr.write(
      `vx-cloud: connecting to ${base} WITHOUT a token — run ingest and the remote cache will not work until one is added (--token)\n`,
    )
  }
  if (parsed.token !== undefined) {
    const probe = await fetchWithTimeout(`${base}/v1/runs?limit=1`, CONNECT_TIMEOUT_MS, {
      authorization: `Bearer ${parsed.token}`,
    })
    // 403 is a rejection too: the token authenticated but may not read here
    // (wrong scope / wrong workspace), and the machine clients are never-fail,
    // so persisting it produces exactly the silently-empty dashboard this
    // handshake exists to prevent. Only 401 was checked, so a wrong-scope token
    // was accepted and written to the file with exit 0.
    if (probe === undefined || probe.status === 401 || probe.status === 403) {
      const how = probe === undefined ? 'unreachable' : String(probe.status)
      throw new UserError(`connect: token rejected by ${base} (${how})`)
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
  // Re-connecting UPDATES what you asked for and keeps what you did not.
  // Building the entry from scratch silently destroyed every field the flags
  // did not repeat: rotating a token with `connect <same-url> --token new`
  // dropped `distribute` (ambient distribution silently off) and `prToken`
  // (the fork-PR token, which has NO flag at all — hand-editing the file was
  // the only way to set it, and the only way to get it back).
  //
  // Credentials are deliberately NOT carried across a `--force` repoint: they
  // belong to the server that issued them, and the handshake above only probes
  // a token passed on THIS invocation, so carrying one would persist a
  // credential this URL never validated.
  const carried = existing !== undefined && existing.url === base ? existing : undefined
  const entry: EnvironmentEntry = {
    ...carried,
    url: base,
    ...(parsed.token !== undefined ? { token: parsed.token } : {}),
    ...(parsed.distribute !== undefined ? { distribute: parsed.distribute } : {}),
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
  distribute: string
  probe: Promise<{ up: boolean; name?: string }>
}

/** Render an environment's `distribute` policy for the `env ls` column. */
function fmtDistribute(d: number | boolean | undefined): string {
  if (d === undefined || d === false) return ''
  return d === true ? 'yes' : String(d)
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
  for (const [name, entry] of Object.entries(file.environments).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    rows.push({
      active: name === effectiveActive,
      name,
      url: entry.url,
      distribute: fmtDistribute(entry.distribute),
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
  const lines = [`  ${'NAME'.padEnd(nameW)}  ${'URL'.padEnd(urlW)}  DISTRIBUTE  STATUS`]
  rows.forEach((row, i) => {
    const probe = probes[i]!
    const status = probe.up
      ? `ok${probe.name !== undefined ? ` (${probe.name})` : ''}`
      : 'unreachable'
    lines.push(
      `${row.active ? '*' : ' '} ${row.name.padEnd(nameW)}  ${row.url.padEnd(urlW)}  ` +
        `${row.distribute.padEnd(10)}  ${status}`,
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
