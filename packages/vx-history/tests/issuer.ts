// A GitHub OIDC issuer for the tests: its keys served without a network,
// and tokens of acme/app signed for any job. Its own, not the
// server's test helper: a package that lints this one's tests through its
// node_modules link cannot reach a sibling's tests (vx-bench).

import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { type Allowed, parseAllow } from '@vzn/vx-devtools'

const ISS = 'https://token.actions.githubusercontent.com'
const REPO = 'acme/app'
/** The repository the server's ALLOW names, as a workspace names it. */
export const NAMED = { issuer: ISS, repository: REPO }

/** Admits the jobs of acme/app's ci.yml. */
export function allowOf(): Allowed[] {
  return parseAllow(`${ISS}:${REPO}:ci.yml`)
}

export interface Issuer {
  /** Serves the issuer's discovery document and keys, as `OidcOptions.fetchJson`. */
  fetchJson(url: string): Promise<unknown>
  /** A token of acme/app for `aud`: of main, or reading only. */
  sign(job: 'main' | 'read', aud: string): Promise<string>
}

export async function issuer(): Promise<Issuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] }
  return {
    fetchJson: async (url) =>
      url.endsWith('/.well-known/openid-configuration') ? { jwks_uri: `${ISS}/keys` } : jwks,
    sign: (job, aud) =>
      new SignJWT({
        repository: REPO,
        job_workflow_ref: `${REPO}/.github/workflows/ci.yml@refs/heads/main`,
        ref: 'refs/heads/main',
        // A pull_request_target run writes nothing.
        event_name: job === 'main' ? 'push' : 'pull_request_target',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISS)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey),
  }
}
