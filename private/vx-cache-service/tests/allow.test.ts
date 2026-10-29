// wrangler.jsonc's ALLOW, as GitHub's tokens meet it: ci.yml's runs of
// main write main's scope, a branch its own, and no other workflow's job
// gets in.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, expect, it } from 'bun:test'
import { hashPart, oidcAuth, parseAllow } from '@vzn/vx-devtools'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'

const GITHUB = 'https://token.actions.githubusercontent.com'
const AUD = 'https://vx-cache.exelord.workers.dev'
const config = Bun.JSONC.parse(
  readFileSync(path.join(import.meta.dir, '..', 'wrangler.jsonc'), 'utf8'),
) as { vars: { ALLOW: string } }

let access: (claims: JWTPayload) => Promise<string | undefined | number>

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
  const auth = oidcAuth({
    allow: parseAllow(config.vars.ALLOW),
    audience: AUD,
    fetchJson: async (url) =>
      url.endsWith('/.well-known/openid-configuration')
        ? { jwks_uri: `${GITHUB}/keys` }
        : { keys: [jwk] },
  })
  access = async (claims) => {
    const token = await new SignJWT({
      repository: 'vznjs/vx',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(GITHUB)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const req = new Request(`${AUD}/v1/artifacts`, {
      headers: {
        authorization: `Bearer ${token}`,
        // What .vx/workspace.ts names: our repository at GitHub, hashed.
        'vx-issuer': await hashPart(GITHUB),
        'vx-repository': await hashPart('vznjs/vx'),
      },
    })
    return auth(req).then(
      (a) => a.write,
      (err: { status: number }) => err.status,
    )
  }
})

const CI = 'vznjs/vx/.github/workflows/ci.yml@refs/heads/main'

it("writes main from ci.yml's push to main, and a PR's merge ref, never its head_ref", async () => {
  const main = { job_workflow_ref: CI, ref: 'refs/heads/main' }
  expect(await access({ ...main, event_name: 'push' })).toBe('refs/heads/main')
  // A dispatched run of main (a cold run) runs main's code, and its
  // workers hand their outputs back through the cache, so it writes too.
  expect(await access({ ...main, event_name: 'workflow_dispatch' })).toBe('refs/heads/main')
  expect(
    await access({
      job_workflow_ref: 'vznjs/vx/.github/workflows/ci.yml@refs/pull/7/merge',
      event_name: 'pull_request',
      ref: 'refs/pull/7/merge',
      head_ref: 'feat',
    }),
  ).toBe('refs/pull/7/merge')
  // A worker dispatched on main may run a fork PR's code: its own token
  // is refused, and it writes only with the token its run lends it.
  const worker = {
    ...main,
    job_workflow_ref: 'vznjs/vx/.github/workflows/vx-worker.yml@refs/heads/main',
  }
  expect(await access({ ...worker, event_name: 'workflow_dispatch' })).toBe(403)
  expect(await access({ ...main, event_name: 'pull_request_target' })).toBeUndefined()
})
