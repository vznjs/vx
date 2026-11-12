// A sandboxed client reaching a server a dependency runs on the host's
// loopback: the e2e shape (a persistent `preview`, a sandboxed `e2e` that
// browses it). On Linux the client runs in a network namespace of its own,
// so `localhost:4173` there is an empty loopback, and the proxy that serves
// `allow.network` is skipped for loopback by `NO_PROXY` and by every
// browser. The grant `network: ['localhost:<port>']` relays that one port
// into the namespace. Before it did, the documented setup was refused
// whatever the grant (2026-11-12).

import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { freePort } from './helpers/free-port.js'
import { addProject } from './helpers/workspace.js'
import { run } from './helpers/orchestrator.js'
import {
  TIMEOUT,
  type Fixture,
  expectOk,
  collectingLogger,
  makeWorkspace,
} from './helpers/sandbox-fixture.js'

const available = await sandboxAvailable('sandbox loopback reach tests')

function ipv6Loopback(): boolean {
  try {
    Bun.listen({ hostname: '::1', port: 0, socket: { data() {} } }).stop(true)
    return true
  } catch {
    return false
  }
}

describe.skipIf(!available || Bun.which('curl') === null)(
  "a sandboxed client reaches a dependency's server on a granted loopback port",
  () => {
    let fixture: Fixture
    beforeEach(async () => {
      fixture = await makeWorkspace()
    })
    afterEach(async () => {
      await rm(fixture.root, { recursive: true, force: true })
    })

    const config = (o: { port: number; server: string; client: string; host?: string }) => ({
      files: {
        'serve.ts':
          `Bun.serve({ port: ${o.port}, hostname: '${o.host ?? '127.0.0.1'}', fetch: () => new Response('hi-from-server') })\n` +
          `console.log('serving')\n`,
      },
      config: `
        export default {
          tasks: {
            serve: {
              exec: { command: 'bun serve.ts', persistent: { readyWhen: 'serving' }${o.server} },
            },
            client: {
              dependsOn: ['serve'],
              exec: {
                command: 'curl -sS --max-time 10 http://localhost:${o.port}/',
                sandbox: { allow: { read: ['.']${o.client} } },
              },
            },
          },
        }
      `,
    })

    const clientRun = () =>
      run({ cwd: fixture.root, tasks: ['client'], log: collectingLogger(fixture) })

    it(
      'an unsandboxed server, through `network: [localhost:<port>]`',
      async () => {
        const port = freePort()
        await addProject(fixture.root, 'web', {
          ...config({ port, server: '', client: `, network: ['localhost:${port}']` }),
        })
        const r = await clientRun()
        expectOk(r, fixture)
        expect(fixture.log.join('\n')).toContain('hi-from-server')
      },
      TIMEOUT,
    )

    it(
      'a sandboxed server exposing its port with `localBinding: [<port>]`',
      async () => {
        const port = freePort()
        await addProject(fixture.root, 'web', {
          ...config({
            port,
            server: `, sandbox: { allow: { read: ['.'], localBinding: [${port}] } }`,
            client: `, network: ['localhost:${port}']`,
          }),
        })
        const r = await clientRun()
        expectOk(r, fixture)
        expect(fixture.log.join('\n')).toContain('hi-from-server')
      },
      TIMEOUT,
    )

    it.skipIf(!ipv6Loopback())(
      'a server bound to ::1 alone (Vite on a host resolving ::1 first)',
      async () => {
        const port = freePort()
        await addProject(fixture.root, 'web', {
          ...config({ port, host: '::1', server: '', client: `, network: ['localhost:${port}']` }),
        })
        const r = await clientRun()
        expectOk(r, fixture)
        expect(fixture.log.join('\n')).toContain('hi-from-server')
      },
      TIMEOUT,
    )

    // The hunt's second finding on the same setup: `preview` granted
    // `node_modules/.vite/` counted as writing anywhere in its project, so
    // the cached e2e reading `e2e/**` had no key before it ran, and every
    // hit booted the server first. A sandboxed writer reaches only its
    // grants, checked against the reader's inputs as declared outputs are.
    it(
      "a cached client's hit does not start a server whose write grants miss its inputs",
      async () => {
        const port = freePort()
        const project = (grant: string) =>
          addProject(fixture.root, 'web', {
            files: {
              'serve.ts': config({ port, server: '', client: '' }).files['serve.ts'],
              'e2e/a.txt': 'a',
            },
            config: `
              export default {
                tasks: {
                  serve: {
                    exec: {
                      command: 'bun serve.ts',
                      persistent: { readyWhen: 'serving' },
                      sandbox: { allow: { read: ['.'], write: ['${grant}'], localBinding: [${port}] } },
                    },
                    inputs: { files: ['serve.ts'] },
                  },
                  client: {
                    dependsOn: ['serve'],
                    exec: {
                      command: 'curl -sS --max-time 10 http://localhost:${port}/',
                      sandbox: { allow: { read: ['.'], network: ['localhost:${port}'] } },
                    },
                    inputs: { files: ['e2e/**'] },
                    outputs: { files: [] },
                    cache: true,
                  },
                },
              }
            `,
          })
        const outcomes = async () => {
          const r = await clientRun()
          expectOk(r, fixture)
          return r.outcomes.map((o) => `${o.node.id} ${o.status}`).sort()
        }
        await project('node_modules/.vite/')
        expect(await outcomes()).toEqual(['web#client success', 'web#serve success'])
        expect(await outcomes()).toEqual(['web#client cache-hit'])
        // Control: a grant over the client's inputs keeps the server first,
        // hit or not (the changed config moved the client's key).
        await project('e2e/')
        expect(await outcomes()).toEqual(['web#client success', 'web#serve success'])
        expect(await outcomes()).toEqual(['web#client cache-hit', 'web#serve success'])
      },
      TIMEOUT,
    )

    it(
      'control: no grant, or another port granted, is refused',
      async () => {
        const port = freePort()
        for (const client of ['', `, network: ['localhost:${freePort()}']`]) {
          fixture.log.length = 0
          await addProject(fixture.root, 'web', { ...config({ port, server: '', client }) })
          const r = await clientRun()
          expect(r.ok).toBe(false)
          expect(r.outcomes.find((o) => o.node.id === 'web#client')?.status).toBe('failed')
          expect(fixture.log.join('\n')).not.toContain('hi-from-server')
          // The refusal names the grant that relays the port.
          expect(
            r.outcomes.find((o) => o.node.id === 'web#client')?.sandboxViolationLines?.join('\n'),
          ).toContain(`allow: { network: ['localhost:${port}'] }`)
        }
      },
      TIMEOUT,
    )
  },
)
