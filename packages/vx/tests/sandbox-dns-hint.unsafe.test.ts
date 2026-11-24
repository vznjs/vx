// A sandboxed task resolves no names: it reaches a host only through the
// proxy vx puts in HTTPS_PROXY. Node's fetch and https ignore that variable
// unless NODE_USE_ENV_PROXY=1, so a Node client of a host the task grants
// failed `getaddrinfo EAI_AGAIN <host>` with no violation and no word of
// either (2026-11-24). The failure now names the fix, and the grant when
// the host has none.

import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox } from '../src/sandbox/session.js'
import { resolveSandboxConfig } from '../src/sandbox/grants.js'
import { runSandboxed } from '../src/sandbox/runtime.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox DNS hint test')
const proxyLine =
  "vx: the task looked up example.com itself (getaddrinfo EAI_AGAIN): a sandboxed task resolves no names and reaches a host only through the proxy vx puts in HTTPS_PROXY. Node's fetch and https skip it unless NODE_USE_ENV_PROXY=1 (Node 22.21+, 24.5+): `exec: { env: { define: { NODE_USE_ENV_PROXY: '1' } } }`."

describe.skipIf(!available || process.platform !== 'linux')(
  'a sandboxed Node client that resolves a host itself',
  () => {
    let dir = ''
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-dns-hint-')))
      await initSandbox()
    })
    afterEach(async () => {
      await resetSandbox()
      await rm(dir, { recursive: true, force: true })
    })

    const run = (command: string, network?: string[]) =>
      runSandboxed({
        command,
        cwd: dir,
        env: process.env,
        baseAllowRead: [dir],
        baseDenyRead: [],
        reportWithin: dir,
        reportLinked: [],
        config: resolveSandboxConfig(
          { allow: { read: ['.'], ...(network === undefined ? {} : { network }) } },
          dir,
        ),
      })
    const hints = (r: Awaited<ReturnType<typeof run>>) =>
      r.violations.filter((v) => v.hint === true).map((v) => v.line)
    const lookup = `node -e "require('dns').lookup('example.com', (e) => { console.error(e ? e.message : 'ok'); process.exit(e ? 1 : 0) })"`

    it('a granted host: names NODE_USE_ENV_PROXY', async () => {
      const r = await run(lookup, ['example.com'])
      expect([r.exitCode, r.stderr.trim(), hints(r)]).toEqual([
        1,
        'getaddrinfo EAI_AGAIN example.com',
        [proxyLine],
      ])
    }, 30_000)

    it('a host no grant covers: names the grant too', async () => {
      const r = await run(lookup)
      expect(hints(r)).toEqual([
        `${proxyLine} It also needs the host: \`allow: { network: ['example.com'] }\`.`,
      ])
    }, 30_000)

    it('a wildcard grant covers the host', async () => {
      const r = await run(lookup.replaceAll('example.com', 'www.example.com'), ['*.example.com'])
      expect(hints(r)).toEqual([
        proxyLine.replace('looked up example.com', 'looked up www.example.com'),
      ])
    }, 30_000)

    it('a pass, or a failure that says nothing of a lookup, gets no hint', async () => {
      expect(hints(await run('echo getaddrinfo EAI_AGAIN example.com'))).toEqual([])
      expect(hints(await run('echo nope >&2; exit 1'))).toEqual([])
    }, 30_000)
  },
)
