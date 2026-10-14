// vx packs a symlinked output as its target's bytes, outside the sandbox.
// A sandboxed task denied a file in its own project (`read: ['src/']`
// leaves `.env` out) could still plant `dist/x -> ../.env`: making a link
// reads nothing. Seatbelt and an untraced Linux let it through, and the
// save put `.env` in the cache and the remote. Linux's tracer failed it,
// but only by judging the link by its target, which failed every link to
// a file the task could read too (`ln -s ../src/a.ts dist/a`).
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { storedBytesUnder } from './helpers/stored-artifact.js'
import { PARITY_TIMEOUT as TIMEOUT, summarized } from './helpers/parity.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox output link test')

const config = (read: string, command = 'ln -sf ../.env dist/x') => `
  export default {
    tasks: {
      build: {
        exec: {
          command: ${JSON.stringify(command)},
          sandbox: { allow: { read: [${JSON.stringify(read)}], write: ['dist/'] } },
        },
        cache: { inputs: { files: ['package.json'] }, outputs: { files: ['dist/**'] } },
      },
    },
  }
`

describe.skipIf(!available)('a sandboxed task linking an output to a file it cannot read', () => {
  it(
    'fails the save and stores none of the target; a readable target still caches',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-sandbox-outlink-' })
      try {
        for (const [name, read] of [
          ['denied', 'src/'],
          ['granted', '.'],
        ] as const) {
          await addProject(root, name, {
            config: config(read),
            files: { '.env': `${name.toUpperCase()}-ENV-SECRET\n`, 'src/a.ts': '' },
          })
        }
        const r = await summarized(root, ['denied#build', 'granted#build'])
        expect(r.code).toBe(0)
        expect(r.text).toContain(
          `output dist/x is a symlink to ${path.join(root, 'packages', 'denied', '.env')}, which the task's sandbox does not let it read`,
        )
        expect(r.text).not.toContain(
          'output dist/x is a symlink to ' + path.join(root, 'packages', 'granted'),
        )
        const held = { denied: false, granted: false }
        for (const [, bytes] of storedBytesUnder(root)) {
          const text = new TextDecoder().decode(Bun.zstdDecompressSync(bytes))
          if (text.includes('DENIED-ENV-SECRET')) held.denied = true
          if (text.includes('GRANTED-ENV-SECRET')) held.granted = true
        }
        expect(held).toEqual({ denied: false, granted: true })
        expect(await readFile(path.join(root, 'packages', 'denied', '.env'), 'utf8')).toBe(
          'DENIED-ENV-SECRET\n',
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe.skipIf(!available)('a sandboxed task linking an output to a file it can read', () => {
  it(
    'is no violation, and the link caches as the file',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-sandbox-outlink-ok-' })
      try {
        const dir = await addProject(root, 'app', {
          config: config('src/', 'ln -sf ../src/a.ts dist/a'),
          files: { 'src/a.ts': 'export const a = 1\n' },
        })
        const r = await summarized(root, ['app#build'])
        expect(r.text).not.toContain('violation')
        expect(r.tasks.get('app#build')?.['status']).toBe('success')
        await rm(path.join(dir, 'dist', 'a'))
        const again = await summarized(root, ['app#build'])
        expect(again.tasks.get('app#build')?.['status']).toBe('cache-hit')
        expect(await readFile(path.join(dir, 'dist', 'a'), 'utf8')).toBe('export const a = 1\n')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
