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
const claims = {
  main: { ref_path: 'refs/heads/main', pipeline_source: 'push' },
  branch: { ref_path: 'refs/heads/feature', pipeline_source: 'push' },
  read: { ref_path: 'refs/heads/main', pipeline_source: 'web' },
}

conformance('the Docker image', {
  base: () => env('VX_HISTORY_SMOKE'),
  sign: async (job) =>
    new SignJWT({ project_path: 'acme/app', ...claims[job] })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(env('VX_HISTORY_ISSUER'))
      .setAudience(new URL(env('VX_HISTORY_SMOKE')).origin)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(await key),
  issuer: env('VX_HISTORY_ISSUER'),
  repository: 'acme/app',
})
