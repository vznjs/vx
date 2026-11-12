// A sandboxed task dialling a port a process on the host listens on, with
// no grant: on Linux the task has a loopback of its own, so it failed with
// a bare ECONNREFUSED and no word of `network: ['localhost:<port>']`, the
// grant that relays the port in (2026-11-12). The failure now names it.

import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  initSandbox,
  resetSandbox,
  resolveSandboxConfig,
  runSandboxed,
} from '../src/sandbox/runtime.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { freePort } from './helpers/free-port.js'

const available = await sandboxAvailable('sandbox loopback refusal hint test')
const hintFor = (port: number) =>
  `vx: the task was refused on localhost port ${port}, which a process on this machine ` +
  'listens on: a sandboxed task has a loopback of its own. Grant it: ' +
  `\`allow: { network: ['localhost:${port}'] }\`.`

describe.skipIf(!available || process.platform !== 'linux')(
  'a sandboxed task refused on a host loopback port',
  () => {
    let dir = ''
    let port = 0
    let listener: { stop(closeActive?: boolean): void } | undefined
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-loopback-hint-')))
      port = freePort()
      listener = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } })
      await initSandbox()
    })
    afterEach(async () => {
      listener?.stop(true)
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

    it('a real dial names the grant', async () => {
      const r = await run(
        `node -e "require('net').connect(${port}, '127.0.0.1').on('error', (e) => { console.error(e.message); process.exit(1) })"`,
      )
      expect([r.exitCode, r.stderr.trim(), hints(r)]).toEqual([
        1,
        `connect ECONNREFUSED 127.0.0.1:${port}`,
        [hintFor(port)],
      ])
    }, 30_000)

    it.each([
      [
        'a browser',
        (p: number) => `page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:${p}/`,
      ],
      [
        'curl',
        (p: number) =>
          `curl: (7) Failed to connect to localhost port ${p} after 0 ms: Couldn't connect to server`,
      ],
      // curl 8.7 says it in full (Ubuntu 26.04, CI's runners, 2026-11-12).
      [
        'curl 8.7',
        (p: number) =>
          `curl: (7) Failed to connect to localhost port ${p} after 0 ms: Could not connect to server`,
      ],
      ['IPv6', (p: number) => `Error: connect ECONNREFUSED [::1]:${p}`],
    ])(
      "%s's refusal names the grant",
      async (_, said) => {
        const r = await run(`echo "${said(port)}"; exit 1`)
        expect([r.exitCode, hints(r)]).toEqual([1, [hintFor(port)]])
      },
      30_000,
    )

    // A pipe may cut one line in three chunks (CI, Ubuntu 26.04): the tail
    // kept two, and lost the port.
    it('a refusal written in three chunks names the grant', async () => {
      const r = await run(
        `printf 'curl: (7) Failed to connect to localhost por' >&2; sleep 0.2; ` +
          `printf 't ${port} after 0 ms: Could' >&2; sleep 0.2; ` +
          `printf ' not connect to server\\n' >&2; exit 7`,
      )
      expect([r.exitCode, hints(r)]).toEqual([7, [hintFor(port)]])
    }, 30_000)

    it('no hint for a port nothing listens on, a granted port, or a task that passed', async () => {
      const other = freePort()
      const refused = (p: number) => `connect ECONNREFUSED 127.0.0.1:${p}`
      const results = [
        await run(`echo '${refused(other)}' >&2; exit 1`),
        await run(`echo '${refused(port)}' >&2; exit 1`, [`localhost:${port}`]),
        await run(`echo '${refused(port)}' >&2; exit 0`),
      ]
      expect(results.map((r) => [r.exitCode, hints(r)])).toEqual([
        [1, []],
        [1, []],
        [0, []],
      ])
    }, 30_000)
  },
)
