// `vx-cloud status` — the connection doctor. One screen that surfaces the
// three SILENT failure modes the never-fail clients hide by design:
//   1. connected but tokenless on an account platform → every push 401s
//      quietly (dashboard stays empty, cache never hits);
//   2. VX_CLOUD_DISTRIBUTE set but the workspace never declares cloud() →
//      the env var is read by nobody and runs stay local;
//   3. a connection resolved but the server is unreachable / the token is
//      rejected → ingest and cache degrade to no-ops.
// Read-only: a few bounded probes, nothing persisted, always exits 0.

import {
  UserError,
  captureWorkspaceIdentity,
  findWorkspaceRoot,
  loadWorkspaceConfig,
} from '@vzn/vx'
import { activeEnvironment, environmentsPath } from '../environments.js'

const PROBE_TIMEOUT_MS = 2000

async function fetchWithTimeout(
  url: string,
  headers?: Record<string, string>,
): Promise<Response | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    return await fetch(url, { signal: controller.signal, ...(headers ? { headers } : {}) })
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

const firstEnv = (...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = process.env[k]
    if (v !== undefined && v !== '') return v
  }
  return undefined
}

interface ResolvedStatusConnection {
  url: string
  token?: string
  source: string
}

/** Mirror of the plugin's connection ladder (explicit env > active environment). */
function resolveStatusConnection(): ResolvedStatusConnection | undefined {
  const explicitUrl = firstEnv(
    'VX_CLOUD_URL',
    'VX_SERVICE_URL',
    'VX_CLOUD_INGEST_URL',
    'VX_CLOUD_INSIGHTS_URL',
  )
  if (explicitUrl !== undefined) {
    const token = firstEnv('VX_CLOUD_TOKEN', 'VX_CLOUD_INGEST_TOKEN')
    return {
      url: explicitUrl.replace(/\/+$/, ''),
      source: 'env (VX_CLOUD_URL)',
      ...(token !== undefined ? { token } : {}),
    }
  }
  const env = activeEnvironment()
  if (env !== undefined) {
    return {
      url: env.url.replace(/\/+$/, ''),
      source: 'active environment',
      ...(env.token !== undefined ? { token: env.token } : {}),
    }
  }
  return undefined
}

/** Does the cwd workspace's vx.workspace.ts declare the cloud() plugin? */
async function workspaceDeclaresCloud(root: string): Promise<boolean | undefined> {
  try {
    const config = await loadWorkspaceConfig(root)
    const plugins = (config as { plugins?: Array<{ name?: unknown }> } | undefined)?.plugins
    if (!Array.isArray(plugins)) return false
    return plugins.some((p) => p?.name === 'vzn/cloud')
  } catch {
    return undefined // broken/absent workspace config — reported as unknown
  }
}

export async function statusCmd(args: readonly string[]): Promise<number> {
  if (args.length > 0) throw new UserError(`status: unexpected argument: ${args[0]}`)

  const lines: string[] = []
  const row = (label: string, value: string) => lines.push(`${label.padEnd(14)}${value}`)

  // -- connection resolution -------------------------------------------------
  const conn = resolveStatusConnection()
  if (conn === undefined) {
    row('connection', `none — connect with \`vx-cloud connect <url>\` or set VX_CLOUD_URL`)
    row('file', environmentsPath())
  } else {
    row('connection', `${conn.url}  (${conn.source})`)
    row('token', conn.token !== undefined ? 'present' : 'NONE')
  }

  // -- server probes -----------------------------------------------------------
  let auth: string | undefined
  if (conn !== undefined) {
    const health = await fetchWithTimeout(`${conn.url}/health`)
    if (health === undefined || !health.ok) {
      row('server', 'UNREACHABLE — pushes, cache and distribution all degrade to no-ops')
    } else {
      const metaRes = await fetchWithTimeout(`${conn.url}/v1/meta`)
      let name = ''
      if (metaRes !== undefined && metaRes.ok) {
        try {
          const meta = (await metaRes.json()) as { name?: unknown; vx?: unknown; auth?: unknown }
          if (typeof meta.auth === 'string') auth = meta.auth
          name = [
            typeof meta.name === 'string' && meta.name !== '' ? meta.name : undefined,
            typeof meta.vx === 'string' ? `vx ${meta.vx}` : undefined,
            auth !== undefined ? `auth: ${auth}` : undefined,
          ]
            .filter((s) => s !== undefined)
            .join(' · ')
        } catch {
          // fall through with the bare ok
        }
      }
      row('server', `ok${name !== '' ? ` (${name})` : ''}`)

      // Authenticated probe — names the silent-401 mode precisely.
      if (conn.token !== undefined) {
        const probe = await fetchWithTimeout(`${conn.url}/v1/runs?limit=1`, {
          authorization: `Bearer ${conn.token}`,
        })
        row(
          'auth probe',
          probe === undefined
            ? 'unreachable'
            : probe.status === 401
              ? 'TOKEN REJECTED (401) — pushes are silently dropped; mint a new token'
              : 'ok',
        )
      } else if (auth === 'account') {
        row(
          'auth probe',
          'NO TOKEN on an account platform — run ingest + remote cache are OFF ' +
            '(mint one under Admin → Tokens, then `vx-cloud connect <url> --token vxc_…`)',
        )
      }
    }
  }

  // -- workspace ----------------------------------------------------------------
  let root: string | undefined
  try {
    root = await findWorkspaceRoot(process.cwd())
  } catch {
    // not inside a workspace — still useful as a pure connection check
  }
  const declaresCloud = root !== undefined ? await workspaceDeclaresCloud(root) : undefined
  if (root === undefined) {
    row('workspace', '(not inside a vx workspace)')
  } else {
    row(
      'workspace',
      `${root} · cloud() ${
        declaresCloud === true
          ? 'declared'
          : declaresCloud === false
            ? 'NOT declared — runs will not push here (add cloud() to vx.workspace.ts)'
            : 'unknown (workspace config failed to load)'
      }`,
    )
  }

  // -- distribution ---------------------------------------------------------------
  const distribute = process.env['VX_CLOUD_DISTRIBUTE']
  const envEntry = activeEnvironment()
  const ambient = envEntry?.distribute !== undefined && envEntry.distribute !== false
  if (distribute !== undefined && distribute !== '') {
    let note = `explicit (VX_CLOUD_DISTRIBUTE=${distribute})`
    if (declaresCloud === false) note += ' — IGNORED: the workspace never declares cloud()'
    row('distribution', note)
  } else if (ambient) {
    row('distribution', `ambient (environment policy: ${String(envEntry?.distribute)})`)
  } else {
    row('distribution', 'off')
  }
  if (
    (ambient || (distribute !== undefined && distribute !== '')) &&
    conn !== undefined &&
    root !== undefined
  ) {
    const session = firstEnv('VX_AGENT_SESSION') ?? 'local'
    const ws = captureWorkspaceIdentity(root).id
    const res = await fetchWithTimeout(
      `${conn.url}/v1/agents?ws=${encodeURIComponent(ws)}&session=${encodeURIComponent(session)}`,
      conn.token !== undefined ? { authorization: `Bearer ${conn.token}` } : undefined,
    )
    if (res !== undefined && res.ok) {
      try {
        const body = (await res.json()) as { remoteAgents?: unknown }
        const n = typeof body.remoteAgents === 'number' ? body.remoteAgents : 0
        row('agent pool', `${n} remote agent${n === 1 ? '' : 's'} (session ${session})`)
      } catch {
        row('agent pool', 'unreadable response')
      }
    } else {
      row('agent pool', res === undefined ? 'unreachable' : `probe failed (${res.status})`)
    }
  }

  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}
