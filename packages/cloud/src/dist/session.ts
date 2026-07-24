// Session-key derivation shared by the agent verb and the submitting
// backend (distributed-execution-2026-07 §5.1). The registry key is
// `{workspaceId, session}`, so the dev-machine default `'local'` is
// already scoped per workspace; CI keys fold the retry attempt where the
// provider exposes one (a re-run must not collide with its own ghost).

import { resolveCacheScope } from '@vzn/vx'
import { NativeCacheClient } from '../native-cache.js'

export function deriveSession(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['VX_AGENT_SESSION']
  if (explicit !== undefined && explicit !== '') return explicit
  const gh = env['GITHUB_RUN_ID']
  if (gh !== undefined && gh !== '') return `gh-${gh}-${env['GITHUB_RUN_ATTEMPT'] ?? '1'}`
  const gl = env['CI_PIPELINE_ID']
  if (gl !== undefined && gl !== '') return `gl-${gl}`
  const bk = env['BUILDKITE_BUILD_ID']
  if (bk !== undefined && bk !== '') return `bk-${bk}`
  return 'local'
}

/**
 * The remote-cache layer an agent's scoped core runs inject
 * (`RunOptions.remoteCache`) — a native-wire client pointed at the serve's
 * own `/v1/cache` artifact store. Shared by the `agent` verb and the
 * submitter's self-agent (universal-agents-2026-07 §C.3); explicit
 * injection replaces the retired `VX_REMOTE_CACHE_*` env wiring. The
 * per-PR sub-scope still comes from the process env (CI PR context).
 */
export function agentRemoteCache(origin: string, token: string | undefined): NativeCacheClient {
  const cacheScope = resolveCacheScope(process.env)
  return new NativeCacheClient({
    baseUrl: origin,
    ...(token !== undefined ? { token } : {}),
    ...(cacheScope !== undefined ? { cacheScope } : {}),
  })
}

/**
 * Flag the process as an agent so cloud()'s telemetry rung declines —
 * per-assignment 1-task runs must not spam the ingest store.
 */
export function markAgentProcess(): void {
  process.env['VX_CLOUD_AGENT'] = '1'
}
