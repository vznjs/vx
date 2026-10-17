// vx packs outputs outside the sandbox. A sandboxed task denied a file in
// its own project (`read: ['src/']` leaves `.env` out) could still plant
// `dist/x -> ../.env`: making a link reads nothing, and packing the link as
// its target's bytes put `.env` in the cache and the remote. A link is now
// kept as the link, so no byte of its target is read, whatever the task
// may read; Linux's tracer must not fail the task for making it.
import { readlink, rm } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { storedBytesUnder } from './helpers/stored-artifact.js'
import { PARITY_TIMEOUT as TIMEOUT, summarized } from './helpers/parity.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox output link test')

const config = (read: string) => `
  export default {
    tasks: {
      build: {
        exec: {
          command: 'ln -sf ../.env dist/x',
          sandbox: { allow: { read: [${JSON.stringify(read)}], write: ['dist/'] } },
        },
        inputs: { files: ['package.json'] }, cache: { outputs: { files: ['dist/**'] } },
      },
    },
  }
`

describe.skipIf(!available)('a sandboxed task linking an output to its .env', () => {
  it(
    'caches the link and stores none of the target, readable or not',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-sandbox-outlink-' })
      try {
        const dirs: string[] = []
        for (const [name, read] of [
          ['denied', 'src/'],
          ['granted', '.'],
        ] as const) {
          dirs.push(
            await addProject(root, name, {
              config: config(read),
              files: { '.env': `${name.toUpperCase()}-ENV-SECRET\n`, 'src/a.ts': '' },
            }),
          )
        }
        const r = await summarized(root, ['denied#build', 'granted#build'])
        expect(r.code).toBe(0)
        expect(r.text).not.toContain('violation')
        expect(r.text).not.toContain('cache save failed')
        for (const [, bytes] of storedBytesUnder(root)) {
          expect(new TextDecoder().decode(Bun.zstdDecompressSync(bytes))).not.toContain(
            'ENV-SECRET',
          )
        }
        for (const dir of dirs) await rm(path.join(dir, 'dist', 'x'))
        const again = await summarized(root, ['denied#build', 'granted#build'])
        expect(again.tasks.get('denied#build')?.['status']).toBe('cache-hit')
        for (const dir of dirs) expect(await readlink(path.join(dir, 'dist', 'x'))).toBe('../.env')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
