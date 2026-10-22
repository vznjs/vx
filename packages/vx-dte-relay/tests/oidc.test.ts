import { describe, expect, it } from 'bun:test'
import { createVerifier, repositoryClaimOf, runClaimsOf, TokenError } from '../src/index.js'

const ISS = 'https://gitlab.example'
const AUD = 'https://relay.example'

const pair = (await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair
const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')

async function sign(claims: Record<string, unknown>, header: object = {}): Promise<string> {
  const head = `${b64({ alg: 'RS256', kid: 'k1', ...header })}.${b64(claims)}`
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(head))
  return `${head}.${Buffer.from(sig).toString('base64url')}`
}

const now = 1_800_000_000
const good = {
  iss: ISS,
  aud: AUD,
  exp: now + 300,
  project_id: 7,
  project_path: 'group/app',
  pipeline_id: '42',
}

function verifier(fetched: string[] = []) {
  return createVerifier({
    issuers: [ISS],
    audience: AUD,
    repositories: ['Group/App', 'group/other'],
    now: () => now,
    fetchJson: async (url) => {
      fetched.push(url)
      if (url === `${ISS}/.well-known/openid-configuration`) return { jwks_uri: `${ISS}/jwks` }
      if (url === `${ISS}/jwks`) return { keys: [{ ...jwk, kid: 'k1' }] }
      throw new Error(`unexpected ${url}`)
    },
  })
}

async function refusal(p: Promise<unknown>): Promise<[number, string]> {
  try {
    await p
  } catch (err) {
    if (err instanceof TokenError) return [err.status, err.message]
    throw err
  }
  throw new Error('accepted')
}

describe('a CI OIDC token', () => {
  it('is accepted with its run claims, reading the keys once', async () => {
    const fetched: string[] = []
    const verify = verifier(fetched)
    expect(await verify(await sign(good))).toEqual({ iss: ISS, run: ['7'] })
    await verify(await sign(good))
    expect(fetched).toEqual([`${ISS}/.well-known/openid-configuration`, `${ISS}/jwks`])
  })

  it('is refused for what is wrong with it', async () => {
    const verify = verifier()
    const other = { ...good, iss: 'https://evil.example' }
    expect(await refusal(verify('a.b'))).toEqual([401, 'not a JWT'])
    const unsigned = (await sign(good)).split('.').slice(0, 2).join('.')
    expect(await refusal(verify(`${unsigned}.!!`))).toEqual([401, 'not a JWT'])
    expect(await refusal(verify(await sign(good, { alg: 'none' })))).toEqual([
      401,
      'alg is not RS256',
    ])
    expect(await refusal(verify(await sign(other)))).toEqual([401, 'untrusted issuer'])
    expect(await refusal(verify(await sign(good, { kid: 'k2' })))).toEqual([
      401,
      'unknown signing key',
    ])
    expect(await refusal(verify(await sign({ ...good, aud: 'x' })))).toEqual([
      401,
      'wrong audience',
    ])
    expect(await refusal(verify(await sign({ ...good, exp: now - 61 })))).toEqual([401, 'expired'])
    expect(await refusal(verify(await sign({ ...good, nbf: now + 61 })))).toEqual([
      401,
      'not yet valid',
    ])
    expect(await refusal(verify(await sign({ ...good, project_id: undefined })))).toEqual([
      403,
      'no project_id claim',
    ])
    const [h, p] = (await sign(good)).split('.')
    const forged = `${h}.${b64({ ...good, pipeline_id: '43' })}.${(await sign(good)).split('.')[2]}`
    expect(p).not.toBe(forged.split('.')[1])
    expect(await refusal(verify(forged))).toEqual([401, 'bad signature'])
  })

  it('is refused unless its repository is one the relay names', async () => {
    const verify = verifier()
    expect(await verify(await sign({ ...good, project_path: 'group/other' }))).toEqual({
      iss: ISS,
      run: ['7'],
    })
    expect(await refusal(verify(await sign({ ...good, project_path: 'group/app2' })))).toEqual([
      403,
      'repository group/app2 is not one this relay serves',
    ])
    expect(await refusal(verify(await sign({ ...good, project_path: 'group' })))).toEqual([
      403,
      'repository group is not one this relay serves',
    ])
    expect(await refusal(verify(await sign({ ...good, project_path: undefined })))).toEqual([
      403,
      'no project_path claim',
    ])
  })

  it('is read without Node’s Buffer, which a Worker has not', async () => {
    const verify = verifier()
    const token = await sign(good)
    const buffer = globalThis.Buffer
    // @ts-expect-error: a Worker without nodejs_compat
    delete globalThis.Buffer
    try {
      expect(await verify(token)).toEqual({ iss: ISS, run: ['7'] })
    } finally {
      globalThis.Buffer = buffer
    }
  })

  it('binds a run to its repository by its issuer', () => {
    expect(runClaimsOf('https://token.actions.githubusercontent.com')).toEqual(['repository_id'])
    expect(runClaimsOf('https://gitlab.com')).toEqual(['project_id'])
    expect(repositoryClaimOf('https://token.actions.githubusercontent.com')).toBe('repository')
    expect(repositoryClaimOf('https://gitlab.com')).toBe('project_path')
  })
})
