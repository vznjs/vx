// A CI OIDC issuer for the tests: an issuer URL, its keys served without a
// network (or, for the container, on loopback), and tokens signed for any
// claims. GitHub's URL reads `repository` and `ref`; any other GitLab's
// `project_path` and `ref_path`.

import { exportJWK, generateKeyPair, type JWK, type JWTPayload, SignJWT } from 'jose'
import { parseTrust, type TrustRule } from '@vzn/vx-devtools'

export const GITHUB = 'https://token.actions.githubusercontent.com'
export const REPO = 'acme/app'

/** Trusts main's pushes of repository acme/app at `iss`. */
export function trustOf(iss: string = GITHUB): TrustRule[] {
  const github = iss === GITHUB
  return parseTrust(
    JSON.stringify([
      {
        iss,
        [github ? 'repository' : 'project_path']: REPO,
        [github ? 'event_name' : 'pipeline_source']: 'push',
        [github ? 'ref' : 'ref_path']: 'refs/heads/main',
      },
    ]),
  )
}

export interface Issuer {
  readonly iss: string
  readonly jwks: { keys: JWK[] }
  /** Serves the issuer's discovery document and keys, as `OidcOptions.fetchJson`. */
  fetchJson(url: string): Promise<unknown>
  /** A token of repository acme/app for `aud`: of main, of `feature`, or reading only. */
  sign(job: 'main' | 'branch' | 'read', aud: string, extra?: JWTPayload): Promise<string>
}

export async function issuer(iss: string = GITHUB): Promise<Issuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] }
  const github = iss === GITHUB
  const claims = (ref: string, push: boolean): JWTPayload =>
    github
      ? { repository: REPO, ref, event_name: push ? 'push' : 'workflow_dispatch' }
      : { project_path: REPO, ref_path: ref, pipeline_source: push ? 'push' : 'web' }
  const jobs = {
    main: claims('refs/heads/main', true),
    branch: claims('refs/heads/feature', true),
    read: claims('refs/heads/main', false),
  }
  return {
    iss,
    jwks,
    fetchJson: async (url) =>
      url.endsWith('/.well-known/openid-configuration') ? { jwks_uri: `${iss}/keys` } : jwks,
    sign: (job, aud, extra = {}) =>
      new SignJWT({ ...jobs[job], ...extra })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(iss)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey),
  }
}
