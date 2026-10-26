#!/usr/bin/env -S bun --no-env-file --no-install
// `bunx @vzn/vx-dte-server`: the relay on Bun, runs in memory (PROTOCOL.md).

import { parseArgs } from 'node:util'
import { createVerifier, parseAllow } from './oidc.js'
import { serveRelay } from './serve.js'

const USAGE = `usage: vx-dte-server --allow <issuer:owner/repo:workflow>... --audience <aud> [--port 8080] [--host 0.0.0.0]
       vx-dte-server --no-auth [--port 8080]   (loopback only)`

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      allow: { type: 'string', multiple: true },
      audience: { type: 'string' },
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
  if (noAuth && !LOOPBACK.has(host)) fail('--no-auth listens on loopback only')
  // The bare usage said nothing of which was missing.
  if (!noAuth) {
    const missing = [
      // An empty one is missing too: it started a relay that refused every token.
      ...((values.allow ?? []).every((a) => a.trim() === '') ? ['--allow'] : []),
      ...(values.audience === undefined || values.audience.trim() === '' ? ['--audience'] : []),
    ]
    if (missing.length > 0) fail(`missing ${missing.join(' and ')} (or --no-auth)\n${USAGE}`)
  }
  let allow: ReturnType<typeof parseAllow> = []
  try {
    allow = parseAllow((values.allow ?? []).join(' '))
  } catch (err) {
    fail(`--allow: ${(err as Error).message}`)
  }
  // Number('') is 0: `--port "$PORT"` with PORT unset bound a random port.
  const port = values.port.trim() === '' ? Number.NaN : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    fail(`--port: not a port: ${values.port}`)
  const server = serveRelay({
    hostname: host,
    port,
    verify: noAuth ? undefined : createVerifier({ allow, audience: values.audience! }),
  })
  console.log(`vx-dte-server on ${server.url}`)
  const stop = (): void => {
    void server.stop().then(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

try {
  main(process.argv.slice(2))
} catch (err) {
  // parseArgs names the flag it refused, not the ones there are.
  const usage = (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS') ? `\n${USAGE}` : ''
  fail(`${err instanceof Error ? err.message : String(err)}${usage}`)
}
