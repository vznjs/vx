// The conformance suite against the image `docker run` serves, started by
// smoke.sh. Not `*.test.ts`: `bun test` alone has no container.
import { importPKCS8, SignJWT } from 'jose'
import path from 'node:path'
import { conformance } from '../conformance.js'

function env(name: string): string {
  const v = process.env[name]
  if (v === undefined) throw new Error('smoke.sh runs this, against the container it starts')
  return v
}

const key = importPKCS8(await Bun.file(path.join(import.meta.dir, '.key')).text(), 'RS256')
const workflow = (repo: string, ref: string) =>
  `${env('VX_CACHE_ISSUER').replace(/^https?:\/\//, '')}/${repo}//.gitlab-ci.yml@${ref}`
const jobOf = (ref: string, repo = 'acme/app') => ({
  project_path: repo,
  ci_config_ref_uri: workflow(repo, ref),
  ref_path: ref,
})
const claims = {
  main: jobOf('refs/heads/main'),
  branch: jobOf('refs/heads/feature'),
  // A token naming no ref writes nothing.
  read: { ...jobOf('refs/heads/main'), ref_path: 'main' },
  stranger: jobOf('refs/heads/main', 'acme/other'),
}

conformance('the Docker image', {
  base: () => env('VX_CACHE_SMOKE'),
  sign: async (job) =>
    new SignJWT(claims[job])
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(env('VX_CACHE_ISSUER'))
      .setAudience(new URL(env('VX_CACHE_SMOKE')).origin)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(await key),
  issuer: env('VX_CACHE_ISSUER'),
  repository: 'acme/app',
  maxCheckHashes: 500,
  maxUploadBytes: 7 * 1024 * 1024,
})
