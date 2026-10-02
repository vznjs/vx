// A REAPI server behind a private CA, or one that asks for a client
// certificate, was unreachable: TLS used the system roots and no client
// pair (F-41). Certificates are made per run by openssl, so no key is
// checked in.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as grpc from '@grpc/grpc-js'
import { Cache } from '@vzn/vx'
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

// F-57: the plugin's TLS options were never shown to reach the connection;
// dropping any PEM from what it hands the client went unheard.
it('reapi() options reach the connection: CA and client pair through the plugin', async () => {
  const dir2 = mkdtempSync(path.join(tmpdir(), 'vx-tls-plugin-'))
  const local = new Cache(path.join(dir2, 'cache'))
  try {
    const layerFor = async (opts: Parameters<typeof reapi>[0]) => {
      const warns: string[] = []
      const p = reapi({
        endpoint: `localhost:${mutual.endpoint.split(':')[1]}`,
        callTimeoutMs: 3000,
        ...opts,
      })
      const layer = (await p.cache!({
        localCache: local,
        policy: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true },
        warn: (m: string) => warns.push(m),
        workspaceRoot: dir2,
        cacheDir: path.join(dir2, 'cache'),
      } as never))!
      try {
        const hit = await layer.get('e'.repeat(64), { taskId: 'a#b', command: 'true' })
        return [hit, warns.length]
      } finally {
        await p.teardown?.()
      }
    }
    expect(
      await layerFor({
        tlsCertificate: file('ca.pem'),
        tlsClientCertificate: file('client.pem'),
        tlsClientKey: file('client.key'),
      }),
    ).toEqual([null, 0])
    // A CA alone means TLS, with no scheme on the endpoint.
    const plainPort = plain.endpoint.split(':')[1]
    const caOnly = reapi({
      endpoint: `localhost:${plainPort}`,
      callTimeoutMs: 3000,
      tlsCertificate: file('ca.pem'),
    })
    const warns: string[] = []
    const caLayer = (await caOnly.cache!({
      localCache: local,
      policy: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true },
      warn: (m: string) => warns.push(m),
      workspaceRoot: dir2,
      cacheDir: path.join(dir2, 'cache'),
    } as never))!
    try {
      expect([
        await caLayer.get('f'.repeat(64), { taskId: 'a#b', command: 'true' }),
        warns,
      ]).toEqual([null, []])
    } finally {
      await caOnly.teardown?.()
    }
    // CONTROL: without the pair the mutual server refuses, and the miss warns.
    const refused = await layerFor({ tlsCertificate: file('ca.pem') })
    expect([refused[0], (refused[1] as number) > 0]).toEqual([null, true])
  } finally {
    local.close()
    rmSync(dir2, { recursive: true, force: true })
  }
})

it('a TLS option wins over its env var; an env path is trimmed and an empty one unset; a key alone is refused', async () => {
  const keys = ['VX_REAPI_TLS_CERTIFICATE', 'VX_REAPI_TLS_CLIENT_KEY'] as const
  const prev = keys.map((k) => process.env[k])
  const cacheOf = async (opts: Parameters<typeof reapi>[0]): Promise<string> => {
    const p = reapi({ endpoint: 'localhost:1', ...opts })
    try {
      await p.cache!({ warn: () => undefined, localCache: {}, policy: {} } as never)
      return 'ok'
    } catch (err) {
      return (err as Error).message
    } finally {
      await p.teardown?.()
    }
  }
  try {
    process.env['VX_REAPI_TLS_CERTIFICATE'] = file('missing.pem')
    const optionWins = await cacheOf({ tlsCertificate: file('ca.pem') })
    process.env['VX_REAPI_TLS_CERTIFICATE'] = ` ${file('ca.pem')}\n`
    const trimmed = await cacheOf({})
    process.env['VX_REAPI_TLS_CERTIFICATE'] = ''
    const empty = await cacheOf({})
    delete process.env['VX_REAPI_TLS_CERTIFICATE']
    const keyAlone = await cacheOf({ tlsClientKey: file('client.key') })
    const unreadable = await cacheOf({
      tlsClientCertificate: file('nope.pem'),
      tlsClientKey: file('client.key'),
    })
    expect([optionWins, trimmed, empty, unreadable, keyAlone]).toEqual([
      'ok',
      'ok',
      'ok',
      `vx/reapi: \`reapi({ tlsClientCertificate })\` names ${file('nope.pem')}, which cannot be read (ENOENT)`,
      'vx/reapi: a client certificate and its key go together — set both tlsClientCertificate and tlsClientKey (VX_REAPI_TLS_CLIENT_CERTIFICATE / VX_REAPI_TLS_CLIENT_KEY), or neither',
    ])
  } finally {
    keys.forEach((k, i) => {
      if (prev[i] === undefined) delete process.env[k]
      else process.env[k] = prev[i]
    })
  }
})

// The README's sample was `cache.example.com:443`, which connects in
// plaintext and fails against the TLS server on that port (J-96): the
// scheme, not the port, turns TLS on.
it('a bare host:port is plaintext and grpcs:// is TLS, with no PEM to decide it', async () => {
  const open = await startFakeReapi()
  const port = open.endpoint.split(':')[1]
  const reach = async (endpoint: string): Promise<string> => {
    const client = new ReapiClient({ endpoint, callTimeoutMs: 3000 })
    try {
      return await client.findMissingBlobs([{ hash: 'a'.repeat(64), size_bytes: 1 }]).then(
        () => 'ok',
        () => 'refused',
      )
    } finally {
      client.close()
    }
  }
  try {
    expect([await reach(`localhost:${port}`), await reach(`grpcs://localhost:${port}`)]).toEqual([
      'ok',
      'refused',
    ])
  } finally {
    open.stop()
  }
})

it("the README's samples on port 443 name a TLS scheme", async () => {
  const readme = await readFile(path.join(import.meta.dir, '..', 'README.md'), 'utf8')
  const src = await readFile(path.join(import.meta.dir, '..', 'src', 'index.ts'), 'utf8')
  const samples = [...(readme + src).matchAll(/endpoint: '([^']+:443)'/g)].map((m) => m[1]!)
  expect(samples.length).toBeGreaterThan(2)
  expect(samples.filter((e) => !/^(grpcs|https):\/\//.test(e))).toEqual([])
})
