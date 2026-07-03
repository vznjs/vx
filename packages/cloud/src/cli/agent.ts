// `vx-cloud agent` — attach this machine's checkout to a serve's session
// registry and execute assigned tasks via scoped core runs (the thin verb
// over dist/agent-loop.ts; distributed-execution-2026-07 §8.2). Replaces
// the retired cache-blind `worker` verb.
//
// Exit 0 on clean drain EVEN WHEN TASKS FAILED — the main job is the
// single authority on the run's verdict; a red matrix row means infra
// misconfiguration (refusal, dirty tree, unexpected disconnect), not a
// failing test.

import { captureGitContext, captureWorkspaceIdentity, findWorkspaceRoot, UserError } from '@vzn/vx'
import { runAgentLoop } from '../dist/agent-loop.js'
import { deriveSession } from '../dist/session.js'
import { readServeInfo } from '../serve-info.js'

export interface AgentArgs {
  url?: string
  token?: string
  capacity: number
  session?: string
  idleTimeoutMs: number
  labels: string[]
}

export const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000

export function parseAgentArgs(args: readonly string[]): AgentArgs {
  const out: AgentArgs = { capacity: 1, idleTimeoutMs: DEFAULT_AGENT_IDLE_TIMEOUT_MS, labels: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--url' || a === '--coordinator') {
      const v = args[++i]
      if (!v) throw new UserError(`vx-cloud agent: ${a} requires a serve URL`)
      out.url = v
    } else if (a === '--token') {
      const v = args[++i]
      if (!v) throw new UserError('vx-cloud agent: --token requires a value')
      out.token = v
    } else if (a === '--capacity') {
      const v = Number(args[++i])
      if (!Number.isInteger(v) || v < 1) {
        throw new UserError('vx-cloud agent: --capacity must be a positive integer')
      }
      out.capacity = v
    } else if (a === '--session') {
      const v = args[++i]
      if (!v) throw new UserError('vx-cloud agent: --session requires a value')
      out.session = v
    } else if (a === '--idle-timeout') {
      const v = Number(args[++i])
      if (!Number.isInteger(v) || v < 0) {
        throw new UserError('vx-cloud agent: --idle-timeout must be a non-negative ms count')
      }
      out.idleTimeoutMs = v
    } else if (a === '--label') {
      const v = args[++i]
      if (!v) throw new UserError('vx-cloud agent: --label requires a value')
      out.labels.push(v)
    } else {
      throw new UserError(`vx-cloud agent: unknown flag ${a}`)
    }
  }
  return out
}

function worktreeStatus(root: string): string[] {
  const proc = Bun.spawnSync({
    cmd: ['git', '-C', root, 'status', '--porcelain'],
    stdout: 'pipe',
    stderr: 'ignore',
  })
  if (proc.exitCode !== 0) {
    throw new UserError('vx-cloud agent requires a git checkout (git status failed)')
  }
  return new TextDecoder()
    .decode(proc.stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

export async function agentCmd(args: readonly string[]): Promise<number> {
  const parsed = parseAgentArgs(args)

  const origin = parsed.url ?? process.env['VX_SERVICE_URL'] ?? readServeInfo()?.origin
  if (origin === undefined || origin === '') {
    throw new UserError('vx-cloud agent: no serve URL — pass --url <origin> (or VX_SERVICE_URL)')
  }
  const token =
    parsed.token ??
    (process.env['VX_CLOUD_TOKEN'] !== undefined && process.env['VX_CLOUD_TOKEN'] !== ''
      ? process.env['VX_CLOUD_TOKEN']
      : undefined)

  const root = await findWorkspaceRoot(process.cwd())

  // Divergent keys from dirty inputs would silently split the cache — a
  // dirty agent refuses to start rather than poison the session.
  const dirty = worktreeStatus(root)
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 5).join('\n  ')
    const more = dirty.length > 5 ? `\n  … +${dirty.length - 5} more` : ''
    process.stderr.write(
      `vx-cloud agent: refusing to start on a DIRTY worktree — agents must share the exact commit\n  ${shown}${more}\n`,
    )
    return 1
  }

  const git = captureGitContext(root, false)
  if (git.commitSha === null) {
    throw new UserError('vx-cloud agent requires a git checkout with at least one commit')
  }
  const identity = captureWorkspaceIdentity(root)
  const session = parsed.session ?? deriveSession()

  // The scoped runs' remote layer is wired through the environment: point
  // core's env fallback at the serve's own /v8 artifact store (§6.2). An
  // explicit VX_REMOTE_CACHE_* always wins. The '-' token is a dummy
  // bearer for an open (token-less) serve — core requires both vars set.
  process.env['VX_REMOTE_CACHE_URL'] ??= origin
  process.env['VX_REMOTE_CACHE_TOKEN'] ??= token ?? '-'
  // Sentinel: cloud()'s telemetry rung declines so per-assignment scoped
  // runs don't spam the ingest store with 1-task invocations.
  process.env['VX_CLOUD_AGENT'] = '1'

  process.stdout.write(
    `vx agent: serve   ${origin}\n` +
      `vx agent: session ${identity.id}/${session}  commit ${git.commitSha.slice(0, 12)}\n` +
      `vx agent: cap=${parsed.capacity}` +
      (parsed.labels.length > 0 ? ` labels=[${parsed.labels.join(',')}]` : '') +
      `\n(press Ctrl-C to stop)\n\n`,
  )

  const loop = runAgentLoop({
    origin,
    ...(token !== undefined ? { token } : {}),
    workspaceId: identity.id,
    session,
    commitSha: git.commitSha,
    capacity: parsed.capacity,
    checkoutRoot: root,
    ...(parsed.labels.length > 0 ? { labels: parsed.labels } : {}),
    ...(parsed.idleTimeoutMs > 0 ? { idleTimeoutMs: parsed.idleTimeoutMs } : {}),
    onStatus: (line) => process.stdout.write(`  ${line}\n`),
  })

  const onSignal = (): void => loop.stop()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const result = await loop.done
  process.removeListener('SIGINT', onSignal)
  process.removeListener('SIGTERM', onSignal)
  process.stdout.write(`\nvx agent: ${result.reason}\n`)
  return result.ok ? 0 : 1
}
