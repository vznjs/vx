// OTEL_EXPORTER_OTLP_CERTIFICATE and the client pair were not read (F-39):
// a collector behind a private CA, or one that asks for a client
// certificate, received nothing from vx. Certificates are made per run by
// openssl, so no key is checked in.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RunContextRecord } from '@vzn/vx'
import { resolveOtelConfig } from '../src/plugin.js'
import { OtelSink } from '../src/sink.js'

let dir: string
const file = (name: string) => path.join(dir, name)

const openssl = (...args: string[]): void => {
  const r = Bun.spawnSync(['openssl', ...args], { cwd: dir, stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`openssl ${args[0]}: ${r.stderr.toString()}`)
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vx-otel-tls-'))
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
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const RUN = {
  runId: 'run-1',
  vxVersion: '1.2.3',
  workspaceId: 'ws',
  workspaceName: 'w',
  command: 'vx run build',
  requestedTasks: ['build'],
  cachePolicy: 'lR',
  concurrency: 1,
  flow: 'focused',
  commitSha: 'abc',
  branch: 'main',
  defaultBranch: 'main',
  dirty: false,
  ci: false,
  ciProvider: '',
  host: 'h',
  os: 'linux',
  arch: 'x64',
  tags: {},
} as unknown as RunContextRecord

/** Export one run to a TLS collector under `env`; the spans it received, and the warnings. */
async function exportTo(
  mutual: boolean,
  env: Record<string, string>,
): Promise<{ received: number; warns: string[] }> {
  let received = 0
  const server = Bun.serve({
    port: 0,
    tls: {
      cert: Bun.file(file('server.pem')),
      key: Bun.file(file('server.key')),
      ...(mutual
        ? { ca: await Bun.file(file('ca.pem')).text(), requestCert: true, rejectUnauthorized: true }
        : {}),
    },
    fetch: async (req) => {
      received++
      await req.arrayBuffer()
      return new Response('{}')
    },
  })
  const warns: string[] = []
  try {
    const cfg = resolveOtelConfig(
      { metrics: false, logs: false, timeoutMs: 5000 },
      { OTEL_EXPORTER_OTLP_ENDPOINT: `https://localhost:${server.port}`, ...env },
      (m) => warns.push(m),
    )!
    const sink = new OtelSink({ ...cfg, warn: (m) => warns.push(m) })
    sink.onRecord({ v: 2, kind: 'run.start', run: RUN, total: 0, ts: 0, startedAt: 0 })
    sink.onRecord({ v: 2, kind: 'run.end', runId: RUN.runId, ts: 10 })
    await sink.flush()
  } finally {
    await server.stop(true)
  }
  return { received, warns }
}

it('a collector behind a private CA is trusted through OTEL_EXPORTER_OTLP_CERTIFICATE', async () => {
  const without = await exportTo(false, {})
  expect(without.received).toBe(0)
  expect(without.warns.length).toBe(1)
  const withCa = await exportTo(false, { OTEL_EXPORTER_OTLP_CERTIFICATE: file('ca.pem') })
  expect(withCa).toEqual({ received: 1, warns: [] })
  // A signal's own wins over the shared one.
  const own = await exportTo(false, {
    OTEL_EXPORTER_OTLP_CERTIFICATE: file('missing.pem'),
    OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE: file('ca.pem'),
  })
  expect(own.received).toBe(1)
})

it('a collector that asks for a client certificate gets the CLIENT_CERTIFICATE / CLIENT_KEY pair', async () => {
  const caOnly = await exportTo(true, { OTEL_EXPORTER_OTLP_CERTIFICATE: file('ca.pem') })
  expect(caOnly.received).toBe(0)
  const mutual = await exportTo(true, {
    OTEL_EXPORTER_OTLP_CERTIFICATE: file('ca.pem'),
    OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: file('client.pem'),
    OTEL_EXPORTER_OTLP_CLIENT_KEY: file('client.key'),
  })
  expect(mutual).toEqual({ received: 1, warns: [] })
})

it('a certificate file that cannot be read warns once, naming the variable and the path', async () => {
  const missing = file('nope.pem')
  const got = await exportTo(false, {
    OTEL_EXPORTER_OTLP_CERTIFICATE: missing,
  })
  expect(got.warns[0]).toBe(
    `[vx-otel] OTEL_EXPORTER_OTLP_CERTIFICATE: cannot read ${missing} (ENOENT) — not used`,
  )
  // The same file for all three signals is read, and reported, once.
  expect(got.warns.filter((w) => w.includes('cannot read')).length).toBe(1)
})
