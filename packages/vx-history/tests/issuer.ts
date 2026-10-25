// A GitHub OIDC issuer for the tests: its keys served without a network,
// and tokens of repository 42 signed for any job. Its own, not the
// server's test helper: a package that lints this one's tests through its
// node_modules link cannot reach a sibling's tests (vx-bench).

import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { parseTrust, type TrustRule } from '@vzn/vx-devtools'

const ISS = 'https://token.actions.githubusercontent.com'
const REPO = '42'

/** Trusts main's pushes of repository 42. */
export function trustOf(): TrustRule[] {
  return parseTrust(
    JSON.stringify([{ iss: ISS, repository: REPO, event_name: 'push', ref: 'refs/heads/main' }]),
  )
}

export interface Issuer {
  /** Serves the issuer's discovery document and keys, as `OidcOptions.fetchJson`. */
  fetchJson(url: string): Promise<unknown>
  /** A token of repository 42 for `aud`: of main, or reading only. */
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
        ref: 'refs/heads/main',
        event_name: job === 'main' ? 'push' : 'workflow_dispatch',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISS)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey),
  }
}
