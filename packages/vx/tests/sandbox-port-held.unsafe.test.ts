// The port bridge's listen wait read /proc/net/tcp, and a host process
// already listening on a `localBinding` port counted as the bridge: its
// own bind failed unseen, the task passed, and a client of the port
// reached the other process (2026-10-03).
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox port held test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

describe.skipIf(!available || process.platform !== 'linux')(
  'a localBinding port the host holds',
  () => {
    let root: string
    beforeEach(async () => {
      root = realpathSync(await makeWorkspace({ prefix: 'vx-port-held-' }))
    })
    afterEach(() => rm(root, { recursive: true, force: true }))

    const outcome = async (port: number) => {
      await addProject(root, 'app', {
        config: `export default { tasks: { t: { exec: {
        command: 'true',
        sandbox: { allow: { read: ['.'], localBinding: [${port}] } },
      } } } }\n`,
      })
      const err: string[] = []
      const log = {
        status() {},
        taskStdout() {},
        taskStderr(_n: unknown, chunk: string) {
          err.push(chunk)
        },
        taskComplete() {},
      }
      const r = await run({ cwd: root, tasks: ['t'], log })
      return [r.outcomes[0]?.status, err.join('').includes(`port ${port} is already in use`)]
    }

    it('fails the task, naming the port', async () => {
      const host = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('host') })
      try {
        expect(await outcome(host.port!)).toEqual(['failed', true])
      } finally {
        await host.stop(true)
      }
    })

    // The server's wrap refused the port after the request had made the
    // placeholder for its literal write grant, and nothing took it back:
    // the empty `out.log` stayed in the project for every later run.
    it('a server refused for the port leaves no placeholder behind', async () => {
      const host = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('host') })
      try {
        const dir = await addProject(root, 'app', {
          config: `export default { tasks: { dev: { exec: {
          command: 'echo READY; sleep 5',
          persistent: { readyWhen: 'READY' },
          sandbox: { allow: { read: ['.'], write: ['out.log'], localBinding: [${host.port}] } },
        } } } }\n`,
        })
        const r = await run({ cwd: root, tasks: ['dev'], log: quiet })
        expect([r.outcomes[0]?.status, existsSync(path.join(dir, 'out.log'))]).toEqual([
          'failed',
          false,
        ])
      } finally {
        await host.stop(true)
      }
    })

    it('CONTROL: once the host lets it go, the same port bridges', async () => {
      const host = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('host') })
      const port = host.port!
      await host.stop(true)
      expect(await outcome(port)).toEqual(['success', false])
    })
  },
)
