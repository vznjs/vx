// A CI OIDC issuer for the tests: an issuer URL, its keys served without a
// network (or, for the container, on loopback), and tokens signed for any
// claims. GitHub's URL reads `repository`, `job_workflow_ref` and `ref`;
// any other GitLab's `project_path`, `ci_config_ref_uri` and `ref_path`.

import { exportJWK, generateKeyPair, type JWK, type JWTPayload, SignJWT } from 'jose'
import { type Allowed, parseAllow } from '@vzn/vx-devtools'

export const GITHUB = 'https://token.actions.githubusercontent.com'
export const REPO = 'acme/app'

/** `ALLOW` admitting acme/app's CI workflow at `iss`, as a server reads it. */
export const allowVarOf = (iss: string = GITHUB): string =>
  `${iss}:${REPO}:${iss === GITHUB ? 'ci.yml' : '.gitlab-ci.yml'}`
export const allowOf = (iss: string = GITHUB): Allowed[] => parseAllow(allowVarOf(iss))

export interface Issuer {
  readonly iss: string
  readonly jwks: { keys: JWK[] }
  /** Serves the issuer's discovery document and keys, as `OidcOptions.fetchJson`. */
  fetchJson(url: string): Promise<unknown>
  /** A token of acme/app for `aud`: of main, of `feature`, or reading only. */
  sign(job: 'main' | 'branch' | 'read', aud: string, extra?: JWTPayload): Promise<string>
}

export async function issuer(iss: string = GITHUB): Promise<Issuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] }
  const github = iss === GITHUB
  const host = iss.replace(/^https?:\/\//, '')
  const claims = (ref: string): JWTPayload =>
    github
      ? {
          repository: REPO,
          job_workflow_ref: `${REPO}/.github/workflows/ci.yml@${ref}`,
          ref,
          event_name: 'push',
        }
      : {
          project_path: REPO,
          ci_config_ref_uri: `${host}/${REPO}//.gitlab-ci.yml@${ref}`,
          ref_path: ref,
        }
  const jobs = {
    main: claims('refs/heads/main'),
    branch: claims('refs/heads/feature'),
    // Reads only: a pull_request_target run writes nothing, nor a token naming no ref.
    read: github
      ? { ...claims('refs/heads/main'), event_name: 'pull_request_target' }
      : { ...claims('refs/heads/main'), ref_path: 'main' },
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
