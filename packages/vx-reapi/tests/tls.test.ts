// A REAPI server behind a private CA, or one that asks for a client
// certificate, was unreachable: TLS used the system roots and no client
// pair (F-41). Certificates are made per run by openssl, so no key is
// checked in.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as grpc from '@grpc/grpc-js'
import { reapi } from '../src/index.js'
import { ReapiClient } from '../src/wire.js'
import { startFakeReapi, type FakeReapi } from './helpers/fake-reapi.js'

let dir: string
const file = (name: string) => path.join(dir, name)
const text = (name: string) => readFile(file(name))

const openssl = (...args: string[]): void => {
  const r = Bun.spawnSync(['openssl', ...args], { cwd: dir, stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`openssl ${args[0]}: ${r.stderr.toString()}`)
}

let plain: FakeReapi
let mutual: FakeReapi

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vx-reapi-tls-'))
  await writeFile(file('ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n')
  const rsa = ['-newkey', 'rsa:2048', '-nodes']
  openssl(
    'req',
    '-x509',
    ...rsa,
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '2',
    '-subj',
    '/CN=vx-test-ca',
  )
  for (const [name, cn] of [
    ['server', 'localhost'],
    ['client', 'vx-client'],
  ] as const) {
    openssl('req', ...rsa, '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`)
    openssl(
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      `${name}.pem`,
      '-days',
      '2',
      ...(name === 'server' ? ['-extfile', 'ext.cnf'] : []),
    )
  }
  const pair = [{ cert_chain: await text('server.pem'), private_key: await text('server.key') }]
  plain = await startFakeReapi({ credentials: grpc.ServerCredentials.createSsl(null, pair, false) })
  mutual = await startFakeReapi({
    credentials: grpc.ServerCredentials.createSsl(await text('ca.pem'), pair, true),
  })
})
afterAll(async () => {
  plain?.stop()
  mutual?.stop()
  await rm(dir, { recursive: true, force: true })
})

/** One FindMissingBlobs through a client built from these options: 'ok' or the refusal. */
async function probe(
  fake: FakeReapi,
  tls: { ca?: string; cert?: string; key?: string },
): Promise<string> {
  const client = new ReapiClient({
    endpoint: `localhost:${fake.endpoint.split(':')[1]}`,
    tls: true,
    callTimeoutMs: 3000,
    ...(tls.ca === undefined ? {} : { tlsCaPem: (await text(tls.ca)).toString() }),
    ...(tls.cert === undefined ? {} : { tlsClientCertPem: (await text(tls.cert)).toString() }),
    ...(tls.key === undefined ? {} : { tlsClientKeyPem: (await text(tls.key)).toString() }),
  })
  try {
    return await client.findMissingBlobs([{ hash: 'a'.repeat(64), size_bytes: 1 }]).then(
      () => 'ok',
      (err: Error) => err.message.split(':')[0]!,
    )
  } finally {
    client.close()
  }
}

it('a server behind a private CA is reached with its CA, and not without', async () => {
  expect(await probe(plain, {})).not.toBe('ok')
  expect(await probe(plain, { ca: 'ca.pem' })).toBe('ok')
})

it('a server that asks for a client certificate is reached with the pair, and not without', async () => {
  expect(await probe(mutual, { ca: 'ca.pem' })).not.toBe('ok')
  expect(await probe(mutual, { ca: 'ca.pem', cert: 'client.pem', key: 'client.key' })).toBe('ok')
})

it('the plugin reads the PEM files its options or VX_REAPI_TLS_* name; an unreadable one is refused by name', async () => {
  const warn = () => undefined
  /** 'ok', or the refusal the plugin threw. */
  const cacheOf = async (opts: Parameters<typeof reapi>[0]): Promise<string> => {
    const p = reapi({ endpoint: 'localhost:1', ...opts })
    try {
      await p.cache!({ warn, localCache: {}, policy: {} } as never)
      return 'ok'
    } catch (err) {
      return (err as Error).message
    } finally {
      await p.teardown?.()
    }
  }
  expect(await cacheOf({ tlsCertificate: file('ca.pem') })).toBe('ok')
  expect(await cacheOf({ tlsClientCertificate: file('client.pem') })).toBe(
    'vx/reapi: a client certificate and its key go together — set both tlsClientCertificate and tlsClientKey (VX_REAPI_TLS_CLIENT_CERTIFICATE / VX_REAPI_TLS_CLIENT_KEY), or neither',
  )
  expect(await cacheOf({ tlsCertificate: file('nope.pem') })).toBe(
    `vx/reapi: \`reapi({ tlsCertificate })\` names ${file('nope.pem')}, which cannot be read (ENOENT)`,
  )
  const prev = process.env['VX_REAPI_TLS_CLIENT_KEY']
  process.env['VX_REAPI_TLS_CLIENT_KEY'] = file('missing.key')
  try {
    expect(await cacheOf({})).toBe(
      `vx/reapi: VX_REAPI_TLS_CLIENT_KEY names ${file('missing.key')}, which cannot be read (ENOENT)`,
    )
  } finally {
    if (prev === undefined) delete process.env['VX_REAPI_TLS_CLIENT_KEY']
    else process.env['VX_REAPI_TLS_CLIENT_KEY'] = prev
  }
})
