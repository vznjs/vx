// `github()`: agents as jobs of one workflow the run dispatches per wave
// (design dte-2026-10.md, "Adapters"): `workflow_dispatch` with the run,
// the relay, the commit, a size and the agents of that size, which the
// workflow runs as a matrix on the runners it names for the size. Agents
// prove themselves by their OIDC identity: the run makes no secret.

import { refuseUnknownOptions, UserError, type PluginOptionKinds } from '@vzn/vx'
import type { AgentSpawn, DteAdapter } from './plugin.js'

export interface GithubOptions {
  /** The agents' workflow file in `.github/workflows` (default `vx-agent.yml`). */
  readonly workflow?: string
}

const KEYS: PluginOptionKinds<GithubOptions> = { workflow: 'string' }

export function github(options: GithubOptions = {}): DteAdapter {
  refuseUnknownOptions('github()', options, KEYS)
  const workflow = options.workflow ?? 'vx-agent.yml'
  // The agents one demand starts, by size: one dispatch each.
  const waves = new Map<string, AgentSpawn[]>()
  const dispatch = async (size: string, agents: AgentSpawn[]): Promise<void> => {
    const env = process.env
    const { GITHUB_API_URL: api, GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token } = env
    if (!api || !repo || !token)
      throw new Error(
        'github(): dispatching agents needs GITHUB_TOKEN (actions: write) in a GitHub Actions job',
      )
    const ref = env['GITHUB_HEAD_REF'] || env['GITHUB_REF_NAME']
    const sha = env['GITHUB_SHA']
    const first = agents[0]!
    const res = await fetch(`${api}/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ref,
        inputs: {
          run: first.run,
          relay: first.relay,
          sha,
          size,
          agents: JSON.stringify(agents.map((a) => a.id)),
        },
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok)
      throw new Error(
        `github(): dispatching ${workflow}: ${res.status} ${(await res.text()).slice(0, 200)}`,
      )
  }
  return {
    keyless: true,
    spawn(a) {
      const wave = waves.get(a.size)
      if (wave !== undefined) {
        wave.push(a)
        return
      }
      const agents = [a]
      waves.set(a.size, agents)
      queueMicrotask(() => {
        waves.delete(a.size)
        dispatch(a.size, agents).catch((err: unknown) => {
          const why = err instanceof Error ? err.message : String(err)
          for (const x of agents) x.exited(why)
        })
      })
    },
  }
}

/** The relay token on GitHub Actions: an OIDC token for the relay's URL as audience. */
export async function githubRelayToken(relay: string): Promise<string | undefined> {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = process.env
  if (!url || !bearer) return undefined
  const res = await fetch(`${url}&audience=${encodeURIComponent(relay)}`, {
    headers: { authorization: `bearer ${bearer}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new UserError(`dte(): GitHub's OIDC token for the relay: ${res.status}`)
  return ((await res.json()) as { value: string }).value
}
