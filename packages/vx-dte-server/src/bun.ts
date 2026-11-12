#!/usr/bin/env -S bun --no-env-file --no-install
// `bunx @vzn/vx-dte-server`: the relay on Bun, runs in memory (PROTOCOL.md).

import { parseArgs } from 'node:util'
import { parseAllow, statusLine as line } from '@vzn/vx-devtools'
import { createVerifier } from './relay.js'
import { serveRelay } from './serve.js'

const USAGE = `usage: vx-dte-server [--port 8080] [--host 0.0.0.0]
       vx-dte-server --no-auth [--port 8080]   (loopback only)
  ALLOW      who may take part, space separated, each issuer:owner/repo:workflow
  AUDIENCE   the aud every CI token names: the URL CI reaches the relay at`

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: '8080' },
      host: { type: 'string' },
      'no-auth': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    console.log(USAGE)
    return
  }
  const noAuth = values['no-auth']
  const host = values.host ?? (noAuth ? '127.0.0.1' : '0.0.0.0')
  // Bun.serve reads '' as localhost: unreachable from another host or container.
  if (host.trim() === '') fail(`--host: needs an address, got '${host}'`)
  if (noAuth && !LOOPBACK.has(host)) fail('--no-auth listens on loopback only')
  // Read from the environment, as the cache and history servers and the
  // relay's Worker read them: one way to configure every vx server.
  const env = Bun.env
  const audience = env.AUDIENCE?.trim() ?? ''
  // The bare usage said nothing of which was missing.
  if (!noAuth) {
    const missing = [
      // An empty one is missing too: it started a relay that refused every token.
      ...((env.ALLOW ?? '').trim() === '' ? ['ALLOW'] : []),
      ...(audience === '' ? ['AUDIENCE'] : []),
    ]
    if (missing.length > 0) fail(`missing ${missing.join(' and ')} (or --no-auth)\n${USAGE}`)
  }
  let allow: ReturnType<typeof parseAllow> = []
  try {
    allow = parseAllow(env.ALLOW ?? '')
  } catch (err) {
    fail(`ALLOW: ${(err as Error).message}`)
  }
  // Digits only, as the cache and history servers read it: Number('') is
  // 0, a random port for `--port "$PORT"` with PORT unset, and Number read
  // 0x50 as 80 and 1e1 as 10.
  const port = /^\d+$/.test(values.port) ? Number(values.port) : Number.NaN
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    fail(`--port: not a port: ${values.port}`)
  const server = serveRelay({
    hostname: host,
    port,
    verify: noAuth ? undefined : createVerifier({ allow, audience }),
  })
  process.stdout.write(line('ok', 'vx-dte-server', `listening on ${server.url}`))
  const stop = (): void => {
    void server.stop().then(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

function fail(message: string): never {
  process.stderr.write(line('err', 'vx-dte-server', message))
  process.exit(2)
}

try {
  main(process.argv.slice(2))
} catch (err) {
  // parseArgs names the flag it refused, not the ones there are.
  const usage = (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS') ? `\n${USAGE}` : ''
  fail(`${err instanceof Error ? err.message : String(err)}${usage}`)
}
