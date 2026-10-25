// A CI OIDC issuer for the tests: GitHub's issuer URL, its keys served
// without a network, and tokens signed for any claims.

import { exportJWK, generateKeyPair, type JWK, type JWTPayload, SignJWT } from 'jose'
import { parseTrust, type TrustRule } from '@vzn/vx-devtools'
import type { Job } from './conformance.js'

export const GITHUB = 'https://token.actions.githubusercontent.com'
export const REPO = '42'

/** Trusts main's pushes and its merge queue, of repository 42. */
export const TRUST: readonly TrustRule[] = parseTrust(
  JSON.stringify([
    {
      iss: GITHUB,
      repository_id: REPO,
      event_name: ['push', 'merge_group'],
      ref: ['refs/heads/main', 'refs/heads/gh-readonly-queue/main/*'],
    },
  ]),
)

/** Claims of a job that writes trusted: a push to main. */
export const TRUSTED_JOB = { ref: 'refs/heads/main', event_name: 'push' }
/** Claims of a job that only reads: a dispatch on main writes nowhere main reads. */
export const READ_JOB = { ref: 'refs/heads/main', event_name: 'workflow_dispatch' }
/** Claims of a job that writes its branch's scope. */
export const BRANCH_JOB = { ref: 'refs/heads/feature', event_name: 'push' }
/** Each job the conformance suite asks for, as GitHub's claims. */
export const JOBS: Record<Job, JWTPayload> = {
  trusted: TRUSTED_JOB,
  read: READ_JOB,
  branch: BRANCH_JOB,
  stranger: { ...TRUSTED_JOB, repository_id: '7' },
}

export interface Issuer {
  readonly jwks: { keys: JWK[] }
  /** Serves the issuer's discovery document and keys, as `OidcOptions.fetchJson`. */
  fetchJson(url: string): Promise<unknown>
  /** A token of repository 42 (unless `claims` names another) for `aud`. */
  sign(claims: JWTPayload, aud: string, lifetime?: string): Promise<string>
}

export async function issuer(): Promise<Issuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] }
  return {
    jwks,
    fetchJson: async (url) =>
      url.endsWith('/.well-known/openid-configuration') ? { jwks_uri: `${GITHUB}/keys` } : jwks,
    sign: (claims, aud, lifetime = '1h') =>
      new SignJWT({ repository_id: REPO, ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(GITHUB)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(lifetime)
        .sign(privateKey),
  }
}
