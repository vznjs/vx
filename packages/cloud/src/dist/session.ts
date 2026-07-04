// Session-key derivation shared by the agent verb and the submitting
// backend (distributed-execution-2026-07 §5.1). The registry key is
// `{workspaceId, session}`, so the dev-machine default `'local'` is
// already scoped per workspace; CI keys fold the retry attempt where the
// provider exposes one (a re-run must not collide with its own ghost).

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
 * Point an agent's scoped core runs at the serve's own `/v8` artifact store as
 * their remote cache layer, and flag the process as an agent (so cloud()'s
 * telemetry rung declines — per-assignment 1-task runs must not spam the ingest
 * store). Shared verbatim by the `agent` verb and the submitter's self-agent
 * (universal-agents-2026-07 §C.3). An explicit `VX_REMOTE_CACHE_*` always wins
 * (the `??=`); `'-'` is a dummy bearer for an open, token-less serve (core
 * requires both cache vars set).
 */
export function wireAgentCacheEnv(origin: string, token: string | undefined): void {
  process.env['VX_REMOTE_CACHE_URL'] ??= origin
  process.env['VX_REMOTE_CACHE_TOKEN'] ??= token ?? '-'
  process.env['VX_CLOUD_AGENT'] = '1'
}
