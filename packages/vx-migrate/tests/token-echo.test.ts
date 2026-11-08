// A server that quotes the request's Authorization header in its refusal:
// core masks only secret-named variables, so a token written in the
// workspace, an OIDC exchange's and GitHub's own reached the CI log and
// cache.db whole. Driven through a stub `fetch`: nothing binds a port.
import { expect, it } from 'bun:test'
import type { RemoteOpenContext } from '@vzn/vx'
import { NxRemoteCache, resolveNxCacheConfig } from '../src/nx-cache/index.js'
import { resolveTurboCacheConfig, TurboRemoteCache } from '../src/turbo-cache/index.js'

const TOKEN = 'workspace-token-0123456789'
const JWT = 'eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.SIGNATUREJWTSECRETPART'
const EXCHANGED = 'exchanged-token-0123456789'
const GH_ENV = {
  GITHUB_ACTIONS: 'true',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.example/idtoken',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gh-bearer-0123456789',
}

/** Each cache request answers `status`, quoting its header after 170 characters: the token crosses the 200-character cut. */
function echoing(status: number, exchange?: 'refuse') {
  return (async (url: string, init: RequestInit) => {
    const u = new URL(url)
    if (u.pathname === '/idtoken') return Response.json({ value: JWT })
    if (u.pathname.endsWith('/oauth/token')) {
      if (exchange === 'refuse') {
        const jwt = new URLSearchParams(init.body as string).get('subject_token')
        return Response.json(
          { error: 'invalid_grant', error_description: `bad ${jwt}` },
          { status: 400 },
        )
      }
      return Response.json({ access_token: EXCHANGED })
    }
    const auth = new Headers(init.headers).get('authorization')
    return Response.json({ message: `${'x'.repeat(170)} ${auth}` }, { status })
  }) as unknown as typeof fetch
}

const said = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'no refusal',
    (err: unknown) => (err as Error).message,
  )

/** No token, nor any 8 characters of one, is in `message`. */
function hidden(message: string, token: string): void {
  expect(message).toContain('***')
  for (let i = 0; i + 8 <= token.length; i++) expect(message).not.toContain(token.slice(i, i + 8))
}

const open: RemoteOpenContext = {
  ci: true,
  warn: () => {},
  async secret() {
    throw new Error('none')
  },
  async forgetSecret() {},
}

const turbo = (fetchImpl: typeof fetch, oidc = false) =>
  new TurboRemoteCache(
    resolveTurboCacheConfig(
      oidc ? { teamSlug: 'acme', oidc: true } : { teamSlug: 'acme', token: TOKEN },
      oidc ? GH_ENV : {},
      {},
      {},
    )!,
    fetchImpl,
    undefined,
    async () => {},
  )

it('turboCache(): a refusal that quotes the token says ***', async () => {
  for (const status of [500, 401]) {
    const c = turbo(echoing(status))
    await c.open(open)
    hidden(await said(c.get('aa11')), TOKEN)
  }
  const c = turbo(echoing(500))
  await c.open(open)
  hidden(await said(c.put('aa11', new Blob(['x']), { durationMs: 1 })), TOKEN)
})

it("turboCache({ oidc }): the exchanged token and GitHub's say ***", async () => {
  const c = turbo(echoing(500), true)
  await c.open(open)
  hidden(await said(c.get('aa11')), EXCHANGED)
  hidden(await said(turbo(echoing(500, 'refuse'), true).open(open)), JWT)
})

it('nxCache(): a refusal that quotes the token says ***', async () => {
  for (const status of [500, 401]) {
    const c = new NxRemoteCache(
      resolveNxCacheConfig({ url: 'https://nx.example', token: TOKEN }, {})!,
      echoing(status),
      async () => {},
    )
    hidden(await said(c.get('aa11')), TOKEN)
  }
})
