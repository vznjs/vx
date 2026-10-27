// The CI issuer and the bucket the container uses, on the host's loopback:
// it serves its keys and an S3 bucket, and prints the ALLOW naming it;
// conformance.docker.ts signs with the same key (written beside it).
import { exportJWK, exportPKCS8, generateKeyPair } from 'jose'
import path from 'node:path'
import { fakeS3 } from '../fake-s3.js'

const iss = process.env['VX_CACHE_ISSUER']!
const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] }
await Bun.write(path.join(import.meta.dir, '.key'), await exportPKCS8(privateKey))
Bun.serve({
  hostname: '127.0.0.1',
  port: Number(new URL(iss).port),
  fetch: (req) =>
    new URL(req.url).pathname === '/.well-known/openid-configuration'
      ? Response.json({ jwks_uri: `${iss}/keys` })
      : Response.json(jwks),
})
fakeS3(Number(process.env['VX_CACHE_S3_PORT']))
console.log(`${iss}:acme/app:.gitlab-ci.yml`)
