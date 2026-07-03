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
