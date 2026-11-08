// A server that echoes the request's Authorization header in its refusal:
// core masks only secret-named env vars, so the job's OIDC token and a
// lent one reached the terminal and cache.db whole.
import { expect, it } from 'bun:test'
import { VxCacheLayer } from '../src/index.js'

const JWT = 'eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.SIGNATUREJWTSECRETPART'
const LENT = 'lent-token-0123456789abcdef'
const ASK = 'actions-request-token-0123456789'
const HASH = 'a'.repeat(32)

/** Every answer quotes the header it got, after `pad` (a long one puts the token across the 200-character cut). */
function echoing(status: number, pad = '') {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input)
    const auth = new Headers(init?.headers).get('authorization')
    if (url.hostname === 'oidc.example') {
      if (status === 0) return Response.json({ message: `no: ${auth}` }, { status: 400 })
      return Response.json({ value: JWT })
    }
    return Response.json({ message: `${pad}bad auth: ${auth}` }, { status })
  }) as typeof fetch
}

function layer(fetchImpl: typeof fetch, lent?: string) {
  const c = new VxCacheLayer(
    {
      url: 'https://cache.example',
      timeoutMs: 5_000,
      uploadTimeoutMs: 5_000,
      headers: {},
      issuer: 'https://token.actions.githubusercontent.com',
      repository: 'acme/app',
    },
    fetchImpl,
    { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/t', ACTIONS_ID_TOKEN_REQUEST_TOKEN: ASK },
    async () => {},
  )
  c.refs = ['refs/heads/main']
  if (lent !== undefined) c.lent = () => lent
  return c
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

it("a refusal that quotes the job's OIDC token says ***", async () => {
  for (const status of [500, 401]) {
    const m = await said(layer(echoing(status)).hasMany([HASH]))
    expect(m).toStartWith(`HTTP ${status}: bad auth: Bearer ***`)
    hidden(m, JWT)
  }
  hidden(await said(layer(echoing(500)).get(HASH)), JWT)
  hidden(await said(layer(echoing(500)).put(HASH, new Blob(['x']), { durationMs: 1 })), JWT)
  // A write's 403 has its own words.
  hidden(await said(layer(echoing(403)).put(HASH, new Blob(['x']), { durationMs: 1 })), JWT)
})

it("a token across the refusal's 200-character cut leaves no part of it", async () => {
  hidden(await said(layer(echoing(500, 'x'.repeat(170))).hasMany([HASH])), JWT)
})

it('a lent token a refusal quotes says ***', async () => {
  hidden(await said(layer(echoing(500), LENT).hasMany([HASH])), LENT)
})

it("GitHub's refusal that quotes the request token says ***", async () => {
  hidden(await said(layer(echoing(0)).hasMany([HASH])), ASK)
})
