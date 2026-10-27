// The CI issuer the container trusts, on the host's loopback: it serves
// its keys and prints the TRUST naming it; conformance.docker.ts signs
// with the same key (the key pair is written beside it for that).
import { exportJWK, exportPKCS8, generateKeyPair } from 'jose'
import path from 'node:path'

const iss = process.env['VX_HISTORY_ISSUER']!
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
console.log(
  JSON.stringify([
    { iss, project_path: 'acme/app', pipeline_source: 'push', ref_path: 'refs/heads/main' },
  ]),
)
