import { describe, expect, it } from 'bun:test'
import {
  createVerifier,
  parseAllow,
  repositoryClaimOf,
  runClaimsOf,
  TokenError,
} from '../src/index.js'

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
    allow: [
      { issuer: ISS, repository: 'Group/App' },
      { issuer: ISS, repository: 'group/other' },
    ],
    audience: AUD,
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
    expect(fetched).toEqual([`${ISS}/.well-known/openid-configuration`, `${ISS}/jwks`])
  })

  it('is refused unless its job is of a workflow the relay names for its repository', async () => {
    const GH = 'https://token.actions.githubusercontent.com'
    const verify = createVerifier({
      allow: parseAllow(
        `${GH}:Org/App:ci.yml ${GH}:org/other:deploy.yml ${ISS}:group/app:.gitlab-ci.yml`,
      ),
      audience: AUD,
      now: () => now,
      fetchJson: async (url) =>
        url.endsWith('/.well-known/openid-configuration')
          ? { jwks_uri: url.replace('/.well-known/openid-configuration', '/jwks') }
          : { keys: [{ ...jwk, kid: 'k1' }] },
    })
    const gh = { iss: GH, aud: AUD, exp: now + 300, repository_id: '5', repository: 'org/app' }
    const asked = async (claims: Record<string, unknown>) =>
      verify(await sign(claims)).then(
        () => 'ok',
        (e: TokenError) => e.message,
      )
    expect([
      await asked({ ...gh, job_workflow_ref: 'org/app/.github/workflows/ci.yml@refs/heads/main' }),
      await asked({
        ...gh,
        job_workflow_ref: 'org/app/.github/workflows/ci.yml@refs/pull/7/merge',
      }),
      await asked({ ...gh, job_workflow_ref: 'org/app/.github/workflows/evil.yml@refs/heads/x' }),
      // Another repository's workflow is not this one's.
      await asked({ ...gh, job_workflow_ref: 'org/app/.github/workflows/deploy.yml@refs/heads/x' }),
      await asked(gh),
      await asked({ ...gh, repository: 'org/third' }),
      await asked({
        ...good,
        ci_config_ref_uri: 'gitlab.example/group/app//.gitlab-ci.yml@refs/heads/main',
      }),
    ]).toEqual([
      'ok',
      'ok',
      "workflow org/app/.github/workflows/evil.yml is not in this relay's ALLOW",
      "workflow org/app/.github/workflows/deploy.yml is not in this relay's ALLOW",
      'no job_workflow_ref claim',
      "repository org/third is not in this relay's ALLOW",
      'ok',
    ])
  })

  // A loopback issuer ALLOW takes, as a container's tests run one: its
  // workflow claim names the host without http://, as GitLab's names it
  // without https://.
  it('is accepted from a loopback http issuer ALLOW names', async () => {
    const LOCAL = 'http://127.0.0.1:8080'
    const verify = createVerifier({
      allow: parseAllow(`${LOCAL}:group/app:.gitlab-ci.yml`),
      audience: AUD,
      now: () => now,
      fetchJson: async (url) =>
        url.endsWith('/.well-known/openid-configuration')
          ? { jwks_uri: `${LOCAL}/jwks` }
          : { keys: [{ ...jwk, kid: 'k1' }] },
    })
    const token = await sign({
      ...good,
      iss: LOCAL,
      ci_config_ref_uri: '127.0.0.1:8080/group/app//.gitlab-ci.yml@refs/heads/main',
    })
    expect(await verify(token)).toEqual({ iss: LOCAL, run: ['7'] })
  })

  // The claim was cut at its first `@`, so a workflow file named with one
  // (`ci@x.yml`) was refused whatever ALLOW said; an issuer written in ALLOW
  // with a trailing slash matched no token's iss, so it admitted nothing.
  it('is accepted for a workflow file whose name holds an @, and an issuer ALLOW ends with /', async () => {
    const GH = 'https://token.actions.githubusercontent.com'
    const verify = createVerifier({
      allow: parseAllow(`${GH}:org/app:ci@x.yml ${ISS}/:group/app:.gitlab-ci.yml`),
      audience: AUD,
      now: () => now,
      fetchJson: async (url) =>
        url.endsWith('/.well-known/openid-configuration')
          ? { jwks_uri: url.replace('/.well-known/openid-configuration', '/jwks') }
          : { keys: [{ ...jwk, kid: 'k1' }] },
    })
    const asked = async (claims: Record<string, unknown>) =>
      verify(await sign(claims)).then(
        () => 'ok',
        (e: TokenError) => e.message,
      )
    expect([
      await asked({
        iss: GH,
        aud: AUD,
        exp: now + 300,
        repository_id: '5',
        repository: 'org/app',
        job_workflow_ref: 'org/app/.github/workflows/ci@x.yml@refs/heads/main',
      }),
      await asked({
        ...good,
        ci_config_ref_uri: 'gitlab.example/group/app//.gitlab-ci.yml@refs/heads/main',
      }),
    ]).toEqual(['ok', 'ok'])
  })

  it('reads ALLOW’s entries from the right, since an issuer holds colons', () => {
    expect(
      parseAllow(
        ' https://gitlab.example:8443:group/sub/app:ci/main.yml\nhttps://x.dev:o/r:a.yml ',
      ),
    ).toEqual([
      {
        issuer: 'https://gitlab.example:8443',
        repository: 'group/sub/app',
        workflow: 'ci/main.yml',
      },
      { issuer: 'https://x.dev', repository: 'o/r', workflow: 'a.yml' },
    ])
    expect(() => parseAllow('vznjs/vx:ci.yml')).toThrow(
      'vznjs/vx:ci.yml is not issuer:owner/repo:workflow',
    )
    expect(() => parseAllow('https://x.dev:vx:ci.yml')).toThrow('is not issuer:owner/repo:workflow')
    // Well formed, so "is not issuer:owner/repo:workflow" sent its author to the wrong part.
    // One rule with @vzn/vx-devtools' parseAllow, which the cache and
    // history servers read ALLOW with: plain http only to 127.0.0.1's host,
    // where a server's own container tests run an issuer.
    for (const [bad, issuer] of [
      ['http://x.dev:o/r:ci.yml', 'http://x.dev'],
      ['http://127.0.0.1:80@x.example:o/r:ci.yml', 'http://127.0.0.1:80@x.example'],
      ['http://127.0.0.1.x.example:o/r:ci.yml', 'http://127.0.0.1.x.example'],
    ] as const)
      expect(() => parseAllow(bad)).toThrow(
        new Error(`${bad}: the issuer is https://, not ${issuer} (plain http only on 127.0.0.1)`),
      )
    expect(parseAllow('http://127.0.0.1:8080:o/r:ci.yml')).toEqual([
      { issuer: 'http://127.0.0.1:8080', repository: 'o/r', workflow: 'ci.yml' },
    ])
    expect(() => parseAllow('https://x.dev:o/r:a.yml,https://x.dev:o/s:a.yml')).toThrow(
      'entries are space separated',
    )
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
    expect(await refusal(verify(await sign(other)))).toEqual([
      401,
      "issuer https://evil.example is not in this relay's ALLOW: add issuer:owner/repo:workflow for it",
    ])
    expect(await refusal(verify(await sign(good, { kid: 'k2' })))).toEqual([
      401,
      'unknown signing key',
    ])
    expect(await refusal(verify(await sign({ ...good, aud: 'x' })))).toEqual([
      401,
      `the token's aud is x, not this relay's ${AUD}: ask CI for a token for ${AUD}, or set the relay's audience`,
    ])
    expect(await refusal(verify(await sign({ ...good, exp: now - 61 })))).toEqual([401, 'expired'])
    // A token with no exp never expired: it lacks the claim.
    expect(await refusal(verify(await sign({ ...good, exp: undefined })))).toEqual([
      401,
      'no exp claim',
    ])
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

  // A worker test's unsigned token fetched gitlab.com's keys once jose
  // checked tokens (main, 2026-10-22): anyone could make the relay fetch.
  // vx-dte ends its run on a 401 and retries a 5xx: an issuer's outage
  // during a join or rejoin ended the run.
  it("answers 502 while the issuer's keys cannot be read, never 401", async () => {
    for (const down of ['/.well-known/openid-configuration', '/jwks']) {
      const verify = createVerifier({
        allow: [{ issuer: ISS }],
        audience: AUD,
        now: () => now,
        fetchJson: async (url) => {
          if (url.endsWith(down)) throw new Error(`${url}: 503`)
          return { jwks_uri: `${ISS}/jwks` }
        },
      })
      // The cause is said: an operator could not tell a 503 from a missing jwks_uri.
      expect(await refusal(verify(await sign(good)))).toEqual([
        502,
        `could not read ${ISS}'s keys: ${ISS}${down}: 503`,
      ])
    }
  })

  // The keys were read once per process: a key the issuer withdrew (a leak,
  // a rotation) still signed a token the relay took, until it restarted.
  it('is refused once its issuer withdraws its key, read again after ten minutes', async () => {
    let t = now
    let served = [{ ...jwk, kid: 'k1' }]
    const fetched: string[] = []
    const verify = createVerifier({
      allow: [{ issuer: ISS }],
      audience: AUD,
      now: () => t,
      fetchJson: async (url) => {
        fetched.push(url)
        return url.endsWith('/jwks') ? { keys: served } : { jwks_uri: `${ISS}/jwks` }
      },
    })
    const token = (exp: number) => sign({ ...good, exp })
    expect(await verify(await token(t + 900))).toEqual({ iss: ISS, run: ['7'] })
    served = []
    t += 599
    expect(await verify(await token(t + 300))).toEqual({ iss: ISS, run: ['7'] })
    expect(fetched).toHaveLength(2)
    t += 1
    expect(await refusal(verify(await token(t + 300)))).toEqual([401, 'unknown signing key'])
    expect(fetched).toHaveLength(4)
  })

  it('is refused before any key fetch when it carries no signature or another alg', async () => {
    const fetched: string[] = []
    const verify = verifier(fetched)
    const [h, p] = (await sign(good)).split('.')
    expect(await refusal(verify(`${h}.${p}.x`))).toEqual([401, 'not a JWT'])
    expect(await refusal(verify(`${h}.${p}.`))).toEqual([401, 'not a JWT'])
    // A header that does not decode: decodeJwt reads only the payload, and
    // the header's throw left the relay as a 500.
    const sig = (await sign(good)).split('.')[2]
    expect(await refusal(verify(`!!.${p}.${sig}`))).toEqual([401, 'not a JWT'])
    expect(await refusal(verify(`${b64('x')}.${p}.${sig}`))).toEqual([401, 'not a JWT'])
    expect(await refusal(verify(await sign(good, { alg: 'HS256' })))).toEqual([
      401,
      'alg is not RS256',
    ])
    expect(fetched).toEqual([])
  })

  it('is refused unless its repository is one the relay names', async () => {
    const verify = verifier()
    expect(await verify(await sign({ ...good, project_path: 'group/other' }))).toEqual({
      iss: ISS,
      run: ['7'],
    })
    expect(await refusal(verify(await sign({ ...good, project_path: 'group/app2' })))).toEqual([
      403,
      "repository group/app2 is not in this relay's ALLOW",
    ])
    expect(await refusal(verify(await sign({ ...good, project_path: 'group' })))).toEqual([
      403,
      "repository group is not in this relay's ALLOW",
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
