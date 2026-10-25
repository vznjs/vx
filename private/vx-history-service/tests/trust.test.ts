// wrangler.jsonc's TRUST, as GitHub's tokens meet it: only ci.yml's runs
// of main write main's scope, and a branch writes its own.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, expect, it } from 'bun:test'
import { hashPart, oidcAuth, parseTrust } from '@vzn/vx-devtools'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'

const GITHUB = 'https://token.actions.githubusercontent.com'
const AUD = 'https://vx-history.exelord.workers.dev'
const config = Bun.JSONC.parse(
  readFileSync(path.join(import.meta.dir, '..', 'wrangler.jsonc'), 'utf8'),
) as { vars: { TRUST: string } }

let access: (claims: JWTPayload) => Promise<string | undefined>

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
  const auth = oidcAuth({
    trust: parseTrust(config.vars.TRUST),
    audience: AUD,
    fetchJson: async (url) =>
      url.endsWith('/.well-known/openid-configuration')
        ? { jwks_uri: `${GITHUB}/keys` }
        : { keys: [jwk] },
  })
  access = async (claims) => {
    const token = await new SignJWT({
      repository: 'vznjs/vx',
      ref_protected: 'false',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(GITHUB)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const req = new Request(`${AUD}/v1/timings/query`, {
      headers: {
        authorization: `Bearer ${token}`,
        // What .vx/workspace.ts names: our repository at GitHub, hashed.
        'vx-issuer': await hashPart(GITHUB),
        'vx-repository': await hashPart('vznjs/vx'),
      },
    })
    return (await auth(req)).write
  }
})

const CI = 'vznjs/vx/.github/workflows/ci.yml@refs/heads/main'

it("writes main from ci.yml's push to main, and a branch's own scope from its PR", async () => {
  const main = { workflow_ref: CI, ref: 'refs/heads/main', ref_protected: 'true' }
  expect(await access({ ...main, event_name: 'push' })).toBe('refs/heads/main')
  // A dispatched run of main (a cold run) runs main's code: it writes too.
  expect(await access({ ...main, event_name: 'workflow_dispatch' })).toBe('refs/heads/main')
  expect(
    await access({
      workflow_ref: 'vznjs/vx/.github/workflows/ci.yml@refs/pull/7/merge',
      event_name: 'pull_request',
      ref: 'refs/pull/7/merge',
      head_ref: 'feat',
    }),
  ).toBe('refs/heads/feat')
  // A worker dispatched on main may run a fork PR's code: it reads only.
  const worker = {
    ...main,
    workflow_ref: 'vznjs/vx/.github/workflows/vx-worker.yml@refs/heads/main',
  }
  expect(await access({ ...worker, event_name: 'workflow_dispatch' })).toBeUndefined()
  expect(await access({ ...main, event_name: 'pull_request_target' })).toBeUndefined()
})
