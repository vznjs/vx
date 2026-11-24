// A remote's failure is text vx did not write: a server that echoes the
// token it was sent put the token in the run's history row (`remote_error`,
// which `vx last` prints) and in the telemetry record, though vx's own
// warning masked it.
import { Database } from 'bun:sqlite'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'
import type { RemoteCacheLayer } from '../src/cache/index.js'
import { addProject, makeWorkspace, silentLogger, TIMEOUT } from './helpers/orchestrator-fixture.js'
import { run } from './helpers/orchestrator.js'

const SECRET = 'remote-echoed-secret-42'

it(
  "masks a secret a remote's failure echoes in the run's stored remote error",
  async () => {
    const fixture = await makeWorkspace('vx-remote-error-mask-')
    try {
      await addProject(
        fixture.root,
        'app',
        `export default { tasks: { build: { exec: { command: 'echo b > out.txt' }, inputs: { files: [] }, outputs: { files: ['out.txt'] }, cache: true } } }`,
      )
      await writeFile(path.join(fixture.root, '.vx/workspace.mjs'), 'export default {}\n')
      const remote: RemoteCacheLayer = {
        async has() {
          return null
        },
        async get() {
          return null
        },
        async put() {
          throw new Error(`403 bad token ${SECRET}`)
        },
      }
      process.env['VX_TEST_REMOTE_TOKEN'] = SECRET
      let result
      try {
        result = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: remote,
          handoff: { remoteReadOnlyByDefault: false },
        })
      } finally {
        delete process.env['VX_TEST_REMOTE_TOKEN']
      }
      expect(result.ok).toBe(true)
      expect(fixture.log.join('\n')).not.toContain(SECRET)
      const db = new Database(path.join(fixture.root, '.vx/cache/cache.db'), { readonly: true })
      const rows = db.query('SELECT remote_error FROM runs').all() as {
        remote_error: string | null
      }[]
      db.close()
      expect(rows.map((r) => r.remote_error)).toEqual(['upload: 403 bad token ***'])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)
